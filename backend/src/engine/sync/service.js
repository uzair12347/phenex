/**
 * External Sync Service
 * Orchestrates pulling from external sources, matching, and backsyncing.
 */

const db      = require('../../db');
const logger  = require('../../utils/logger');
const matcher = require('./matcher');
const { createConnector } = require('./connectors');

class ExternalSyncService {

  /**
   * Run sync for a specific data source.
   */
  async syncSource(sourceId) {
    const srcResult = await db.query('SELECT * FROM data_sources WHERE id=$1 AND is_active=true', [sourceId]);
    if (!srcResult.rows[0]) throw new Error('Data source not found or inactive');
    const source = srcResult.rows[0];

    logger.info(`[ExtSync] Starting sync for source: ${source.name} (${source.type})`);
    const started = Date.now();

    try {
      // 1. Fetch raw records from external source
      const connector = createConnector(source);
      const rawRecords = await connector.fetchRecords();

      // 2. Apply field mapping
      const mappedRecords = await connector.applyFieldMapping(rawRecords);

      // 3. Save source records to DB
      const savedIds = [];
      for (const rec of mappedRecords) {
        const result = await db.query(`
          INSERT INTO source_records (data_source_id, external_id, raw_data, mapped_data)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (data_source_id, external_id) DO UPDATE
            SET raw_data=$3, mapped_data=$4, imported_at=NOW()
          RETURNING id
        `, [source.id, rec.mapped.external_id, JSON.stringify(rec.raw), JSON.stringify(rec.mapped)]
        ).catch(() => ({ rows: [] }));

        if (result.rows[0]) savedIds.push({ id: result.rows[0].id, mapped_data: rec.mapped });
      }

      // 4. Run identity matching
      const stats = await matcher.processBatch(source.id, savedIds);

      // 5. Update source health
      await db.query(`
        UPDATE data_sources SET
          last_sync_at=NOW(), last_error=NULL,
          health_status='ok', health_checked_at=NOW(),
          total_synced=total_synced+$1,
          total_conflicts=total_conflicts+$2,
          total_unmatched=total_unmatched+$3,
          updated_at=NOW()
        WHERE id=$4
      `, [stats.matched, stats.conflicts, stats.unmatched, source.id]);

      const elapsed = Date.now() - started;
      logger.info(`[ExtSync] ${source.name}: ${savedIds.length} records, ${JSON.stringify(stats)}, ${elapsed}ms`);
      return { source: source.name, records: savedIds.length, stats, elapsed };

    } catch (err) {
      await db.query(`
        UPDATE data_sources SET last_error=$1, last_error_at=NOW(), health_status='error', updated_at=NOW()
        WHERE id=$2
      `, [err.message, source.id]);
      logger.error(`[ExtSync] ${source.name} failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Run all active non-broker sources.
   */
  async syncAll() {
    const sources = await db.query(
      "SELECT id FROM data_sources WHERE is_active=true AND type != 'broker_api' ORDER BY priority ASC"
    );
    const results = [];
    for (const row of sources.rows) {
      const result = await this.syncSource(row.id).catch(err => ({ error: err.message }));
      results.push(result);
    }
    return results;
  }

  // ── Sync Preview ─────────────────────────────────────────────

  /**
   * Preview what a sync would import without committing.
   */
  async previewSync(sourceId) {
    const srcResult = await db.query('SELECT * FROM data_sources WHERE id=$1', [sourceId]);
    if (!srcResult.rows[0]) throw new Error('Source not found');
    const source = srcResult.rows[0];

    const connector   = createConnector(source);
    const rawRecords  = await connector.fetchRecords();
    const mappedRecords = await connector.applyFieldMapping(rawRecords);

    let newCount = 0, updateCount = 0, reviewCount = 0;

    for (const rec of mappedRecords.slice(0, 200)) { // preview cap
      const matchResult = await matcher.match(rec.mapped);
      if (!matchResult.matched && matchResult.score === 0) newCount++;
      else if (matchResult.confidence === 'exact' || matchResult.confidence === 'strong') updateCount++;
      else reviewCount++;
    }

    return {
      totalRecords: rawRecords.length,
      previewed:    Math.min(200, rawRecords.length),
      new:          newCount,
      update:       updateCount,
      review:       reviewCount,
      sample:       mappedRecords.slice(0, 3).map(r => r.mapped),
    };
  }

  // ── Backsync ─────────────────────────────────────────────────

  /**
   * Create and queue a backsync event for a user/group join.
   */
  async queueBacksync(userId, eventType, payload, vipGroupId, joinEventId) {
    // Get all active bidirectional sources
    const sources = await db.query(
      "SELECT id FROM data_sources WHERE is_active=true AND direction IN ('export_only','bidirectional')"
    );

    for (const src of sources.rows) {
      await db.query(`
        INSERT INTO backsync_events
          (user_id, data_source_id, event_type, vip_group_id, join_event_id, payload, next_retry_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
      `, [userId, src.id, eventType, vipGroupId || null, joinEventId || null, JSON.stringify(payload)]);
    }
  }

  /**
   * Process pending backsync events (called by cron job).
   */
  async processPendingBacksyncs() {
    const pending = await db.query(`
      SELECT be.*, ds.type AS source_type, ds.config AS source_config, ds.name AS source_name
      FROM backsync_events be
      JOIN data_sources ds ON ds.id = be.data_source_id
      WHERE be.status IN ('pending','retrying')
        AND be.next_retry_at <= NOW()
        AND be.attempts < be.max_attempts
      ORDER BY be.created_at ASC
      LIMIT 50
    `);

    for (const event of pending.rows) {
      await this._executeBacksync(event);
    }
  }

  async _executeBacksync(event) {
    await db.query(`
      UPDATE backsync_events SET attempts=attempts+1, status='retrying', sent_at=NOW() WHERE id=$1
    `, [event.id]);

    try {
      let externalRef = null;

      switch (event.source_type) {
        case 'kommo':
          externalRef = await this._backsyncKommo(event);
          break;
        case 'google_sheets':
          externalRef = await this._backsyncSheets(event);
          break;
        case 'notion':
          externalRef = await this._backsyncNotion(event);
          break;
        default:
          externalRef = await this._backsyncWebhook(event);
      }

      await db.query(`
        UPDATE backsync_events SET status='confirmed', confirmed_at=NOW(), external_ref=$1 WHERE id=$2
      `, [externalRef, event.id]);

    } catch (err) {
      const nextRetry = new Date(Date.now() + 15 * 60 * 1000); // retry in 15 min
      const failed    = event.attempts >= event.max_attempts - 1;

      await db.query(`
        UPDATE backsync_events SET
          status=$1, last_error=$2, next_retry_at=$3
        WHERE id=$4
      `, [failed ? 'failed' : 'retrying', err.message, nextRetry, event.id]);

      logger.warn(`[Backsync] Event ${event.id} failed (attempt ${event.attempts}): ${err.message}`);
    }
  }

  async _backsyncKommo(event) {
    const kommoAdapter = require('../../services/integrations/kommo');
    const payload      = event.payload;
    const vipName      = payload.vip_group_name || 'VIP Group';
    const joinedAt     = payload.joined_at ? new Date(payload.joined_at).toLocaleDateString('de-DE') : 'Unknown date';
    const noteText     = `Customer joined the VIP group "${vipName}" on ${joinedAt} via the Telegram Mini App.`;
    await kommoAdapter.addNote(event.user_id, noteText);
    return 'kommo_note_added';
  }

  async _backsyncSheets(event) {
    const { googleSheets } = require('../../services/integrations/sheets-notion');
    const payload = event.payload;
    const row = [
      payload.user_id, payload.first_name, payload.last_name, payload.email,
      payload.telegram_username, payload.vip_group_name, payload.joined_at, 'VIP_JOINED',
    ];
    const spreadsheetId = event.source_config.spreadsheet_id;
    const sheet         = event.source_config.backsync_sheet || 'VIP_Joins';
    await googleSheets.write(`${sheet}!A:H`, [row]);
    return 'sheets_row_appended';
  }

  async _backsyncNotion(event) {
    const { notion }  = require('../../services/integrations/sheets-notion');
    const result      = await notion.upsertCustomer(event.user_id);
    return result?.pageId || 'notion_updated';
  }

  async _backsyncWebhook(event) {
    const webhookSvc = require('../../services/integrations/webhook');
    const url = event.source_config.backsync_url || event.source_config.webhook_url;
    if (!url) throw new Error('No backsync URL configured');
    await webhookSvc.send(url, event.payload, event.source_config.webhook_secret);
    return 'webhook_delivered';
  }
}

module.exports = new ExternalSyncService();
