/**
 * Auth Routes – Admin login / session
 */

const authRouter = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { signAdminToken, requireAdmin } = require('../middleware/auth');
const express = require('express');
const router = express.Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const result = await db.query('SELECT * FROM admins WHERE email=$1 AND is_active=true', [email.toLowerCase()]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await db.query('UPDATE admins SET last_login_at=NOW() WHERE id=$1', [admin.id]);
    const token = signAdminToken(admin);
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

authRouter.get('/me', requireAdmin, (req, res) => {
  res.json(req.admin);
});

authRouter.post('/admins', requireAdmin, async (req, res) => {
  if (req.admin.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  const { name, email, password, role = 'admin' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });

  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await db.query(
      'INSERT INTO admins (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role',
      [name, email.toLowerCase(), hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mini App / Onboarding Routes
 * POST /api/miniapp/init          – Telegram WebApp init (validate initData)
 * POST /api/miniapp/profile       – submit profile + trigger verification email
 * GET  /api/miniapp/status        – check user's VIP/verification status
 * GET  /api/miniapp/verify        – JWT callback from Tauro email link
 * POST /api/miniapp/vip/join      – request VIP join link
 */
const miniAppRouter = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const tauro = require('../../services/tauro/adapter');
const tauroSync = require('../../services/tauro/sync');
const telegramService = require('../../services/telegram/service');
const { signUserToken, requireUser } = require('../middleware/auth');
const { addTimelineEvent } = require('../../engine/crm/timeline');

// Validate Telegram initData
function validateTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  return expectedHash === hash;
}

// Init: validate Telegram WebApp and return session token
miniAppRouter.post('/init', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'initData required' });

    const isValid = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Invalid Telegram initData' });
    }

    const params = new URLSearchParams(initData);
    const telegramUser = JSON.parse(params.get('user') || '{}');
    const telegramId   = telegramUser.id;

    if (!telegramId) return res.status(400).json({ error: 'No Telegram user in initData' });

    // Upsert user
    const result = await db.query(`
      INSERT INTO users (telegram_id, telegram_username, telegram_first_name, telegram_last_name, status)
      VALUES ($1,$2,$3,$4,'registered')
      ON CONFLICT (telegram_id) DO UPDATE SET
        telegram_username    = EXCLUDED.telegram_username,
        telegram_first_name  = EXCLUDED.telegram_first_name,
        telegram_last_name   = EXCLUDED.telegram_last_name,
        updated_at           = NOW()
      RETURNING *
    `, [telegramId, telegramUser.username, telegramUser.first_name, telegramUser.last_name]);

    const user  = result.rows[0];
    const token = signUserToken(user);
    res.json({ token, user: { id: user.id, status: user.status, vip_member: user.vip_member, is_banned: user.is_banned } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit profile: email + tauro ID → trigger verification email
miniAppRouter.post('/profile', requireUser, async (req, res) => {
  const { email, tauro_client_id, first_name, last_name } = req.body;
  if (!email || !tauro_client_id) return res.status(400).json({ error: 'email and tauro_client_id required' });

  try {
    // Trigger Tauro verification email (sendEmail=true)
    const data = await tauro.triggerVerificationEmail(email, tauro_client_id);
    if (!data) return res.status(404).json({ error: 'Account not found at TauroMarkets' });

    await db.query(`
      UPDATE users SET
        email=$1, tauro_client_id=$2, first_name=COALESCE($3, first_name),
        last_name=COALESCE($4, last_name), status='verification_pending', updated_at=NOW()
      WHERE id=$5
    `, [email, tauro_client_id, first_name, last_name, req.user.id]);

    await addTimelineEvent(req.user.id, 'verification_email_sent', {
      title: 'Verification email sent',
      metadata: { email, tauro_client_id },
    });

    res.json({ success: true, message: 'Verification email sent. Please check your inbox.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JWT callback: Tauro redirects user here after email click
miniAppRouter.get('/verify', async (req, res) => {
  const { jwt: token } = req.query;
  if (!token) return res.status(400).json({ error: 'jwt token required' });

  const result = tauro.verifyJwtToken(token);
  if (!result.valid) return res.status(400).json({ error: 'Invalid or expired token' });

  const { email, sub: tauroClientId } = result.payload;

  try {
    // Find user by email or tauro_client_id
    const userRes = await db.query(
      'SELECT * FROM users WHERE email=$1 OR tauro_client_id=$2 LIMIT 1',
      [email, tauroClientId || email]
    );
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // Mark as verified
    await db.query(`
      UPDATE users SET broker_verified=true, broker_verified_at=NOW(),
        status='broker_verified', updated_at=NOW()
      WHERE id=$1
    `, [user.id]);

    // Full sync from Tauro
    await tauroSync.syncUser(user.id).catch(() => {});

    await addTimelineEvent(user.id, 'broker_verified', {
      title: 'Broker account verified via JWT email',
      metadata: { email, tauroClientId },
    });

    // Redirect back to Mini App with success flag
    const miniAppUrl = process.env.MINI_APP_URL || 'https://t.me/Phenex_VIP_bot';
    res.redirect(`${miniAppUrl}?verified=1`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status check: used by Mini App to show current state
miniAppRouter.get('/status', requireUser, async (req, res) => {
  const user = req.user;
  let inviteLink = null;

  // Check for VIP qualification
  const qualified = user.broker_verified && !user.is_banned &&
    (await db.query(`
      SELECT 1 FROM broker_accounts WHERE user_id=$1 AND balance >= 100 LIMIT 1
    `, [user.id])).rows.length > 0;

  if (qualified && user.vip_member && !user.in_telegram_group) {
    inviteLink = await telegramService.createGroupInviteLink().catch(() => null);
  }

  res.json({
    status:         user.status,
    broker_verified:user.broker_verified,
    vip_member:     user.vip_member,
    is_banned:      user.is_banned,
    ban_reason:     user.is_banned ? user.ban_reason : null,
    in_group:       user.in_telegram_group,
    qualified,
    invite_link:    inviteLink,
  });
});

// VIP Join request
miniAppRouter.post('/vip/join', requireUser, async (req, res) => {
  const user = req.user;
  if (user.is_banned) {
    return res.status(403).json({
      error: 'banned',
      message: 'Du wurdest aufgrund von Inaktivität oder einem anderen Vergehen gebannt. Keine Panik. Das kann ein Fehler sein. Bitte kontaktiere unseren Support!',
    });
  }
  if (!user.broker_verified) {
    return res.status(403).json({ error: 'not_verified', message: 'Bitte verifiziere zuerst deinen Broker-Account.' });
  }

  const hasBalance = await db.query(
    'SELECT 1 FROM broker_accounts WHERE user_id=$1 AND balance >= 100 LIMIT 1',
    [user.id]
  );
  if (!hasBalance.rows.length) {
    return res.status(403).json({ error: 'insufficient_balance', message: 'Mindestguthaben von 100 USD erforderlich.' });
  }

  const inviteLink = await telegramService.createGroupInviteLink();
  if (!inviteLink) return res.status(500).json({ error: 'Could not create invite link' });

  // Grant VIP
  await db.transaction(async (client) => {
    await client.query(`
      UPDATE users SET vip_member=true, vip_granted_at=NOW(), status='vip_active', updated_at=NOW()
      WHERE id=$1
    `, [user.id]);
    await client.query(
      'INSERT INTO vip_memberships (user_id) VALUES ($1)', [user.id]
    );
  });

  await addTimelineEvent(user.id, 'vip_granted', { title: 'VIP access granted', actorType: 'system' });

  res.json({ invite_link: inviteLink });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logs Routes
 */
const logsRouter = require('express').Router();

logsRouter.get('/', requireAdmin, async (req, res) => {
  const { log_type, actor_id, target_type, limit = 100, page = 1, from, to } = req.query;
  const where = [];
  const params = [];

  if (log_type) { params.push(log_type); where.push(`l.log_type = $${params.length}`); }
  if (actor_id) { params.push(actor_id); where.push(`l.actor_id = $${params.length}`); }
  if (target_type) { params.push(target_type); where.push(`l.target_type = $${params.length}`); }
  if (from) { params.push(from); where.push(`l.created_at >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`l.created_at <= $${params.length}`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.push(parseInt(limit), offset);

  const [total, rows] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM audit_logs l ${whereClause}`, params.slice(0,-2)),
    db.query(`
      SELECT l.* FROM audit_logs l ${whereClause}
      ORDER BY l.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}
    `, params),
  ]);

  res.json({ total: parseInt(total.rows[0].count), page: parseInt(page), logs: rows.rows });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Integrations Routes
 * GET    /api/integrations           – list integrations
 * POST   /api/integrations           – create/register integration
 * PATCH  /api/integrations/:id       – update config
 * POST   /api/integrations/:id/test  – test connection
 * POST   /api/integrations/webhooks/inbound – receive external webhook
 * POST   /api/integrations/sync/:type       – trigger manual sync
 */
const intRouter = require('express').Router();
const kommoAdapter = require('../../services/integrations/kommo');
const { googleSheets, notion } = require('../../services/integrations/sheets-notion');
const webhookService = require('../../services/integrations/webhook');
const { requireRole } = require('../middleware/auth');

intRouter.get('/', requireAdmin, async (req, res) => {
  const result = await db.query(`
    SELECT id, name, type, is_active, webhook_url, last_sync_at, last_error,
      (SELECT COUNT(*) FROM integration_mappings im WHERE im.integration_id=integrations.id) AS mapped_users
    FROM integrations ORDER BY type
  `);
  res.json(result.rows);
});

intRouter.post('/', requireRole('admin','superadmin'), async (req, res) => {
  const { name, type, config = {}, webhook_url, webhook_secret } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const result = await db.query(`
    INSERT INTO integrations (name, type, config, webhook_url, webhook_secret)
    VALUES ($1,$2,$3,$4,$5) RETURNING id, name, type, is_active
  `, [name, type, JSON.stringify(config), webhook_url, webhook_secret]);
  res.status(201).json(result.rows[0]);
});

intRouter.patch('/:id', requireRole('admin','superadmin'), async (req, res) => {
  const { config, webhook_url, is_active } = req.body;
  const updates = [];
  const params = [];
  if (config !== undefined)      { params.push(JSON.stringify(config)); updates.push(`config=$${params.length}`); }
  if (webhook_url !== undefined)  { params.push(webhook_url); updates.push(`webhook_url=$${params.length}`); }
  if (is_active !== undefined)    { params.push(is_active); updates.push(`is_active=$${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  await db.query(`UPDATE integrations SET ${updates.join(',')} WHERE id=$${params.length}`, params);
  res.json({ success: true });
});

// Trigger manual export/sync
intRouter.post('/sync/:type', requireRole('admin','superadmin'), async (req, res) => {
  try {
    let result;
    switch (req.params.type) {
      case 'sheets':
        result = await googleSheets.exportCustomers();
        break;
      case 'tauro':
        const { structure_id } = req.body;
        const tauroSync = require('../../services/tauro/sync');
        result = await tauroSync.syncStructure(structure_id || process.env.TAURO_DEFAULT_STRUCTURE_ID);
        break;
      default:
        return res.status(400).json({ error: 'Unknown sync type' });
    }
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inbound webhook receiver (from external systems)
intRouter.post('/webhooks/inbound', async (req, res) => {
  const sig    = req.headers['x-phenex-signature'];
  const secret = process.env.WEBHOOK_SIGNING_SECRET;

  if (secret && sig) {
    const valid = webhookService.verifySignature(req.body, sig, secret);
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });
  }

  // Log and queue the event
  await db.query(`
    INSERT INTO audit_logs (log_type, action, actor_id, target_type, description, metadata)
    VALUES ('integration','inbound_webhook','external','webhook',$1,$2)
  `, ['Inbound webhook received', JSON.stringify({ body: req.body, headers: req.headers })]);

  // Fire event-based rules if applicable
  if (req.body.event && req.body.user_id) {
    const ruleEngine = require('../../engine/rules/engine');
    await ruleEngine.fireEvent(req.body.event, req.body.user_id).catch(() => {});
  }

  res.json({ received: true });
});

module.exports = { authRouter, miniAppRouter, logsRouter, intRouter };
