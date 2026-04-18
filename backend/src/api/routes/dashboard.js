/**
 * Dashboard Routes
 * GET /api/dashboard/overview        – KPIs for the active structure
 * GET /api/dashboard/daily?date=     – day-specific numbers
 * GET /api/dashboard/charts          – time-series for charts
 * GET /api/dashboard/alerts          – open alerts
 */

const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../../db');

// ─── Overview KPIs ────────────────────────────────────────────

router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const { structure_id } = req.query;
    const structureFilter = structure_id
      ? `AND u.structure_id = '${structure_id.replace(/'/g, "''")}'`
      : '';

    const [customers, trading, funding, atRisk] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                     AS total_customers,
          COUNT(*) FILTER (WHERE u.vip_member = true)  AS vip_customers,
          COUNT(*) FILTER (WHERE u.is_banned = true)   AS banned_customers,
          COUNT(*) FILTER (WHERE u.registered_at > NOW() - INTERVAL '7 days') AS new_last_7d,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM trade_activity ta
            JOIN broker_accounts ba ON ba.id = ta.broker_account_id
            WHERE ba.user_id = u.id AND ta.closed_at > NOW() - INTERVAL '24 hours'
          )) AS active_last_24h,
          COUNT(*) FILTER (WHERE u.in_telegram_group = true) AS in_telegram_group
        FROM users u WHERE 1=1 ${structureFilter}
      `),
      db.query(`
        SELECT
          COALESCE(SUM(ba.total_lots),0)   AS total_lots,
          COALESCE(SUM(ba.total_trades),0) AS total_trades
        FROM broker_accounts ba
        JOIN users u ON u.id = ba.user_id
        WHERE 1=1 ${structureFilter}
      `),
      db.query(`
        SELECT
          COALESCE(SUM(fe.amount) FILTER (WHERE fe.event_type='deposit'),0)    AS total_deposits,
          COALESCE(SUM(fe.amount) FILTER (WHERE fe.event_type='withdrawal'),0) AS total_withdrawals
        FROM funding_events fe
        JOIN users u ON u.id = fe.user_id
        WHERE 1=1 ${structureFilter}
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE u.status='at_risk')   AS at_risk,
          COUNT(*) FILTER (WHERE u.status='withdrawn') AS withdrawn,
          COUNT(*) FILTER (WHERE u.status='inactive')  AS inactive,
          COUNT(*) FILTER (WHERE u.watchlist=true)     AS on_watchlist,
          (SELECT COUNT(*) FROM crm_cases cc
           JOIN users u2 ON u2.id = cc.user_id WHERE cc.status='open'
           ${structureFilter.replace('AND u.', 'AND u2.')}) AS open_cases,
          (SELECT COUNT(*) FROM alerts al WHERE al.is_resolved=false) AS open_alerts,
          -- VIP mismatch: in_telegram_group but not vip_member, or vip_member but not in_telegram_group
          COUNT(*) FILTER (WHERE u.in_telegram_group = true AND u.vip_member = false) AS vip_mismatch_in_group,
          COUNT(*) FILTER (WHERE u.in_telegram_group = false AND u.vip_member = true) AS vip_mismatch_not_in_group
        FROM users u WHERE 1=1 ${structureFilter}
      `),
    ]);

    res.json({
      customers: customers.rows[0],
      trading:   trading.rows[0],
      funding:   funding.rows[0],
      atRisk:    atRisk.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Daily numbers ────────────────────────────────────────────

router.get('/daily', requireAdmin, async (req, res) => {
  try {
    const { date, structure_id } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const dateStr = targetDate.toISOString().slice(0, 10);
    const structureFilter = structure_id
      ? `AND u.structure_id = '${structure_id.replace(/'/g, "''")}'`
      : '';

    const [trading, funding, newUsers] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(s.lots_day),0)  AS lots,
          COALESCE(SUM(s.trades_day),0) AS trades
        FROM account_snapshots s
        JOIN broker_accounts ba ON ba.id = s.broker_account_id
        JOIN users u ON u.id = ba.user_id
        WHERE s.snapshot_date = $1 ${structureFilter}
      `, [dateStr]),
      db.query(`
        SELECT
          COALESCE(SUM(fe.amount) FILTER (WHERE fe.event_type='deposit'),0)    AS deposits,
          COALESCE(SUM(fe.amount) FILTER (WHERE fe.event_type='withdrawal'),0) AS withdrawals
        FROM funding_events fe
        JOIN users u ON u.id = fe.user_id
        WHERE DATE(fe.happened_at) = $1 ${structureFilter}
      `, [dateStr]),
      db.query(`
        SELECT COUNT(*) AS new_users
        FROM users u
        WHERE DATE(u.registered_at) = $1 ${structureFilter}
      `, [dateStr]),
    ]);

    res.json({
      date:     dateStr,
      lots:     parseFloat(trading.rows[0].lots),
      trades:   parseInt(trading.rows[0].trades),
      deposits: parseFloat(funding.rows[0].deposits),
      withdrawals: parseFloat(funding.rows[0].withdrawals),
      newUsers: parseInt(newUsers.rows[0].new_users),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chart time-series ────────────────────────────────────────

router.get('/charts', requireAdmin, async (req, res) => {
  try {
    const { days = 30, structure_id } = req.query;
    const structureFilter = structure_id
      ? `AND u.structure_id = '${structure_id.replace(/'/g, "''")}'`
      : '';

    const [activeCustomers, bannedOverTime, fundingOverTime, tradingActivity] = await Promise.all([
      // Daily active customers (at least 1 trade that day)
      db.query(`
        SELECT DATE(ta.closed_at) AS day, COUNT(DISTINCT ba.user_id) AS active_users
        FROM trade_activity ta
        JOIN broker_accounts ba ON ba.id = ta.broker_account_id
        JOIN users u ON u.id = ba.user_id
        WHERE ta.closed_at > NOW() - INTERVAL '1 day' * $1 ${structureFilter}
        GROUP BY day ORDER BY day ASC
      `, [parseInt(days)]),
      // Cumulative banned over time
      db.query(`
        SELECT DATE(banned_at) AS day, COUNT(*) AS newly_banned
        FROM users u
        WHERE banned_at IS NOT NULL
          AND banned_at > NOW() - INTERVAL '1 day' * $1 ${structureFilter}
        GROUP BY day ORDER BY day ASC
      `, [parseInt(days)]),
      // Deposits + withdrawals per day
      db.query(`
        SELECT
          DATE(fe.happened_at) AS day,
          SUM(fe.amount) FILTER (WHERE fe.event_type='deposit')    AS deposits,
          SUM(fe.amount) FILTER (WHERE fe.event_type='withdrawal') AS withdrawals
        FROM funding_events fe
        JOIN users u ON u.id = fe.user_id
        WHERE fe.happened_at > NOW() - INTERVAL '1 day' * $1 ${structureFilter}
        GROUP BY day ORDER BY day ASC
      `, [parseInt(days)]),
      // Trading lots per day (heatmap data)
      db.query(`
        SELECT DATE(closed_at) AS day, SUM(lots) AS lots, COUNT(*) AS trades
        FROM trade_activity ta
        JOIN broker_accounts ba ON ba.id = ta.broker_account_id
        JOIN users u ON u.id = ba.user_id
        WHERE ta.closed_at > NOW() - INTERVAL '1 day' * $1 ${structureFilter}
        GROUP BY day ORDER BY day ASC
      `, [parseInt(days)]),
    ]);

    res.json({
      activeCustomers: activeCustomers.rows,
      bannedOverTime:  bannedOverTime.rows,
      fundingOverTime: fundingOverTime.rows,
      tradingActivity: tradingActivity.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Alerts ───────────────────────────────────────────────────

router.get('/alerts', requireAdmin, async (req, res) => {
  const { resolved = 'false', limit = 50 } = req.query;
  const alerts = await db.query(`
    SELECT al.*, u.first_name, u.last_name, u.telegram_username, r.name AS rule_name
    FROM alerts al
    LEFT JOIN users u ON u.id = al.user_id
    LEFT JOIN rules r ON r.id = al.rule_id
    WHERE al.is_resolved = $1
    ORDER BY al.created_at DESC LIMIT $2
  `, [resolved === 'true', parseInt(limit)]);
  res.json(alerts.rows);
});

router.patch('/alerts/:id/resolve', requireAdmin, async (req, res) => {
  await db.query(
    'UPDATE alerts SET is_resolved=true, is_read=true, resolved_by=$1, resolved_at=NOW() WHERE id=$2',
    [req.admin.id, req.params.id]
  );
  res.json({ success: true });
});

module.exports = router;
