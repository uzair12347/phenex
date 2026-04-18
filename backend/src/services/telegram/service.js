/**
 * Telegram Bot Service
 * Handles sending messages, ban notifications, and group management.
 */

const axios = require('axios');
const db = require('../../db');
const logger = require('../../utils/logger');

class TelegramService {
  constructor() {
    this.token    = process.env.TELEGRAM_BOT_TOKEN;
    this.groupId  = process.env.TELEGRAM_VIP_GROUP_ID;
    this.baseUrl  = `https://api.telegram.org/bot${this.token}`;
  }

  async sendMessage(chatId, text, options = {}) {
    try {
      const resp = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options,
      }, { timeout: 8000 });
      return resp.data;
    } catch (err) {
      logger.warn(`[Telegram] sendMessage to ${chatId} failed: ${err.message}`);
      throw err;
    }
  }

  async banFromGroup(telegramId) {
    if (!this.groupId) return;
    try {
      await axios.post(`${this.baseUrl}/banChatMember`, {
        chat_id:  this.groupId,
        user_id:  telegramId,
      });
      return { banned: true };
    } catch (err) {
      logger.warn(`[Telegram] banChatMember ${telegramId} failed: ${err.message}`);
      return { banned: false, error: err.message };
    }
  }

  async unbanFromGroup(telegramId) {
    if (!this.groupId) return;
    try {
      await axios.post(`${this.baseUrl}/unbanChatMember`, {
        chat_id:         this.groupId,
        user_id:         telegramId,
        only_if_banned:  true,
      });
      return { unbanned: true };
    } catch (err) {
      logger.warn(`[Telegram] unbanChatMember ${telegramId} failed: ${err.message}`);
      return { unbanned: false, error: err.message };
    }
  }

  async sendBanNotification(userId) {
    const res = await db.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
    const telegramId = res.rows[0]?.telegram_id;
    if (!telegramId) return;

    const message = `⛔ <b>Du wurdest aus der Phenex VIP Gruppe entfernt.</b>\n\nDu wurdest aufgrund von Inaktivität oder einem anderen Vergehen gebannt. Keine Panik. Das kann ein Fehler sein. Bitte kontaktiere unseren Support!`;
    await this.sendMessage(telegramId, message);
    await this.banFromGroup(telegramId);
  }

  /**
   * Generate a VIP group invite link for a verified user.
   */
  async createGroupInviteLink() {
    if (!this.groupId) return null;
    try {
      const resp = await axios.post(`${this.baseUrl}/createChatInviteLink`, {
        chat_id:     this.groupId,
        member_limit: 1,
        expire_date:  Math.floor(Date.now() / 1000) + 86400, // 24h
      });
      return resp.data?.result?.invite_link;
    } catch (err) {
      logger.warn(`[Telegram] createGroupInviteLink failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Check if a user is currently a member of the VIP group.
   */
  async checkMembership(telegramId) {
    if (!this.groupId) return false;
    try {
      const resp = await axios.post(`${this.baseUrl}/getChatMember`, {
        chat_id: this.groupId,
        user_id: telegramId,
      });
      const status = resp.data?.result?.status;
      return ['member', 'administrator', 'creator'].includes(status);
    } catch {
      return false;
    }
  }

  /**
   * Process incoming Telegram webhook updates.
   */
  async handleUpdate(update) {
    if (update.message) {
      const msg = update.message;
      logger.debug(`[Telegram] Message from ${msg.from?.id}: ${msg.text?.slice(0, 50)}`);
      // Bot command routing handled separately by the mini-app flow
    }
    if (update.my_chat_member) {
      // User joined or left the group
      const change = update.my_chat_member;
      await this._handleGroupMembershipChange(change);
    }
  }

  async _handleGroupMembershipChange(change) {
    const telegramId = change.from?.id;
    if (!telegramId) return;

    const newStatus = change.new_chat_member?.status;
    const inGroup   = ['member', 'administrator', 'creator'].includes(newStatus);

    await db.query(
      'UPDATE users SET in_telegram_group = $1, updated_at = NOW() WHERE telegram_id = $2',
      [inGroup, telegramId]
    );
  }
}

module.exports = new TelegramService();
