/**
 * Google Sheets Adapter
 * Uses Google Sheets REST API v4 with service account auth.
 */

const { google } = require('googleapis');
const db = require('../../db');
const logger = require('../../utils/logger');

class GoogleSheetsAdapter {
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    this._auth = null;
  }

  async getAuth() {
    if (this._auth) return this._auth;
    this._auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:   process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return this._auth;
  }

  async getSheets() {
    const auth = await this.getAuth();
    return google.sheets({ version: 'v4', auth });
  }

  /**
   * Export current customer list to a named sheet tab.
   */
  async exportCustomers(sheetName = 'Customers') {
    const sheets = await this.getSheets();

    const users = await db.query(`
      SELECT
        u.first_name, u.last_name, u.email,
        u.telegram_username, u.tauro_client_id,
        u.status, u.segment, u.vip_member, u.is_banned,
        u.registered_at,
        COALESCE(SUM(ba.balance), 0) AS total_balance,
        MAX(ta.closed_at) AS last_trade_at
      FROM users u
      LEFT JOIN broker_accounts ba ON ba.user_id = u.id
      LEFT JOIN trade_activity ta ON ta.user_id = u.id
      GROUP BY u.id
      ORDER BY u.registered_at DESC
      LIMIT 5000
    `);

    const headers = [
      'First Name','Last Name','Email','Telegram','Tauro ID',
      'Status','Segment','VIP','Banned','Registered','Balance','Last Trade',
    ];
    const rows = users.rows.map(u => [
      u.first_name, u.last_name, u.email, u.telegram_username, u.tauro_client_id,
      u.status, u.segment, u.vip_member ? 'YES' : 'NO', u.is_banned ? 'YES' : 'NO',
      u.registered_at?.toISOString().slice(0,10),
      u.total_balance, u.last_trade_at?.toISOString().slice(0,10),
    ]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range:         `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...rows] },
    });

    logger.info(`[Sheets] Exported ${rows.length} customers to "${sheetName}"`);
    return { exported: rows.length };
  }

  /**
   * Generic write: pass any data array to any sheet range.
   */
  async write(range, values) {
    const sheets = await this.getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    return { written: values.length };
  }

  /**
   * Read a range from sheets.
   */
  async read(range) {
    const sheets = await this.getSheets();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    return resp.data.values || [];
  }
}

/**
 * Notion Adapter
 * Uses Notion REST API v1 for pages and databases.
 */
class NotionAdapter {
  constructor() {
    this.apiKey       = process.env.NOTION_API_KEY;
    this.customersDb  = process.env.NOTION_CUSTOMERS_DB_ID;
    this.casesDb      = process.env.NOTION_CASES_DB_ID;
    this.baseUrl      = 'https://api.notion.com/v1';
    this.notionVersion = '2022-06-28';
  }

  get headers() {
    return {
      Authorization:   `Bearer ${this.apiKey}`,
      'Content-Type':  'application/json',
      'Notion-Version': this.notionVersion,
    };
  }

  async request(method, path, data) {
    const axios = require('axios');
    const resp = await axios({ method, url: `${this.baseUrl}${path}`, headers: this.headers, data, timeout: 10000 });
    return resp.data;
  }

  /**
   * Create or update a customer review page in Notion.
   */
  async upsertCustomer(userId) {
    const res = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = res.rows[0];
    if (!user) return;

    // Check for existing mapping
    const mapping = await this._getMapping(userId);
    const props = this._buildCustomerProperties(user);

    if (mapping?.notion_page_id) {
      await this.request('PATCH', `/pages/${mapping.notion_page_id}`, { properties: props });
      return { pageId: mapping.notion_page_id, updated: true };
    } else {
      const page = await this.request('POST', '/pages', {
        parent: { database_id: this.customersDb },
        properties: props,
      });
      await this._saveMapping(userId, page.id);
      return { pageId: page.id, created: true };
    }
  }

  /**
   * Create a case page in Notion cases database.
   */
  async createCase(caseData) {
    const page = await this.request('POST', '/pages', {
      parent: { database_id: this.casesDb },
      properties: {
        'Name':     { title: [{ text: { content: caseData.title } }] },
        'Type':     { select: { name: caseData.case_type } },
        'Severity': { select: { name: caseData.severity   } },
        'Status':   { select: { name: 'Open'              } },
      },
    });
    return { pageId: page.id };
  }

  _buildCustomerProperties(user) {
    return {
      'Name':          { title:  [{ text: { content: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email } }] },
      'Email':         { email:  user.email || null },
      'Telegram':      { rich_text: [{ text: { content: user.telegram_username || '' } }] },
      'Status':        { select: { name: user.status   || 'registered'  } },
      'VIP':           { checkbox: user.vip_member || false },
      'Banned':        { checkbox: user.is_banned  || false },
      'Tauro ID':      { rich_text: [{ text: { content: user.tauro_client_id || '' } }] },
    };
  }

  async _getMapping(userId) {
    const res = await db.query(
      `SELECT im.external_id AS notion_page_id FROM integration_mappings im
       JOIN integrations i ON i.id = im.integration_id
       WHERE i.type='notion' AND im.user_id=$1 LIMIT 1`,
      [userId]
    );
    return res.rows[0] || null;
  }

  async _saveMapping(userId, pageId) {
    const intRes = await db.query("SELECT id FROM integrations WHERE type='notion' AND is_active=true LIMIT 1");
    if (!intRes.rows[0]) return;
    await db.query(`
      INSERT INTO integration_mappings (integration_id, user_id, external_id, last_synced_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (integration_id, user_id) DO UPDATE SET external_id=$3, last_synced_at=NOW()
    `, [intRes.rows[0].id, userId, pageId]);
  }
}

module.exports = {
  googleSheets: new GoogleSheetsAdapter(),
  notion:       new NotionAdapter(),
};
