/**
 * Data Sources Routes
 * GET    /api/sources                 – list all data sources
 * POST   /api/sources                 – create source
 * GET    /api/sources/:id             – get source
 * PATCH  /api/sources/:id             – update source config
 * POST   /api/sources/:id/sync        – trigger sync
 * POST   /api/sources/:id/preview     – preview without committing
 * GET    /api/sources/:id/records     – view imported source records
 * GET    /api/sources/:id/mappings    – field mappings
 * POST   /api/sources/:id/mappings    – save field mappings
 */

const sourcesRouter = require('express').Router();
const { requireAdmin, requireRole } = require('../middleware/auth');
const db = require('../../db');
const extSyncService = require('../../engine/sync/service');
const auditLog = require('../../utils/auditLog');
const toast = require('../../utils/logger');

sourcesRouter.get('/', requireAdmin, async (req, res) => {
  const result = await db.query(`
    SELECT ds.*,
      (SELECT COUNT(*) FROM source_records sr WHERE sr.data_source_id=ds.id) AS total_records,
      (SELECT COUNT(*) FROM source_records sr WHERE sr.data_source_id=ds.id AND sr.match_status='matched') AS matched_records,
      (SELECT COUNT(*) FROM source_records sr WHERE sr.data_source_id=ds.id AND sr.match_status='pending_review') AS pending_review
    FROM data_sources ds ORDER BY ds.priority ASC, ds.name
  `);
  res.json(result.rows);
});

