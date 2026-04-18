/**
 * Action Executor
 * Handles all rule action types.
 */

const db = require('../../db');
const logger = require('../../utils/logger');
const { addTimelineEvent } = require('../crm/timeline');
const telegramService = require('../../services/telegram/service');
const kommoAdapter = require('../../services/integrations/kommo');
const webhookService = require('../../services/integrations/webhook');

class ActionExecutor {
  async execute(action, userId, rule, facts) {
    switch (action.type) {
      case 'set_status':        return this._setStatus(userId, action.value, rule);
      case 'set_segment':       return this._setSegment(userId, action.value, rule);
      case 'set_tag':           return this._addTag(userId, action.value);
      case 'set_watchlist':     return this._setWatchlist(userId, action.value === true);
      case 'ban_user':          return this._banUser(userId, action, rule);
      case 'unban_user':        return this._unbanUser(userId, action, rule);
      case 'send_telegram':     return this._sendTelegram(userId, action, facts);
      case 'create_crm_task':   return this._createTask(userId, action, rule);
      case 'create_crm_case':   return this._createCase(userId, action, rule);
      case 'notify_admin':      return this._notifyAdmin(userId, action, rule, facts);
      case 'push_to_kommo':     return kommoAdapter.pushUser(userId, action);
      case 'send_webhook':      return webhookService.send(action.url, { userId, rule: rule.id, action, facts });
      default:
        logger.warn(`[Actions] Unknown action type: ${action.type}`);
        return null;
    }
  }

  async _setStatus(userId, status, rule) {
    await db.query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, userId]);
    await addTimelineEvent(userId, 'status_changed', {
      title: `Status set to ${status}`,
      metadata: { status, source: `rule:${rule.id}`, ruleName: rule.name },
      actorType: 'rule',
    });
    return { status };
  }

  async _setSegment(userId, segment, rule) {
    await db.query('UPDATE users SET segment = $1, updated_at = NOW() WHERE id = $2', [segment, userId]);
    await addTimelineEvent(userId, 'segment_changed', {
      title: `Segment set to ${segment}`,
      metadata: { segment, source: `rule:${rule.id}` },
      actorType: 'rule',
    });
    return { segment };
  }

  async _addTag(userId, tag) {
    await db.query(`
      UPDATE users SET tags = array_append(tags, $1), updated_at = NOW()
      WHERE id = $2 AND NOT ($1 = ANY(tags))
    `, [tag, userId]);
    return { tag };
  }

  async _setWatchlist(userId, value) {
    await db.query('UPDATE users SET watchlist = $1, updated_at = NOW() WHERE id = $2', [value, userId]);
    return { watchlist: value };
  }

  async _banUser(userId, action, rule) {
    const banType = action.banType || 'soft';
    const reason  = action.reason  || `Auto-ban by rule: ${rule.name}`;

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE users SET
          is_banned = true, ban_type = $1, ban_reason = $2,
          banned_at = NOW(), status = 'banned',
          vip_member = false, vip_revoked_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
      `, [banType, reason, userId]);

      await client.query(`
        INSERT INTO ban_records (user_id, ban_type, reason, triggered_by)
        VALUES ($1,$2,$3,$4)
      `, [userId, banType, reason, `rule:${rule.id}`]);

      await client.query(`
        UPDATE vip_memberships SET is_active=false, revoked_at=NOW(), revoke_reason=$1
        WHERE user_id=$2 AND is_active=true
      `, [reason, userId]);
    });

    await addTimelineEvent(userId, 'banned', {
      title: `Banned (${banType})`,
      metadata: { banType, reason, ruleId: rule.id, ruleName: rule.name },
      actorType: 'rule',
    });

    // Telegram: notify user if hard ban
    if (banType === 'hard') {
      await telegramService.sendBanNotification(userId).catch(() => {});
    }

    return { banned: true, banType };
  }

  async _unbanUser(userId, action, rule) {
    const reason = action.reason || `Auto-unban by rule: ${rule.name}`;

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE users SET
          is_banned = false, ban_type = NULL, ban_reason = NULL,
          banned_at = NULL, banned_by = NULL,
          status = 'reactivated', updated_at = NOW()
        WHERE id = $1
      `, [userId]);

      await client.query(`
        UPDATE ban_records SET is_active=false, unbanned_at=NOW(), unban_reason=$1
        WHERE user_id=$2 AND is_active=true
      `, [reason, userId]);
    });

    await addTimelineEvent(userId, 'unbanned', {
      title: 'Unbanned',
      metadata: { reason, ruleId: rule.id },
      actorType: 'rule',
    });

    return { unbanned: true };
  }

  async _sendTelegram(userId, action, facts) {
    if (!facts.telegram_id) return { skipped: 'no_telegram_id' };
    const message = this._resolveTemplate(action.template, action.message, facts);
    await telegramService.sendMessage(facts.telegram_id, message);
    await db.query(`
      INSERT INTO reminders (user_id, channel, template, message, rule_id, success)
      VALUES ($1,'telegram',$2,$3,$4,true)
    `, [userId, action.template || null, message, action.ruleId || null]);
    return { sent: true, telegramId: facts.telegram_id };
  }

  async _createTask(userId, action, rule) {
    const result = await db.query(`
      INSERT INTO crm_tasks (user_id, task_type, title, description, source, source_rule_id)
      VALUES ($1,$2,$3,$4,'rule',$5) RETURNING id
    `, [userId, action.taskType || 'follow_up', action.title || rule.name, action.description, rule.id]);
    return { taskId: result.rows[0].id };
  }

  async _createCase(userId, action, rule) {
    // Check if an open case of this type already exists
    const existing = await db.query(`
      SELECT id FROM crm_cases
      WHERE user_id=$1 AND case_type=$2 AND status='open'
      LIMIT 1
    `, [userId, action.caseType || 'manual']);
    if (existing.rows.length) return { caseId: existing.rows[0].id, existing: true };

    const result = await db.query(`
      INSERT INTO crm_cases (user_id, case_type, severity, title, description, source_rule_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [userId, action.caseType || 'manual', action.severity || 'medium', action.title || rule.name, action.description, rule.id]);
    return { caseId: result.rows[0].id };
  }

  async _notifyAdmin(userId, action, rule, facts) {
    await db.query(`
      INSERT INTO alerts (user_id, rule_id, alert_type, severity, title, message)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [userId, rule.id, action.alertType || 'rule_triggered', action.severity || 'medium',
        action.title || `Rule triggered: ${rule.name}`,
        action.message || `Rule "${rule.name}" triggered for user ${userId}`]);
    return { alerted: true };
  }

  _resolveTemplate(templateKey, fallback, facts) {
    const templates = {
      inactivity_reminder: `Hallo ${facts.telegram_first_name || 'User'}, wir haben bemerkt, dass du seit ${facts.days_since_last_trade} Tagen nicht mehr getradet hast. Bleib aktiv, um deinen VIP-Zugang zu behalten! 🚀`,
      withdrawal_alert:    `Wichtiger Hinweis: Es wurde eine Auszahlung auf deinem Account festgestellt. Bitte kontaktiere uns, falls du Fragen hast.`,
      reactivation:        `Willkommen zurück! Du kannst jetzt wieder voll am VIP-Programm teilnehmen. 🎉`,
    };
    return templates[templateKey] || fallback || 'Phenex VIP Notification';
  }
}

module.exports = new ActionExecutor();
