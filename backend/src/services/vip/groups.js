/**
 * VIP Groups Service
 * Manages groups, invite links, join tracking, and backsync.
 */

const db              = require('../../db');
const logger          = require('../../utils/logger');
const telegramService = require('../../services/telegram/service');
const extSyncService  = require('../../engine/sync/service');
const { addTimelineEvent } = require('../../engine/crm/timeline');

class VipGroupsService {

  // ── Group management ──────────────────────────────────────────

  async listGroups() {
    return db.query(`
      SELECT vg.*,
        (SELECT COUNT(*) FROM invite_links il WHERE il.vip_group_id = vg.id) AS total_invites_sent,
        (SELECT COUNT(*) FROM invite_links il WHERE il.vip_group_id = vg.id AND il.status='redeemed') AS total_invites_redeemed,
        (SELECT COUNT(*) FROM join_events je WHERE je.vip_group_id = vg.id AND je.is_active=true) AS total_members
      FROM vip_groups vg
      ORDER BY vg.is_active DESC, vg.name
    `).then(r => r.rows);
  }

  async getGroup(id) {
    const result = await db.query('SELECT * FROM vip_groups WHERE id=$1', [id]);
    return result.rows[0] || null;
  }

  async createGroup(data, adminId) {
    const result = await db.query(`
      INSERT INTO vip_groups (name, telegram_group_id, telegram_name, group_type, brand, structure_id, invite_expiry_hours, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [data.name, data.telegram_group_id, data.telegram_name, data.group_type || 'supergroup',
        data.brand, data.structure_id, data.invite_expiry_hours || 24, data.notes]);
    return result.rows[0];
  }

  async updateGroup(id, data) {
    const allowed = ['name','telegram_name','brand','structure_id','is_active','invite_expiry_hours','auto_backsync','notes'];
    const updates = {};
    for (const k of allowed) { if (data[k] !== undefined) updates[k] = data[k]; }
    if (!Object.keys(updates).length) return null;

    const sets   = Object.keys(updates).map((k, i) => `${k}=$${i+1}`);
    const values = [...Object.values(updates), id];
    await db.query(`UPDATE vip_groups SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${values.length}`, values);
    return this.getGroup(id);
  }

  // ── Invite link generation ────────────────────────────────────

  /**
   * Generate a unique invite link for a user to a specific VIP group.
   * Called after Mini App submission is accepted.
   */
  async generateInviteLink(userId, vipGroupId, submissionId, adminId) {
    const group = await this.getGroup(vipGroupId);
    if (!group || !group.is_active) throw new Error('VIP group not found or inactive');

    // Check for existing active invite link
    const existing = await db.query(`
      SELECT * FROM invite_links
      WHERE user_id=$1 AND vip_group_id=$2 AND status IN ('created','sent')
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [userId, vipGroupId]);

    if (existing.rows[0]) {
      logger.info(`[VipGroups] Reusing existing invite link for user ${userId}`);
      return existing.rows[0];
    }

    // Create Telegram invite link
    const telegramLink = await telegramService.createGroupInviteLink(
      group.telegram_group_id,
      group.invite_expiry_hours
    );
    if (!telegramLink) throw new Error('Failed to create Telegram invite link');

    const expiresAt = new Date(Date.now() + group.invite_expiry_hours * 3600 * 1000);

    const result = await db.query(`
      INSERT INTO invite_links
        (user_id, vip_group_id, submission_id, telegram_link, status, expires_at, created_by_admin)
      VALUES ($1,$2,$3,$4,'created',$5,$6) RETURNING *
    `, [userId, vipGroupId, submissionId || null, telegramLink, expiresAt, adminId || null]);

    const link = result.rows[0];

    // Timeline event
    await addTimelineEvent(userId, 'invite_link_created', {
      title: `Invite link created for ${group.name}`,
      metadata: { vipGroupId, groupName: group.name, linkId: link.id },
      actorType: 'system',
    });

    logger.info(`[VipGroups] Invite link created for user ${userId} → group ${group.name}`);
    return link;
  }

  /**
   * Mark invite link as sent (after we send the TG message to the user).
   */
  async markLinkSent(linkId) {
    await db.query(
      "UPDATE invite_links SET status='sent', sent_at=NOW() WHERE id=$1",
      [linkId]
    );
  }

  /**
   * Send the invite link to a user via Telegram message.
   */
  async sendInviteLinkToUser(userId, linkId) {
    const userResult = await db.query('SELECT telegram_id, first_name FROM users WHERE id=$1', [userId]);
    const user = userResult.rows[0];
    if (!user?.telegram_id) throw new Error('User has no Telegram ID');

    const linkResult = await db.query(
      'SELECT il.*, vg.name AS group_name FROM invite_links il JOIN vip_groups vg ON vg.id=il.vip_group_id WHERE il.id=$1',
      [linkId]
    );
    const link = linkResult.rows[0];
    if (!link) throw new Error('Link not found');

    const message = `🎉 <b>Willkommen bei ${link.group_name}!</b>\n\n` +
      `Dein exklusiver Einladungslink:\n${link.telegram_link}\n\n` +
      `⚠️ Dieser Link ist einmalig und läuft ab. Bitte klicke zeitnah.`;

    await telegramService.sendMessage(user.telegram_id, message);
    await this.markLinkSent(linkId);

    await addTimelineEvent(userId, 'invite_link_sent', {
      title: `Invite link sent for ${link.group_name}`,
      metadata: { linkId, groupName: link.group_name },
      actorType: 'system',
    });
  }

