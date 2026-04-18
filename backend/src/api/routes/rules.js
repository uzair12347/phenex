/**
 * Rules API Routes
 * GET    /api/rules            – list all rules
 * POST   /api/rules            – create rule
 * GET    /api/rules/:id        – get rule detail
 * PATCH  /api/rules/:id        – update rule
 * DELETE /api/rules/:id        – delete rule
 * POST   /api/rules/:id/toggle – activate/deactivate
 * POST   /api/rules/:id/run    – manual run (all users)
 * POST   /api/rules/dry-run    – test a rule definition
 * GET    /api/rules/:id/executions – execution log
 */

const router = require('express').Router();
const { requireAdmin, requireRole } = require('../middleware/auth');
const db = require('../../db');
const ruleEngine = require('../../engine/rules/engine');
const auditLog = require('../../utils/auditLog');

const CONDITION_FIELDS = [
  'days_since_last_trade','days_since_last_deposit','days_since_last_withdrawal',
  'days_since_registered','total_trading_balance','wallet_balance','total_balance',
  'total_deposits','total_withdrawals','net_funding','withdrawal_ratio',
  'total_trades','risk_score','open_tasks_count','reminders_last_3d',
  'is_banned','vip_member','in_telegram_group','broker_verified','watchlist',
  'status','segment','ban_type',
];

// ─── List ─────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  const { active, trigger_type } = req.query;
  const where = [];
  const params = [];

  if (active !== undefined) {
    params.push(active === 'true');
    where.push(`r.is_active = $${params.length}`);
  }
  if (trigger_type) {
    params.push(trigger_type);
    where.push(`r.trigger_type = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rules = await db.query(`
    SELECT r.*, a.name AS created_by_name
    FROM rules r LEFT JOIN admins a ON a.id = r.created_by
    ${whereClause}
    ORDER BY r.priority ASC, r.created_at DESC
  `, params);

  res.json(rules.rows);
});

// ─── Get available condition fields ───────────────────────────

router.get('/fields', requireAdmin, async (req, res) => {
  res.json({ fields: CONDITION_FIELDS });
});

// ─── Create ───────────────────────────────────────────────────

router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const {
    name, description, trigger_type = 'scheduled', trigger_event,
    cron_expression, target_scope, conditions, conditions_logic = 'AND',
    actions, cooldown_hours = 0, escalation, priority = 50,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name required' });
  if (!conditions?.length) return res.status(400).json({ error: 'at least one condition required' });
  if (!actions?.length) return res.status(400).json({ error: 'at least one action required' });

  try {
    const result = await db.query(`
      INSERT INTO rules (
        name, description, trigger_type, trigger_event, cron_expression,
        target_scope, conditions, conditions_logic, actions,
        cooldown_hours, escalation, priority, created_by, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)
      RETURNING *
    `, [
      name, description, trigger_type, trigger_event, cron_expression,
      JSON.stringify(target_scope || { type: 'all' }),
      JSON.stringify(conditions),
      conditions_logic,
      JSON.stringify(actions),
      cooldown_hours,
      JSON.stringify(escalation || []),
      priority,
      req.admin.id,
    ]);

    await auditLog(req.admin, 'create_rule', 'rule', result.rows[0].id, name);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get one ──────────────────────────────────────────────────

router.get('/:id', requireAdmin, async (req, res) => {
  const rule = await db.query(
    'SELECT r.*, a.name AS created_by_name FROM rules r LEFT JOIN admins a ON a.id=r.created_by WHERE r.id=$1',
    [req.params.id]
  );
  if (!rule.rows[0]) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule.rows[0]);
});

// ─── Update ───────────────────────────────────────────────────

router.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const allowed = [
    'name','description','trigger_type','trigger_event','cron_expression',
    'target_scope','conditions','conditions_logic','actions',
    'cooldown_hours','escalation','priority',
  ];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      updates[k] = typeof req.body[k] === 'object' ? JSON.stringify(req.body[k]) : req.body[k];
    }
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  updates.updated_by = req.admin.id;
  const sets   = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
  const values = [...Object.values(updates), req.params.id];

  await db.query(`UPDATE rules SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${values.length}`, values);
  await auditLog(req.admin, 'update_rule', 'rule', req.params.id, null, updates);
  res.json({ success: true });
});

// ─── Toggle active ────────────────────────────────────────────

router.post('/:id/toggle', requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await db.query(
    'UPDATE rules SET is_active = NOT is_active, updated_at=NOW() WHERE id=$1 RETURNING is_active, name',
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Rule not found' });
  await auditLog(req.admin, result.rows[0].is_active ? 'activate_rule' : 'deactivate_rule',
    'rule', req.params.id, result.rows[0].name);
  res.json({ is_active: result.rows[0].is_active });
});

// ─── Delete ───────────────────────────────────────────────────

router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  const rule = await db.query('SELECT name FROM rules WHERE id=$1', [req.params.id]);
  if (!rule.rows[0]) return res.status(404).json({ error: 'Rule not found' });
  await db.query('DELETE FROM rules WHERE id=$1', [req.params.id]);
  await auditLog(req.admin, 'delete_rule', 'rule', req.params.id, rule.rows[0].name);
  res.json({ success: true });
});

// ─── Manual run ───────────────────────────────────────────────

router.post('/:id/run', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const rule = await db.query('SELECT * FROM rules WHERE id=$1', [req.params.id]);
    if (!rule.rows[0]) return res.status(404).json({ error: 'Rule not found' });

    // Run against all relevant users asynchronously
    setImmediate(async () => {
      const users = await db.query('SELECT id FROM users WHERE is_banned=false');
      for (const u of users.rows) {
        await ruleEngine.evaluateUser(u.id).catch(() => {});
      }
    });

    res.json({ success: true, message: 'Rule run started in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dry run ──────────────────────────────────────────────────

router.post('/dry-run', requireAdmin, async (req, res) => {
  try {
    const result = await ruleEngine.dryRun(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Executions ───────────────────────────────────────────────

router.get('/:id/executions', requireAdmin, async (req, res) => {
  const { limit = 50, page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const execs = await db.query(`
    SELECT re.*, u.first_name, u.last_name, u.email
    FROM rule_executions re
    LEFT JOIN users u ON u.id = re.user_id
    WHERE re.rule_id=$1
    ORDER BY re.triggered_at DESC
    LIMIT $2 OFFSET $3
  `, [req.params.id, parseInt(limit), offset]);
  res.json(execs.rows);
});

module.exports = router;
