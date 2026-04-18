/**
 * External Source Connectors
 * Each connector pulls records from an external source,
 * applies field mapping, and returns normalized source records.
 */

const axios  = require('axios');
const db     = require('../../db');
const logger = require('../../utils/logger');

// ── Base class ────────────────────────────────────────────────
class BaseConnector {
  constructor(sourceConfig) {
    this.source = sourceConfig; // data_sources row
    this.config = sourceConfig.config || {};
  }

  async fetchRecords() { throw new Error('Not implemented'); }

  async applyFieldMapping(records) {
    const mappings = await db.query(
      'SELECT * FROM source_field_mappings WHERE data_source_id = $1',
      [this.source.id]
    );
    const fieldMap = mappings.rows; // [{external_field, internal_field, transform, ...}]

    return records.map(rawRow => {
      const mapped = { external_id: rawRow._external_id || rawRow.id || rawRow.ID };

      for (const m of fieldMap) {
        const rawVal = rawRow[m.external_field];
        if (rawVal === undefined || rawVal === null) continue;
        mapped[m.internal_field] = this._transform(rawVal, m.transform, m.data_type);
      }

      return { raw: rawRow, mapped };
    });
  }

  _transform(val, transform, dataType) {
    let v = val;
    if (transform === 'lowercase')  v = String(v).toLowerCase().trim();
    if (transform === 'trim')        v = String(v).trim();
    if (transform === 'date_iso')    v = v ? new Date(v).toISOString() : null;
    if (transform === 'strip_at')    v = String(v).replace(/^@/, '');
    if (dataType === 'integer')      v = parseInt(v) || null;
    if (dataType === 'decimal')      v = parseFloat(v) || null;
    if (dataType === 'boolean')      v = Boolean(v);
    return v;
  }
}

// ── Google Sheets Connector ───────────────────────────────────
class GoogleSheetsConnector extends BaseConnector {
  async fetchRecords() {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets       = google.sheets({ version: 'v4', auth });
    const spreadsheetId = this.config.spreadsheet_id || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range        = this.config.range || `${this.config.sheet_name || 'Sheet1'}!A:ZZ`;

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0].map(h => String(h).trim());
    const records = rows.slice(1).map((row, idx) => {
      const obj = { _external_id: `row_${idx + 2}` };
      headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
      return obj;
    });

    logger.info(`[Sheets Connector] Fetched ${records.length} rows from ${spreadsheetId}/${range}`);
    return records;
  }
}

// ── Database Connector ────────────────────────────────────────
class DatabaseConnector extends BaseConnector {
  async fetchRecords() {
    const { Pool } = require('pg'); // supports PostgreSQL; MySQL support can be added
    const pool = new Pool({
      host:     this.config.host,
      port:     parseInt(this.config.port) || 5432,
      database: this.config.database,
      user:     this.config.user,
      password: this.config.password,
      ssl:      this.config.ssl ? { rejectUnauthorized: false } : false,
    });

    try {
      const query  = this.config.query || `SELECT * FROM ${this.config.table} LIMIT 10000`;
      const result = await pool.query(query);
      const rows   = result.rows.map((r, i) => ({ _external_id: r[this.config.id_field || 'id'] || `row_${i}`, ...r }));
      logger.info(`[DB Connector] Fetched ${rows.length} records from ${this.config.database}/${this.config.table}`);
      return rows;
    } finally {
      await pool.end();
    }
  }
}

// ── Generic REST API Connector ────────────────────────────────
class GenericApiConnector extends BaseConnector {
  async fetchRecords() {
    const { url, method = 'GET', headers = {}, body, data_path, id_field = 'id' } = this.config;
    if (!url) throw new Error('GenericApiConnector: url not configured');

    const resp = await axios({
      method,
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      data: body || undefined,
      timeout: 30000,
    });

    let data = resp.data;

    // Navigate nested path: e.g. data_path = 'data.contacts'
    if (data_path) {
      data = data_path.split('.').reduce((obj, key) => obj?.[key], data);
    }

    if (!Array.isArray(data)) {
      if (typeof data === 'object') data = [data];
      else throw new Error('GenericApiConnector: response is not an array');
    }

    const records = data.map((r, i) => ({ _external_id: r[id_field] || `idx_${i}`, ...r }));
    logger.info(`[API Connector] Fetched ${records.length} records from ${url}`);
    return records;
  }
}

// ── CSV Connector ─────────────────────────────────────────────
class CsvConnector extends BaseConnector {
  async fetchRecords() {
    const { url, local_path } = this.config;
    let rawCsv;

    if (url) {
      const resp = await axios.get(url, { responseType: 'text', timeout: 15000 });
      rawCsv = resp.data;
    } else if (local_path) {
      const fs = require('fs');
      rawCsv = fs.readFileSync(local_path, 'utf8');
    } else {
      throw new Error('CsvConnector: no url or local_path configured');
    }

    const lines   = rawCsv.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const records = lines.slice(1).map((line, idx) => {
      const cells = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const obj   = { _external_id: `row_${idx + 2}` };
      headers.forEach((h, i) => { obj[h] = cells[i] ?? null; });
      return obj;
    });

    logger.info(`[CSV Connector] Parsed ${records.length} rows`);
    return records;
  }
}

// ── Factory ───────────────────────────────────────────────────
function createConnector(sourceRow) {
  switch (sourceRow.type) {
    case 'google_sheets':    return new GoogleSheetsConnector(sourceRow);
    case 'database':         return new DatabaseConnector(sourceRow);
    case 'generic_api':      return new GenericApiConnector(sourceRow);
    case 'webhook':          return new GenericApiConnector(sourceRow);
    case 'csv':              return new CsvConnector(sourceRow);
    case 'kommo':            return new GenericApiConnector({ ...sourceRow, config: { url: `${sourceRow.config.base_url}/api/v4/contacts`, headers: { Authorization: `Bearer ${sourceRow.config.access_token}` }, data_path: '_embedded.contacts', ...sourceRow.config } });
    default:
      throw new Error(`No connector for source type: ${sourceRow.type}`);
  }
}

module.exports = { createConnector, GoogleSheetsConnector, DatabaseConnector, GenericApiConnector };
