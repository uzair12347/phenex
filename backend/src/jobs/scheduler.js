/**
 * Background Jobs
 * - Tauro structure sync  : every 5 minutes
 * - Rule engine evaluation: every 15 minutes
 * - Daily snapshots       : 00:05 every day
 * - Kommo bulk push       : every 30 minutes
 */

const cron = require('node-cron');
const logger = require('../utils/logger');
const tauroSync = require('../services/tauro/sync');
const ruleEngine = require('../engine/rules/engine');
const db = require('../db');

function startJobs() {
  const SYNC_INTERVAL = parseInt(process.env.TAURO_SYNC_INTERVAL || '5');
  const ROOT_ID       = process.env.TAURO_ROOT_STRUCTURE_ID;
  const DEFAULT_ID    = process.env.TAURO_DEFAULT_STRUCTURE_ID;

  // ── Tauro sync every N minutes ───────────────────────────────
  cron.schedule(`*/${SYNC_INTERVAL} * * * *`, async () => {
    logger.info('[Jobs] Starting Tauro structure sync...');
    try {
      // Sync the operator's structure (Ramon's downline)
      if (DEFAULT_ID) await tauroSync.syncStructure(DEFAULT_ID);
      // Optionally also root (Vitus) — only if configured
      if (ROOT_ID && ROOT_ID !== DEFAULT_ID) {
        await tauroSync.syncStructure(ROOT_ID);
      }
    } catch (err) {
      logger.error(`[Jobs] Tauro sync error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  // ── Rule engine every 15 minutes ─────────────────────────────
  cron.schedule('*/15 * * * *', async () => {
    logger.info('[Jobs] Running rule engine...');
    try {
      await ruleEngine.runScheduledRules();
    } catch (err) {
      logger.error(`[Jobs] Rule engine error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  // ── Daily snapshots at 00:05 ─────────────────────────────────
  cron.schedule('5 0 * * *', async () => {
    logger.info('[Jobs] Creating daily account snapshots...');
    try {
      await createDailySnapshots();
    } catch (err) {
      logger.error(`[Jobs] Snapshot error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  // ── Sync Telegram group membership every hour ─────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      await syncTelegramMembership();
    } catch (err) {
      logger.error(`[Jobs] TG membership check error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  // ── External sources sync every 30 minutes ───────────────────
  cron.schedule('*/30 * * * *', async () => {
    logger.info('[Jobs] Running external source sync...');
    try {
      const extSyncService = require('../engine/sync/service');
      await extSyncService.syncAll();
    } catch (err) {
      logger.error(`[Jobs] External sync error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  // ── Process backsync queue every 5 minutes ────────────────────
  cron.schedule('*/5 * * * *', async () => {
    try {
      const extSyncService = require('../engine/sync/service');
      await extSyncService.processPendingBacksyncs();
    } catch (err) {
      logger.error(`[Jobs] Backsync error: ${err.message}`);
    }
  }, { timezone: 'Europe/Berlin' });

  logger.info('[Jobs] All cron jobs registered.');
}

/**
 * Snapshot today's balance/trading data for all accounts.
 * Enables day-over-day charts.
 */
async function createDailySnapshots() {
  const today = new Date().toISOString().slice(0, 10);
  const accounts = await db.query(
    'SELECT id, balance, equity, total_deposits, total_withdrawals, total_trades, total_lots, total_profit FROM broker_accounts'
  );

  for (const acc of accounts.rows) {
    await db.query(`
      INSERT INTO account_snapshots
        (broker_account_id, snapshot_date, balance, equity,
         deposits_day, withdrawals_day, trades_day, lots_day, profit_day)
      VALUES ($1,$2,$3,$4,0,0,0,0,$5)
      ON CONFLICT (broker_account_id, snapshot_date) DO NOTHING
    `, [acc.id, today, acc.balance, acc.equity, acc.total_profit]);
  }

  // Update deposits_day / withdrawals_day from today's funding_events
  await db.query(`
    UPDATE account_snapshots s
    SET deposits_day = (
      SELECT COALESCE(SUM(fe.amount),0) FROM funding_events fe
      JOIN broker_accounts ba ON ba.user_id = fe.user_id
      WHERE ba.id = s.broker_account_id AND DATE(fe.happened_at) = $1 AND fe.event_type='deposit'
    ),
    withdrawals_day = (
      SELECT COALESCE(SUM(fe.amount),0) FROM funding_events fe
      JOIN broker_accounts ba ON ba.user_id = fe.user_id
      WHERE ba.id = s.broker_account_id AND DATE(fe.happened_at) = $1 AND fe.event_type='withdrawal'
    ),
    trades_day = (
      SELECT COUNT(*) FROM trade_activity ta WHERE ta.broker_account_id = s.broker_account_id
        AND DATE(ta.closed_at) = $1
    ),
    lots_day = (
      SELECT COALESCE(SUM(ta.lots),0) FROM trade_activity ta WHERE ta.broker_account_id = s.broker_account_id
        AND DATE(ta.closed_at) = $1
    )
    WHERE s.snapshot_date = $1
  `, [today]);

  logger.info(`[Jobs] Daily snapshots created for ${accounts.rows.length} accounts.`);
}

/**
 * Check group membership status for all VIP users.
 * Detects mismatches between DB and actual Telegram group.
 */
async function syncTelegramMembership() {
  const telegramService = require('../services/telegram/service');
  const vipUsers = await db.query(
    'SELECT id, telegram_id FROM users WHERE vip_member=true AND telegram_id IS NOT NULL LIMIT 500'
  );

  for (const user of vipUsers.rows) {
    const inGroup = await telegramService.checkMembership(user.telegram_id).catch(() => null);
    if (inGroup !== null) {
      await db.query(
        'UPDATE users SET in_telegram_group=$1, updated_at=NOW() WHERE id=$2',
        [inGroup, user.id]
      );
    }
  }
}

module.exports = { startJobs };
