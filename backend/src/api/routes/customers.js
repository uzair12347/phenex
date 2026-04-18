/**
 * Customer / User Routes
 * GET    /api/customers              – list with filters
 * GET    /api/customers/:id          – single customer detail
 * GET    /api/customers/:id/accounts – trading accounts
 * GET    /api/customers/:id/timeline – event timeline
 * GET    /api/customers/:id/stats    – aggregated stats
 * POST   /api/customers/:id/ban      – ban a customer
 * POST   /api/customers/:id/unban    – unban a customer
 * PATCH  /api/customers/:id          – update segment/tags/cm
 * POST   /api/customers/:id/sync     – force re-sync from Tauro
 * GET    /api/customers/:id/notes    – CRM notes
 * POST   /api/customers/:id/notes    – add note
 * GET    /api/customers/:id/tasks    – CRM tasks
 * POST   /api/customers/:id/tasks    – create task
 */

const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../../db');
const tauroSync = require('../../services/tauro/sync');
const telegramService = require('../../services/telegram/service');
const ruleEngine = require('../../engine/rules/engine');
const { addTimelineEvent } = require('../../engine/crm/timeline');
const auditLog = require('../../utils/auditLog');

// ─── List customers ───────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const {
      page = 1, limit = 50, search, status, segment,
      vip, banned = 'false', inactive_days, structure_id,
      sort = 'registered_at', order = 'desc',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const where  = [];

    // banned filter
    if (banned === 'true') {
      where.push('u.is_banned = true');
    } else if (banned === 'false') {
      where.push('u.is_banned = false');
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.telegram_username ILIKE $${params.length} OR u.tauro_client_id ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`u.status = $${params.length}`);
    }
    if (segment) {
      params.push(segment);
      where.push(`u.segment = $${params.length}`);
    }
    if (vip !== undefined) {
      params.push(vip === 'true');
      where.push(`u.vip_member = $${params.length}`);
    }
    if (structure_id) {
      params.push(structure_id);
      where.push(`u.structure_id = $${params.length}`);
    }
    if (inactive_days) {
      params.push(parseInt(inactive_days));
      where.push(`(
        SELECT MAX(ta.closed_at) FROM trade_activity ta
        JOIN broker_accounts ba ON ba.id = ta.broker_account_id
        WHERE ba.user_id = u.id
      ) < NOW() - INTERVAL '1 day' * $${params.length}
      OR NOT EXISTS (
        SELECT 1 FROM trade_activity ta
        JOIN broker_accounts ba ON ba.id = ta.broker_account_id WHERE ba.user_id = u.id
      )`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const allowedSorts = ['registered_at','first_name','last_name','email','status'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'registered_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    params.push(parseInt(limit), offset);
    const limitParam  = params.length - 1;
    const offsetParam = params.length;

    const [countRes, rowRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM users u ${whereClause}`, params.slice(0, -2)),
      db.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.email,
          u.telegram_username, u.telegram_id,
          u.tauro_client_id, u.status, u.segment,
          u.vip_member, u.is_banned, u.ban_type, u.ban_reason, u.banned_at,
          u.in_telegram_group, u.watchlist, u.tags, u.risk_score,
          u.registered_at, u.last_synced_at, u.structure_id,
          COALESCE(SUM(ba.balance) FILTER (WHERE ba.account_type != 'wallet'), 0) AS trading_balance,
          COALESCE(SUM(ba.balance) FILTER (WHERE ba.account_type = 'wallet'), 0) AS wallet_balance,
          (SELECT MAX(ta.closed_at)
           FROM trade_activity ta JOIN broker_accounts ba2 ON ba2.id = ta.broker_account_id
           WHERE ba2.user_id = u.id) AS last_trade_at,
          NOW() - (SELECT MAX(ta.closed_at)
           FROM trade_activity ta JOIN broker_accounts ba2 ON ba2.id = ta.broker_account_id
           WHERE ba2.user_id = u.id) AS inactive_since
        FROM users u
        LEFT JOIN broker_accounts ba ON ba.user_id = u.id
        ${whereClause}
        GROUP BY u.id
        ORDER BY u.${sortCol} ${sortDir}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `, params),
    ]);

    res.json({
      total:    parseInt(countRes.rows[0].count),
      page:     parseInt(page),
      limit:    parseInt(limit),
      customers: rowRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Single customer ──────────────────────────────────────────

router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.*,
        a.name AS assigned_cm_name,
        (SELECT COUNT(*) FROM crm_tasks ct WHERE ct.user_id = u.id AND ct.status = 'open') AS open_tasks,
        (SELECT COUNT(*) FROM crm_cases cc WHERE cc.user_id = u.id AND cc.status = 'open') AS open_cases,
        (SELECT COUNT(*) FROM reminders r WHERE r.user_id = u.id) AS total_reminders
      FROM users u
      LEFT JOIN admins a ON a.id = u.assigned_cm
      WHERE u.id = $1
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Customer accounts ────────────────────────────────────────

router.get('/:id/accounts', requireAdmin, async (req, res) => {
  try {
    const accounts = await db.query(`
      SELECT ba.*,
        (SELECT COUNT(*) FROM trade_activity ta WHERE ta.broker_account_id = ba.id) AS trade_count
      FROM broker_accounts ba
      WHERE ba.user_id = $1
      ORDER BY ba.account_type, ba.balance DESC
    `, [req.params.id]);
    res.json(accounts.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Customer stats ───────────────────────────────────────────

router.get('/:id/stats', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const [summary, dailyLots, dailyTrades, snapshots] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(ba.total_deposits),0)    AS total_deposits,
          COALESCE(SUM(ba.total_withdrawals),0) AS total_withdrawals,
          COALESCE(SUM(ba.total_trades),0)      AS total_trades,
          COALESCE(SUM(ba.total_lots),0)        AS total_lots,
          COALESCE(SUM(ba.total_profit),0)      AS total_profit,
          COALESCE(SUM(ba.balance),0)           AS total_balance,
          MAX(ba.last_trade_at)                 AS last_trade_at,
          COUNT(ba.id)                          AS account_count
        FROM broker_accounts ba WHERE ba.user_id = $1
      `, [userId]),
      db.query(`
        SELECT DATE(closed_at) AS day, SUM(lots) AS lots
        FROM trade_activity WHERE user_id=$1 AND closed_at IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT 90
      `, [userId]),
      db.query(`
        SELECT DATE(closed_at) AS day, COUNT(*) AS trades
        FROM trade_activity WHERE user_id=$1 AND closed_at IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT 90
      `, [userId]),
      db.query(`
        SELECT snapshot_date, SUM(balance) AS balance, SUM(deposits_day) AS deposits,
          SUM(withdrawals_day) AS withdrawals, SUM(profit_day) AS profit
        FROM account_snapshots s
        JOIN broker_accounts ba ON ba.id = s.broker_account_id
        WHERE ba.user_id=$1
        GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 90
      `, [userId]),
    ]);

    res.json({
      summary:      summary.rows[0],
      dailyLots:    dailyLots.rows,
      dailyTrades:  dailyTrades.rows,
      snapshots:    snapshots.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Timeline ─────────────────────────────────────────────────

router.get('/:id/timeline', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const events = await db.query(`
      SELECT ct.*, a.name AS actor_name
      FROM customer_timeline ct
      LEFT JOIN admins a ON a.id = ct.actor_id
      WHERE ct.user_id = $1
      ORDER BY ct.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.id, parseInt(limit), offset]);
    res.json(events.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Ban ──────────────────────────────────────────────────────

router.post('/:id/ban', requireAdmin, async (req, res) => {
  const { ban_type = 'hard', reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason is required' });

  try {
    const userRes = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned) return res.status(400).json({ error: 'User already banned' });

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE users SET
          is_banned=true, ban_type=$1, ban_reason=$2, banned_at=NOW(), banned_by=$3,
          status='banned', vip_member=false, vip_revoked_at=NOW(), updated_at=NOW()
        WHERE id=$4
      `, [ban_type, reason, req.admin.id, req.params.id]);

      await client.query(`
        INSERT INTO ban_records (user_id, ban_type, reason, triggered_by)
        VALUES ($1,$2,$3,$4)
      `, [req.params.id, ban_type, reason, `admin:${req.admin.id}`]);

      await client.query(`
        UPDATE vip_memberships SET is_active=false, revoked_at=NOW(), revoked_by=$1, revoke_reason=$2
        WHERE user_id=$3 AND is_active=true
      `, [req.admin.id, reason, req.params.id]);
    });

    // Telegram: notify + remove from group
    if (ban_type === 'hard' && user.telegram_id) {
      await telegramService.sendBanNotification(req.params.id).catch(() => {});
    }

    await addTimelineEvent(req.params.id, 'banned', {
      title: `Banned (${ban_type}) by admin`,
      metadata: { ban_type, reason, adminId: req.admin.id },
      actorId: req.admin.id, actorType: 'admin',
    });

    await auditLog(req.admin, 'ban_user', 'user', req.params.id,
      `${user.first_name} ${user.last_name}`, { ban_type, reason });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Unban ────────────────────────────────────────────────────

router.post('/:id/unban', requireAdmin, async (req, res) => {
  const { reason = 'Manual unban by admin' } = req.body;

  try {
    const userRes = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.is_banned) return res.status(400).json({ error: 'User is not banned' });

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE users SET
          is_banned=false, ban_type=NULL, ban_reason=NULL,
          banned_at=NULL, banned_by=NULL,
          status='reactivated', updated_at=NOW()
        WHERE id=$1
      `, [req.params.id]);

      await client.query(`
        UPDATE ban_records SET is_active=false, unbanned_at=NOW(), unbanned_by=$1, unban_reason=$2
        WHERE user_id=$3 AND is_active=true
      `, [req.admin.id, reason, req.params.id]);
    });

    if (user.telegram_id) {
      await telegramService.unbanFromGroup(user.telegram_id).catch(() => {});
    }

    await addTimelineEvent(req.params.id, 'unbanned', {
      title: 'Unbanned by admin',
      metadata: { reason, adminId: req.admin.id },
      actorId: req.admin.id, actorType: 'admin',
    });

    await auditLog(req.admin, 'unban_user', 'user', req.params.id,
      `${user.first_name} ${user.last_name}`, { reason });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update customer metadata ─────────────────────────────────

router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['segment', 'assigned_cm', 'watchlist', 'tags',
                   'rule_override_no_ban_until', 'rule_override_reason'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  if (updates.rule_override_no_ban_until) {
    updates.rule_override_set_by = req.admin.id;
  }

  try {
    const sets   = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    const values = Object.values(updates);
    values.push(req.params.id);
    await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${values.length}`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Force sync ───────────────────────────────────────────────

router.post('/:id/sync', requireAdmin, async (req, res) => {
  try {
    await tauroSync.syncUser(req.params.id);
    await ruleEngine.evaluateUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Notes ────────────────────────────────────────────────────

router.get('/:id/notes', requireAdmin, async (req, res) => {
  const notes = await db.query(`
    SELECT n.*, a.name AS author_name FROM crm_notes n
    LEFT JOIN admins a ON a.id = n.author_id
    WHERE n.user_id=$1 ORDER BY n.created_at DESC
  `, [req.params.id]);
  res.json(notes.rows);
});

router.post('/:id/notes', requireAdmin, async (req, res) => {
  const { content, category = 'general' } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const result = await db.query(`
    INSERT INTO crm_notes (user_id, author_id, category, content)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.params.id, req.admin.id, category, content]);
  res.status(201).json(result.rows[0]);
});

// ─── Tasks ────────────────────────────────────────────────────

router.get('/:id/tasks', requireAdmin, async (req, res) => {
  const tasks = await db.query(`
    SELECT t.*, a.name AS assigned_to_name FROM crm_tasks t
    LEFT JOIN admins a ON a.id = t.assigned_to
    WHERE t.user_id=$1 ORDER BY t.created_at DESC
  `, [req.params.id]);
  res.json(tasks.rows);
});

router.post('/:id/tasks', requireAdmin, async (req, res) => {
  const { task_type, title, description, assigned_to, due_at } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const result = await db.query(`
    INSERT INTO crm_tasks (user_id, created_by, assigned_to, task_type, title, description, due_at, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING *
  `, [req.params.id, req.admin.id, assigned_to || req.admin.id, task_type, title, description, due_at]);
  res.status(201).json(result.rows[0]);
});

router.patch('/:id/tasks/:taskId', requireAdmin, async (req, res) => {
  const { status, completed_at } = req.body;
  await db.query(
    'UPDATE crm_tasks SET status=$1, completed_at=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4',
    [status, completed_at || (status === 'done' ? new Date() : null), req.params.taskId, req.params.id]
  );
  res.json({ success: true });
});

module.exports = router;