sourcesRouter.post('/', requireRole('admin','superadmin'), async (req, res) => {
  const { name, type, priority=50, direction='import_only', sync_interval_min=60, config={} } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  // Never store passwords in plain config in real prod – encrypt them
  const result = await db.query(`
    INSERT INTO data_sources (name, type, priority, direction, sync_interval_min, config, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [name, type, priority, direction, sync_interval_min, JSON.stringify(config), req.admin.id]);
  res.status(201).json(result.rows[0]);
});

sourcesRouter.get('/:id', requireAdmin, async (req, res) => {
  const r = await db.query('SELECT * FROM data_sources WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  // Mask sensitive config fields
  const src = { ...r.rows[0] };
  if (src.config?.password)     src.config.password = '***';
  if (src.config?.access_token) src.config.access_token = '***';
  res.json(src);
});

sourcesRouter.patch('/:id', requireRole('admin','superadmin'), async (req, res) => {
  const allowed = ['name','priority','direction','sync_interval_min','is_active','config'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined)
      updates[k] = k === 'config' ? JSON.stringify(req.body[k]) : req.body[k];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(updates).map((k,i) => `${k}=$${i+1}`);
  const vals = [...Object.values(updates), req.params.id];
  await db.query(`UPDATE data_sources SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
  res.json({ success: true });
});

sourcesRouter.post('/:id/sync', requireAdmin, async (req, res) => {
  try {
    setImmediate(() => extSyncService.syncSource(req.params.id).catch(console.error));
    res.json({ success: true, message: 'Sync started in background' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

sourcesRouter.post('/:id/preview', requireAdmin, async (req, res) => {
  try {
    const preview = await extSyncService.previewSync(req.params.id);
    res.json(preview);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

sourcesRouter.get('/:id/records', requireAdmin, async (req, res) => {
  const { page=1, limit=50, match_status } = req.query;
  const offset = (parseInt(page)-1) * parseInt(limit);
  const where = ['sr.data_source_id=$1'];
  const vals  = [req.params.id];
  if (match_status) { vals.push(match_status); where.push(`sr.match_status=$${vals.length}`); }

  const [total, rows] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM source_records sr WHERE ${where.join(' AND ')}`, vals),
    db.query(`
      SELECT sr.*, u.first_name, u.last_name, u.email FROM source_records sr
      LEFT JOIN users u ON u.id=sr.matched_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY sr.imported_at DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}
    `, [...vals, parseInt(limit), offset]),
  ]);
  res.json({ total: parseInt(total.rows[0].count), records: rows.rows });
});

sourcesRouter.get('/:id/mappings', requireAdmin, async (req, res) => {
  const result = await db.query(
    'SELECT * FROM source_field_mappings WHERE data_source_id=$1 ORDER BY external_field',
    [req.params.id]
  );
  res.json(result.rows);
});

sourcesRouter.put('/:id/mappings', requireRole('admin','superadmin'), async (req, res) => {
  const { mappings } = req.body; // array of field mapping objects
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });

  await db.transaction(async (client) => {
    await client.query('DELETE FROM source_field_mappings WHERE data_source_id=$1', [req.params.id]);
    for (const m of mappings) {
      await client.query(`
        INSERT INTO source_field_mappings
          (data_source_id, external_field, internal_field, data_type, is_required,
           is_matching_field, is_backsync_field, is_readonly, transform, priority_override)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [req.params.id, m.external_field, m.internal_field, m.data_type||'string',
          m.is_required||false, m.is_matching_field||false, m.is_backsync_field||false,
          m.is_readonly||false, m.transform||null, m.priority_override||null]);
    }
  });
  res.json({ success: true, count: mappings.length });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matching Queue Routes
 * GET    /api/matching-queue          – pending reviews
 * POST   /api/matching-queue/:id/resolve – link / new_user / ignore
 */

const matchingRouter = require('express').Router();
const matcher = require('../../engine/sync/matcher');

matchingRouter.get('/', requireAdmin, async (req, res) => {
  const { page=1, limit=50 } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);

  const [total, rows] = await Promise.all([
    db.query('SELECT COUNT(*) FROM matching_queue WHERE reviewed_at IS NULL'),
    db.query(`
      SELECT mq.*, sr.mapped_data, sr.match_score,
        ds.name AS source_name,
        u.first_name, u.last_name, u.email AS top_candidate_email
      FROM matching_queue mq
      JOIN source_records sr ON sr.id=mq.source_record_id
      JOIN data_sources ds ON ds.id=mq.data_source_id
      LEFT JOIN users u ON u.id=mq.top_candidate_id
      WHERE mq.reviewed_at IS NULL
      ORDER BY mq.created_at ASC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]),
  ]);
  res.json({ total: parseInt(total.rows[0].count), queue: rows.rows });
});

matchingRouter.post('/:id/resolve', requireAdmin, async (req, res) => {
  const { resolution, user_id, notes } = req.body;
  if (!resolution) return res.status(400).json({ error: 'resolution required' });

  const qRes = await db.query('SELECT * FROM matching_queue WHERE id=$1', [req.params.id]);
  const item  = qRes.rows[0];
  if (!item) return res.status(404).json({ error: 'Not found' });

  const srRes = await db.query('SELECT * FROM source_records WHERE id=$1', [item.source_record_id]);
  const record = srRes.rows[0];

  if (resolution === 'linked' && user_id) {
    await matcher.mergeIntoUser(user_id, record.mapped_data, item.data_source_id, record.id);
    await db.query('UPDATE source_records SET match_status=$1, matched_user_id=$2 WHERE id=$3',
      ['matched', user_id, record.id]);
  } else if (resolution === 'new_user') {
    const newId = await matcher.createStubUser(record.mapped_data, item.data_source_id, record.id);
    await db.query('UPDATE source_records SET match_status=$1, matched_user_id=$2 WHERE id=$3',
      ['matched', newId, record.id]);
  } else if (resolution === 'ignored') {
    await db.query('UPDATE source_records SET match_status=$1 WHERE id=$2', ['ignored', record.id]);
  }

  await db.query(`
    UPDATE matching_queue SET reviewed_by=$1, reviewed_at=NOW(), resolution=$2, resolution_notes=$3
    WHERE id=$4
  `, [req.admin.id, resolution, notes||null, req.params.id]);

  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * VIP Groups Routes
 * GET    /api/vip-groups              – list groups
 * POST   /api/vip-groups              – create group
 * GET    /api/vip-groups/:id          – group detail
 * PATCH  /api/vip-groups/:id          – update group
 * GET    /api/vip-groups/:id/members  – member list
 * GET    /api/vip-groups/:id/pending  – pending invites
 * POST   /api/vip-groups/:id/invite   – generate + send invite for a user
 * POST   /api/vip-groups/:id/backsync – retry failed backsyncs
 * GET    /api/vip-groups/backsyncs    – pending backsync queue
 */

const vipGroupsRouter = require('express').Router();
const vipGroupsService = require('../../services/vip/groups');
const extSync = require('../../engine/sync/service');

vipGroupsRouter.get('/', requireAdmin, async (req, res) => {
  const groups = await vipGroupsService.listGroups();
  res.json(groups);
});

vipGroupsRouter.post('/', requireRole('admin','superadmin'), async (req, res) => {
  try {
    const group = await vipGroupsService.createGroup(req.body, req.admin.id);
    await auditLog(req.admin, 'create_vip_group', 'vip_group', group.id, group.name);
    res.status(201).json(group);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

vipGroupsRouter.get('/backsyncs', requireAdmin, async (req, res) => {
  const { status='pending', limit=50 } = req.query;
  const result = await db.query(`
    SELECT be.*, u.first_name, u.last_name, u.email, ds.name AS source_name, vg.name AS group_name
    FROM backsync_events be
    JOIN users u ON u.id=be.user_id
    JOIN data_sources ds ON ds.id=be.data_source_id
    LEFT JOIN vip_groups vg ON vg.id=be.vip_group_id
    WHERE be.status=$1
    ORDER BY be.created_at DESC LIMIT $2
  `, [status, parseInt(limit)]);
  res.json(result.rows);
});

vipGroupsRouter.get('/:id', requireAdmin, async (req, res) => {
  const group = await vipGroupsService.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  res.json(group);
});

vipGroupsRouter.patch('/:id', requireRole('admin','superadmin'), async (req, res) => {
  const group = await vipGroupsService.updateGroup(req.params.id, req.body);
  res.json(group);
});

vipGroupsRouter.get('/:id/members', requireAdmin, async (req, res) => {
  const result = await vipGroupsService.getGroupMembers(req.params.id, req.query);
  res.json(result);
});

vipGroupsRouter.get('/:id/pending', requireAdmin, async (req, res) => {
  const pending = await vipGroupsService.getPendingInvites(req.params.id);
  res.json(pending);
});

// Generate + optionally send invite link for a user
vipGroupsRouter.post('/:id/invite', requireAdmin, async (req, res) => {
  const { user_id, send = true } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    const link = await vipGroupsService.generateInviteLink(user_id, req.params.id, null, req.admin.id);
    if (send) {
      await vipGroupsService.sendInviteLinkToUser(user_id, link.id);
    }
    await auditLog(req.admin, 'create_invite_link', 'user', user_id, null, { groupId: req.params.id });
    res.json({ success: true, link });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Retry failed backsyncs for a group
vipGroupsRouter.post('/:id/backsync/retry', requireAdmin, async (req, res) => {
  await db.query(`
    UPDATE backsync_events SET status='pending', next_retry_at=NOW()
    WHERE vip_group_id=$1 AND status='failed'
  `, [req.params.id]);
  setImmediate(() => extSync.processPendingBacksyncs().catch(console.error));
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended Mini App route – handles flexible form submission with optional fields
 * POST /api/miniapp/submit
 */

const miniAppExtRouter = require('express').Router();
const { requireUser } = require('../middleware/auth');
const vipService = require('../../services/vip/groups');
const { addTimelineEvent } = require('../../engine/crm/timeline');

// Flexible submit: processes any fields present, does not require all
miniAppExtRouter.post('/submit', requireUser, async (req, res) => {
  const userId = req.user.id;
  const {
    first_name, last_name, email, phone, country, language,
    broker_client_id, broker_account_id, referral_code,
    target_vip_group_id,
    ...custom_fields
  } = req.body;

  try {
    // 1. Save submission (all fields optional)
    const submissionResult = await db.query(`
      INSERT INTO mini_app_submissions (
        user_id, telegram_id, telegram_username, telegram_name,
        first_name, last_name, email, phone, country, language,
        broker_client_id, broker_account_id, referral_code,
        target_vip_group_id, custom_fields, is_complete, submitted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,NOW())
      RETURNING id
    `, [
      userId,
      req.user.telegram_id, req.user.telegram_username,
      [req.user.telegram_first_name, req.user.telegram_last_name].filter(Boolean).join(' ') || null,
      first_name||null, last_name||null, email||null, phone||null,
      country||null, language||null,
      broker_client_id||null, broker_account_id||null, referral_code||null,
      target_vip_group_id||null,
      JSON.stringify(Object.keys(custom_fields).length ? custom_fields : {}),
    ]);
    const submissionId = submissionResult.rows[0].id;

    // 2. Update user profile with whatever was provided
    const profileUpdates = {};
    if (first_name) profileUpdates.first_name = first_name;
    if (last_name)  profileUpdates.last_name  = last_name;
    if (email)      profileUpdates.email       = email;
    if (broker_client_id) profileUpdates.tauro_client_id = broker_client_id;

    if (Object.keys(profileUpdates).length) {
      const sets = Object.keys(profileUpdates).map((k,i) => `${k}=$${i+1}`);
      const vals = [...Object.values(profileUpdates), userId];
      await db.query(`UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
    }

    // 3. Save extended fields
    if (phone || country || language) {
      await db.query(`
        INSERT INTO user_external_fields (user_id, phone, country, language, last_updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          phone=COALESCE($2,user_external_fields.phone),
          country=COALESCE($3,user_external_fields.country),
          language=COALESCE($4,user_external_fields.language),
          last_updated_at=NOW()
      `, [userId, phone||null, country||null, language||null]);
    }

    // 4. If target group specified, generate invite link immediately
    let inviteLink = null;
    if (target_vip_group_id) {
      try {
        const link = await vipService.generateInviteLink(userId, target_vip_group_id, submissionId, null);
        await vipService.sendInviteLinkToUser(userId, link.id);
        inviteLink = link.telegram_link;
      } catch (err) {
        // Non-fatal: link generation can be retried
        console.error('[MiniApp Submit] Invite link error:', err.message);
      }
    }

    await addTimelineEvent(userId, 'mini_app_submitted', {
      title: 'Mini App form submitted',
      metadata: { submissionId, hasEmail: !!email, hasPhone: !!phone, targetGroup: target_vip_group_id },
      actorType: 'system',
    });

    res.json({
      success:       true,
      submission_id: submissionId,
      invite_link:   inviteLink,
      message:       inviteLink
        ? 'Dein Einladungslink wurde gesendet. Klicke darauf, um der VIP-Gruppe beizutreten.'
        : 'Danke! Dein Profil wurde gespeichert.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available VIP groups (for mini app dropdown)
miniAppExtRouter.get('/groups', async (req, res) => {
  const groups = await db.query(
    'SELECT id, name, telegram_name, brand FROM vip_groups WHERE is_active=true ORDER BY name'
  );
  res.json(groups.rows);
});

module.exports = { sourcesRouter, matchingRouter, vipGroupsRouter, miniAppExtRouter };
