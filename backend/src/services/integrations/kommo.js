/**
 * Kommo CRM Adapter
 * Pushes customer data and tasks to Kommo via their REST API.
 * Server-side only (never expose client secret to browser).
 */

const axios = require('axios');
const db = require('../../db');
const logger = require('../../utils/logger');

class KommoAdapter {
  constructor() {
    this.baseUrl      = process.env.KOMMO_BASE_URL;
    this.accessToken  = process.env.KOMMO_ACCESS_TOKEN;
    this.refreshToken = process.env.KOMMO_REFRESH_TOKEN;
    this.clientId     = process.env.KOMMO_CLIENT_ID;
    this.clientSecret = process.env.KOMMO_CLIENT_SECRET;
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── Contact sync ─────────────────────────────────────────────

  async pushUser(userId, options = {}) {
    const user = await this._getUserData(userId);
    if (!user) return;

    const mapping = await this._getMapping(userId);

    if (mapping?.external_id) {
      return this.updateContact(mapping.external_id, user, userId);
    } else {
      return this.createContact(user, userId);
    }
  }

  async createContact(user, userId) {
    const payload = [this._buildContactPayload(user)];
    try {
      const resp = await axios.post(
        `${this.baseUrl}/api/v4/contacts`,
        payload,
        { headers: this.headers }
      );
      const contactId = resp.data?._embedded?.contacts?.[0]?.id;
      if (contactId) {
        await this._saveMapping(userId, String(contactId));
        logger.info(`[Kommo] Contact created: ${contactId} for user ${userId}`);
      }
      return { contactId };
    } catch (err) {
      logger.error(`[Kommo] createContact failed: ${err.message}`);
      throw err;
    }
  }

  async updateContact(contactId, user, userId) {
    const payload = this._buildContactPayload(user);
    try {
      await axios.patch(
        `${this.baseUrl}/api/v4/contacts/${contactId}`,
        payload,
        { headers: this.headers }
      );
      await this._updateMappingSync(userId);
      return { contactId, updated: true };
    } catch (err) {
      logger.error(`[Kommo] updateContact ${contactId} failed: ${err.message}`);
      throw err;
    }
  }

  // ─── Task creation ────────────────────────────────────────────

  async createTask(userId, { title, description, dueAt, taskType = 'follow_up' } = {}) {
    const mapping = await this._getMapping(userId);
    if (!mapping?.external_id) {
      // Create contact first, then task
      const user = await this._getUserData(userId);
      await this.createContact(user, userId);
      return this.createTask(userId, { title, description, dueAt, taskType });
    }

    const payload = [{
      task_type_id: 1,   // 1 = Call, 2 = Meeting – customize as needed
      text: `${title}\n\n${description || ''}`.trim(),
      complete_till: dueAt ? Math.floor(new Date(dueAt).getTime() / 1000) : Math.floor(Date.now()/1000) + 86400,
      entity_id:   parseInt(mapping.external_id),
      entity_type: 'contacts',
    }];

    try {
      const resp = await axios.post(
        `${this.baseUrl}/api/v4/tasks`,
        payload,
        { headers: this.headers }
      );
      return { taskId: resp.data?._embedded?.tasks?.[0]?.id };
    } catch (err) {
      logger.error(`[Kommo] createTask failed: ${err.message}`);
      throw err;
    }
  }

  // ─── Note (internal comment) ──────────────────────────────────

  async addNote(userId, text) {
    const mapping = await this._getMapping(userId);
    if (!mapping?.external_id) return;

    const payload = [{
      entity_id:   parseInt(mapping.external_id),
      note_type:   'common',
      params: { text },
    }];

    await axios.post(
      `${this.baseUrl}/api/v4/contacts/${mapping.external_id}/notes`,
      payload,
      { headers: this.headers }
    ).catch(err => logger.warn(`[Kommo] addNote failed: ${err.message}`));
  }

  // ─── Helpers ──────────────────────────────────────────────────

  _buildContactPayload(user) {
    return {
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      custom_fields_values: [
        { field_code: 'EMAIL',  values: [{ value: user.email, enum_code: 'WORK' }] },
        { field_code: 'PHONE',  values: [{ value: user.telegram_username || '' }] },
        ...(user.tauro_client_id ? [{
          field_id: null, // set your custom field ID in Kommo for Tauro ID
          field_name: 'TauroMarkets ID',
          values: [{ value: user.tauro_client_id }],
        }] : []),
      ].filter(Boolean),
      tags: [
        { name: 'phenex_vip' },
        user.vip_member ? { name: 'vip_active' } : null,
        user.is_banned  ? { name: 'banned' }     : null,
        user.segment    ? { name: user.segment }  : null,
      ].filter(Boolean),
    };
  }

  async _getUserData(userId) {
    const res = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    return res.rows[0] || null;
  }

  async _getMapping(userId) {
    // Get Kommo integration ID
    const intRes = await db.query(
      "SELECT id FROM integrations WHERE type = 'kommo' AND is_active = true LIMIT 1"
    );
    if (!intRes.rows[0]) return null;

    const mapRes = await db.query(
      'SELECT * FROM integration_mappings WHERE integration_id=$1 AND user_id=$2',
      [intRes.rows[0].id, userId]
    );
    return mapRes.rows[0] || null;
  }

  async _saveMapping(userId, externalId) {
    const intRes = await db.query(
      "SELECT id FROM integrations WHERE type='kommo' AND is_active=true LIMIT 1"
    );
    if (!intRes.rows[0]) return;

    await db.query(`
      INSERT INTO integration_mappings (integration_id, user_id, external_id, last_synced_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (integration_id, user_id) DO UPDATE SET external_id=$3, last_synced_at=NOW()
    `, [intRes.rows[0].id, userId, externalId]);
  }

  async _updateMappingSync(userId) {
    const intRes = await db.query(
      "SELECT id FROM integrations WHERE type='kommo' AND is_active=true LIMIT 1"
    );
    if (!intRes.rows[0]) return;
    await db.query(
      'UPDATE integration_mappings SET last_synced_at=NOW() WHERE integration_id=$1 AND user_id=$2',
      [intRes.rows[0].id, userId]
    );
  }

  // ─── Token refresh ────────────────────────────────────────────

  async refreshAccessToken() {
    try {
      const resp = await axios.post(`${this.baseUrl}/oauth2/access_token`, {
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        grant_type:    'refresh_token',
        refresh_token: this.refreshToken,
        redirect_uri:  `${process.env.APP_URL}/integrations/kommo/callback`,
      });
      this.accessToken  = resp.data.access_token;
      this.refreshToken = resp.data.refresh_token;
      logger.info('[Kommo] Access token refreshed');
      return resp.data;
    } catch (err) {
      logger.error(`[Kommo] Token refresh failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = new KommoAdapter();