  // ── Join event handling ───────────────────────────────────────

  /**
   * Process a Telegram chat_member update (user joined or left).
   * Called from the Telegram webhook handler.
   */
  async handleTelegramMemberUpdate(update) {
    const chatId      = String(update.chat?.id);
    const newMember   = update.new_chat_member;
    const tgUserId    = newMember?.user?.id;
    const newStatus   = newMember?.status;

    if (!chatId || !tgUserId) return;

    // Find VIP group by Telegram group ID
    const groupResult = await db.query(
      'SELECT * FROM vip_groups WHERE telegram_group_id=$1', [chatId]
    );
    if (!groupResult.rows[0]) return; // Not a tracked group

    const group = groupResult.rows[0];
    const joined = ['member','administrator','creator'].includes(newStatus);

    // Find the user
    const userResult = await db.query('SELECT * FROM users WHERE telegram_id=$1', [tgUserId]);
    const user = userResult.rows[0];

    // Find which invite link they used
    const linkResult = await db.query(`
      SELECT * FROM invite_links
      WHERE user_id=$1 AND vip_group_id=$2 AND status='sent'
      ORDER BY created_at DESC LIMIT 1
    `, [user?.id, group.id]);
    const link = linkResult.rows[0];

    if (joined) {
      // Record join event
      const joinResult = await db.query(`
        INSERT INTO join_events
          (user_id, vip_group_id, invite_link_id, telegram_user_id, telegram_username, joined_at, raw_telegram_event)
        VALUES ($1,$2,$3,$4,$5,NOW(),$6) RETURNING *
      `, [
        user?.id || null, group.id, link?.id || null,
        tgUserId, newMember.user?.username,
        JSON.stringify(update),
      ]);
      const joinEvent = joinResult.rows[0];

      // Update invite link status
      if (link) {
        const isMismatch = link.user_id && user?.id && link.user_id !== user.id;
        await db.query(`
          UPDATE invite_links SET
            status='redeemed', redeemed_at=NOW(),
            redeemed_by_telegram_id=$1,
            is_mismatch=$2
          WHERE id=$3
        `, [tgUserId, isMismatch, link.id]);
      }

      // Update user VIP status
      if (user) {
        await db.query(`
          UPDATE users SET in_telegram_group=true, vip_member=true, status='vip_active', updated_at=NOW()
          WHERE id=$1
        `, [user.id]);

        await addTimelineEvent(user.id, 'vip_group_joined', {
          title: `Joined VIP group: ${group.name}`,
          metadata: { groupId: group.id, groupName: group.name, telegramGroupId: chatId },
          actorType: 'system',
        });

        // Trigger backsync to all connected CRMs
        if (group.auto_backsync) {
          await extSyncService.queueBacksync(user.id, 'vip_joined', {
            user_id:        user.id,
            first_name:     user.first_name,
            last_name:      user.last_name,
            email:          user.email,
            telegram_username: user.telegram_username,
            vip_group_name: group.name,
            vip_group_id:   group.id,
            joined_at:      new Date().toISOString(),
          }, group.id, joinEvent.id);
        }
      }

      logger.info(`[VipGroups] User ${tgUserId} joined ${group.name}`);

    } else {
      // User left or was removed
      await db.query(`
        UPDATE join_events SET is_active=false, left_at=NOW(), leave_reason=$1
        WHERE telegram_user_id=$2 AND vip_group_id=$3 AND is_active=true
      `, [newStatus === 'kicked' ? 'kicked' : 'voluntary', tgUserId, group.id]);

      if (user) {
        await db.query(
          'UPDATE users SET in_telegram_group=false, updated_at=NOW() WHERE id=$1',
          [user.id]
        );
      }
    }
  }

  // ── Group members view ────────────────────────────────────────

  async getGroupMembers(groupId, params = {}) {
    const { page = 1, limit = 50, status } = params;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where  = ['je.vip_group_id=$1'];
    const vals   = [groupId];

    if (status === 'active')   where.push('je.is_active=true');
    if (status === 'inactive') where.push('je.is_active=false');

    const [total, rows] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM join_events je WHERE ${where.join(' AND ')}`, vals),
      db.query(`
        SELECT je.*, u.first_name, u.last_name, u.email, u.telegram_username, u.status AS user_status,
          il.status AS invite_status, il.created_at AS invite_created_at,
          bs.status AS backsync_status
        FROM join_events je
        LEFT JOIN users u ON u.id=je.user_id
        LEFT JOIN invite_links il ON il.id=je.invite_link_id
        LEFT JOIN backsync_events bs ON bs.user_id=je.user_id AND bs.vip_group_id=$1 AND bs.event_type='vip_joined'
        WHERE ${where.join(' AND ')}
        ORDER BY je.joined_at DESC
        LIMIT $${vals.length+1} OFFSET $${vals.length+2}
      `, [...vals, parseInt(limit), offset]),
    ]);

    return { total: parseInt(total.rows[0].count), members: rows.rows };
  }

  async getPendingInvites(groupId) {
    return db.query(`
      SELECT il.*, u.first_name, u.last_name, u.email, u.telegram_username
      FROM invite_links il
      JOIN users u ON u.id=il.user_id
      WHERE il.vip_group_id=$1 AND il.status IN ('created','sent')
        AND (il.expires_at IS NULL OR il.expires_at > NOW())
      ORDER BY il.created_at DESC
    `, [groupId]).then(r => r.rows);
  }
}

module.exports = new VipGroupsService();
