/**
 * Facts Resolver
 * Builds a flat fact object from DB for rule evaluation.
 * Every field in the rule condition builder maps to a key here.
 */

const db = require('../../db');
const dayjs = require('dayjs');

async function getUserFacts(userId) {
  // Main user row
  const userRes = await db.query(`
    SELECT u.*,
      (SELECT MAX(ta.closed_at)
       FROM trade_activity ta
       JOIN broker_accounts ba ON ba.id = ta.broker_account_id
       WHERE ba.user_id = u.id
      ) AS last_trade_at_computed,
      (SELECT COALESCE(SUM(fe.amount),0)
       FROM funding_events fe WHERE fe.user_id = u.id AND fe.event_type = 'deposit'
      ) AS total_deposits_computed,
      (SELECT COALESCE(SUM(fe.amount),0)
       FROM funding_events fe WHERE fe.user_id = u.id AND fe.event_type = 'withdrawal'
      ) AS total_withdrawals_computed,
      (SELECT COUNT(*) FROM trade_activity ta JOIN broker_accounts ba ON ba.id = ta.broker_account_id WHERE ba.user_id = u.id) AS total_trades_computed,
      (SELECT COALESCE(SUM(ba.balance),0) FROM broker_accounts ba WHERE ba.user_id = u.id AND ba.account_type != 'wallet') AS total_trading_balance,
      (SELECT COALESCE(SUM(ba.balance),0) FROM broker_accounts ba WHERE ba.user_id = u.id AND ba.account_type = 'wallet') AS wallet_balance,
      (SELECT MAX(fe.happened_at) FROM funding_events fe WHERE fe.user_id = u.id AND fe.event_type = 'deposit') AS last_deposit_at,
      (SELECT MAX(fe.happened_at) FROM funding_events fe WHERE fe.user_id = u.id AND fe.event_type = 'withdrawal') AS last_withdrawal_at,
      (SELECT COUNT(*) FROM reminders r WHERE r.user_id = u.id AND r.sent_at > NOW() - INTERVAL '3 days') AS reminders_last_3d,
      (SELECT COUNT(*) FROM crm_tasks ct WHERE ct.user_id = u.id AND ct.status = 'open') AS open_tasks_count
    FROM users u
    WHERE u.id = $1
  `, [userId]);

  if (!userRes.rows[0]) return null;
  const u = userRes.rows[0];

  const now = dayjs();
  const lastTradeAt = u.last_trade_at_computed ? dayjs(u.last_trade_at_computed) : null;
  const lastDepositAt = u.last_deposit_at ? dayjs(u.last_deposit_at) : null;
  const lastWithdrawalAt = u.last_withdrawal_at ? dayjs(u.last_withdrawal_at) : null;

  return {
    // Identity
    user_id:            u.id,
    telegram_id:        u.telegram_id,
    telegram_username:  u.telegram_username,
    tauro_client_id:    u.tauro_client_id,
    structure_id:       u.structure_id,
    assigned_cm:        u.assigned_cm,

    // Status
    status:             u.status,
    segment:            u.segment,
    risk_score:         u.risk_score || 0,
    is_banned:          u.is_banned,
    ban_type:           u.ban_type,
    vip_member:         u.vip_member,
    in_telegram_group:  u.in_telegram_group,
    watchlist:          u.watchlist,
    tags:               u.tags || [],
    broker_verified:    u.broker_verified,

    // Activity timing
    days_since_last_trade:     lastTradeAt    ? now.diff(lastTradeAt,    'day') : 9999,
    days_since_last_deposit:   lastDepositAt  ? now.diff(lastDepositAt,  'day') : 9999,
    days_since_last_withdrawal:lastWithdrawalAt ? now.diff(lastWithdrawalAt,'day') : 9999,
    days_since_registered:     u.registered_at ? now.diff(dayjs(u.registered_at), 'day') : 0,

    last_trade_at:       u.last_trade_at_computed || null,
    last_deposit_at:     u.last_deposit_at || null,
    last_withdrawal_at:  u.last_withdrawal_at || null,

    // Financial
    total_trading_balance:   parseFloat(u.total_trading_balance  || 0),
    wallet_balance:          parseFloat(u.wallet_balance          || 0),
    total_balance:           parseFloat(u.total_trading_balance   || 0) + parseFloat(u.wallet_balance || 0),
    total_deposits:          parseFloat(u.total_deposits_computed  || 0),
    total_withdrawals:       parseFloat(u.total_withdrawals_computed || 0),
    net_funding:             parseFloat(u.total_deposits_computed || 0) - parseFloat(u.total_withdrawals_computed || 0),
    withdrawal_ratio:        u.total_deposits_computed > 0
                               ? parseFloat(u.total_withdrawals_computed) / parseFloat(u.total_deposits_computed)
                               : 0,

    // Trading stats
    total_trades:       parseInt(u.total_trades_computed || 0),

    // Operational
    open_tasks_count:   parseInt(u.open_tasks_count || 0),
    reminders_last_3d:  parseInt(u.reminders_last_3d || 0),

    // Rule override
    rule_override_no_ban_until: u.rule_override_no_ban_until,
  };
}

module.exports = { getUserFacts };
