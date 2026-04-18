/**
 * TauroMarkets Sync Service
 * Handles periodic data synchronization: full structure pull + per-user delta.
 */

const tauro = require('./adapter');
const db = require('../../db');
const logger = require('../../utils/logger');
const { addTimelineEvent } = require('../../engine/crm/timeline');

class TauroSyncService {

  /**
   * Full structure sync: pull all customers + accounts for a structure.
   * Runs every N minutes (configured in cron job).
   */
  async syncStructure(structureId) {
    const jobId = await this._startSyncJob('tauro_structure', structureId);
    let processed = 0, errors = 0;

    try {
      const data = await tauro.getStructure(structureId);
      if (!data) throw new Error('No data returned from Tauro API');

      // Upsert each customer
      for (const customer of data.customers) {
        try {
          await this.upsertCustomer(customer, structureId);
          processed++;
        } catch (err) {
          errors++;
          logger.warn(`[Sync] Customer ${customer.tauroClientId} failed: ${err.message}`);
        }
      }

      // Update structure-level aggregates in a separate metadata table if needed
      await this._completeSyncJob(jobId, processed, errors);
      logger.info(`[Sync] Structure ${structureId}: ${processed} ok, ${errors} errors`);
      return { processed, errors };

    } catch (err) {
      await this._failSyncJob(jobId, err.message);
      throw err;
    }
  }

  /**
   * Delta sync: update a single user's accounts, balances, and recent trades.
   * Called on-demand or as part of the 5-min rolling poll.
   */
  async syncUser(userId) {
    const userRow = await db.query(
      'SELECT id, email, tauro_client_id FROM users WHERE id = $1',
      [userId]
    );
    if (!userRow.rows[0]) throw new Error('User not found');
    const user = userRow.rows[0];
    if (!user.tauro_client_id || !user.email) {
      logger.debug(`[Sync] User ${userId} has no Tauro link, skipping`);
      return;
    }

    const data = await tauro.getCustomer(user.email, user.tauro_client_id, false);
    if (!data) return;

    await this._upsertAccounts(userId, data.accounts || []);
    await this._upsertTrades(userId, data.trades || []);
    await this._upsertFunding(userId, data.funding || []);

    // Update user last_synced_at
    await db.query(
      'UPDATE users SET last_synced_at = NOW() WHERE id = $1',
      [userId]
    );

    return data;
  }

  // ─── Upsert helpers ───────────────────────────────────────────

  async upsertCustomer(customer, structureId) {
    const { tauroClientId, email, firstName, lastName, registeredAt } = customer;

    const existing = await db.query(
      'SELECT id FROM users WHERE tauro_client_id = $1',
      [tauroClientId]
    );

    if (existing.rows.length > 0) {
      // Update existing user's broker data
      await db.query(`
        UPDATE users SET
          email         = COALESCE(email, $1),
          first_name    = COALESCE(first_name, $2),
          last_name     = COALESCE(last_name, $3),
          structure_id  = $4,
          last_synced_at = NOW(),
          updated_at    = NOW()
        WHERE tauro_client_id = $5
      `, [email, firstName, lastName, structureId, tauroClientId]);
    } else {
      // New customer discovered via sync – create a stub user
      const result = await db.query(`
        INSERT INTO users (
          email, first_name, last_name, tauro_client_id,
          structure_id, status, registered_at, last_synced_at
        ) VALUES ($1,$2,$3,$4,$5,'registered',$6,NOW())
        ON CONFLICT (tauro_client_id) DO UPDATE SET
          last_synced_at = NOW()
        RETURNING id
      `, [email, firstName, lastName, tauroClientId, structureId, registeredAt || new Date()]);

      if (result.rows[0]) {
        await addTimelineEvent(result.rows[0].id, 'discovered_via_sync', {
          title: 'Customer discovered via Tauro sync',
          metadata: { structureId, tauroClientId },
        });
      }
    }
  }

  async _upsertAccounts(userId, accounts) {
    for (const acc of accounts) {
      await db.query(`
        INSERT INTO broker_accounts (
          user_id, broker_local_id, account_number, account_type, platform,
          currency, is_demo, balance, equity, free_margin,
          open_positions, open_lots,
          total_deposits, total_withdrawals, total_trades, total_lots, total_profit,
          last_trade_at, signup_date, last_synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
        ON CONFLICT (broker_local_id) DO UPDATE SET
          account_number    = EXCLUDED.account_number,
          balance           = EXCLUDED.balance,
          equity            = EXCLUDED.equity,
          free_margin       = EXCLUDED.free_margin,
          open_positions    = EXCLUDED.open_positions,
          open_lots         = EXCLUDED.open_lots,
          total_deposits    = EXCLUDED.total_deposits,
          total_withdrawals = EXCLUDED.total_withdrawals,
          total_trades      = EXCLUDED.total_trades,
          total_lots        = EXCLUDED.total_lots,
          total_profit      = EXCLUDED.total_profit,
          last_trade_at     = EXCLUDED.last_trade_at,
          last_synced_at    = NOW(),
          updated_at        = NOW()
      `, [
        userId,
        acc.brokerLocalId, acc.accountNumber, acc.type, acc.platform,
        acc.currency, acc.isDemo,
        acc.balance, acc.equity, acc.freeMargin,
        acc.openPositions, acc.openLots,
        acc.totalDeposits, acc.totalWithdrawals, acc.totalTrades, acc.totalLots, acc.totalProfit,
        acc.lastTradeAt, acc.signupDate,
      ]);
    }
  }

  async _upsertTrades(userId, trades) {
    for (const t of trades) {
      if (!t.tradeId) continue;
      const acct = t.accountId
        ? await db.query('SELECT id FROM broker_accounts WHERE broker_local_id = $1', [t.accountId])
        : { rows: [] };

      await db.query(`
        INSERT INTO trade_activity (
          user_id, broker_account_id, trade_id, symbol, trade_type,
          lots, profit, open_price, close_price, opened_at, closed_at, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (trade_id) DO NOTHING
      `, [
        userId, acct.rows[0]?.id || null,
        t.tradeId, t.symbol, t.tradeType,
        t.lots, t.profit, t.openPrice, t.closePrice,
        t.openedAt, t.closedAt, JSON.stringify(t.raw),
      ]).catch(() => {}); // ignore duplicate trade_ids
    }
  }

  async _upsertFunding(userId, events) {
    for (const f of events) {
      await db.query(`
        INSERT INTO funding_events (user_id, event_type, amount, currency, happened_at, raw_data)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING
      `, [userId, f.eventType, f.amount, f.currency, f.happenedAt, JSON.stringify(f.raw)]
      ).catch(() => {});
    }
  }

  // ─── Sync job tracking ────────────────────────────────────────

  async _startSyncJob(jobType, structureId) {
    const result = await db.query(`
      INSERT INTO sync_jobs (job_type, structure_id, status, started_at)
      VALUES ($1,$2,'running',NOW()) RETURNING id
    `, [jobType, structureId]);
    return result.rows[0].id;
  }

  async _completeSyncJob(id, processed, errors) {
    await db.query(`
      UPDATE sync_jobs SET status='completed', users_processed=$1, errors=$2, completed_at=NOW()
      WHERE id=$3
    `, [processed, errors, id]);
  }

  async _failSyncJob(id, errorMessage) {
    await db.query(`
      UPDATE sync_jobs SET status='failed', error_log=$1, completed_at=NOW()
      WHERE id=$2
    `, [JSON.stringify([{ error: errorMessage }]), id]);
  }
}

module.exports = new TauroSyncService();
