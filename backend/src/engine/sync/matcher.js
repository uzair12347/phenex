/**
 * Identity Matching Engine
 *
 * Matches incoming source records to existing users using
 * three confidence tiers:
 *   EXACT  – single field uniquely identifies the user (email, telegram_id, etc.)
 *   STRONG – two or more fields point to same user
 *   WEAK   – partial matches needing human review
 */

const db = require('../../db');
const logger = require('../../utils/logger');

class IdentityMatcher {

  /**
   * Attempt to match a mapped source record to an existing user.
   * Returns { userId, confidence, score, reasons } or null.
   */
  async match(mappedData) {
    const candidates = new Map(); // userId → { score, reasons }

    // ── EXACT MATCH FIELDS ────────────────────────────────────
    // A single hit on any of these = confident match
    const exactChecks = [
      { field: 'telegram_id',       query: 'SELECT id FROM users WHERE telegram_id = $1',          value: mappedData.telegram_id },
      { field: 'email',             query: 'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',   value: mappedData.email },
      { field: 'tauro_client_id',   query: 'SELECT id FROM users WHERE tauro_client_id = $1',      value: mappedData.broker_client_id || mappedData.tauro_client_id },
    ];

    for (const check of exactChecks) {
      if (!check.value) continue;
      const result = await db.query(check.query, [check.value]);
      if (result.rows.length === 1) {
        this._addScore(candidates, result.rows[0].id, 60, `exact:${check.field}`);
      }
    }

    // Check user_source_links for external ID matches
    if (mappedData.external_id) {
      const linked = await db.query(
        'SELECT user_id FROM user_source_links WHERE external_id = $1',
        [String(mappedData.external_id)]
      );
      for (const row of linked.rows) {
        this._addScore(candidates, row.user_id, 70, 'exact:external_id_link');
      }
    }

    // Check phone against extended fields
    if (mappedData.phone) {
      const norm = this._normalizePhone(mappedData.phone);
      const byPhone = await db.query(
        'SELECT user_id FROM user_external_fields WHERE phone = $1',
        [norm]
      );
      for (const row of byPhone.rows) {
        this._addScore(candidates, row.user_id, 55, 'exact:phone');
      }
    }

    // ── STRONG MATCH ──────────────────────────────────────────
    // Name + at least one other identifier
    if (mappedData.first_name && mappedData.last_name) {
      const byName = await db.query(
        `SELECT id FROM users
         WHERE LOWER(first_name) = LOWER($1) AND LOWER(last_name) = LOWER($2)`,
        [mappedData.first_name, mappedData.last_name]
      );
      for (const row of byName.rows) {
        this._addScore(candidates, row.id, 25, 'strong:full_name');
      }
    }

    if (mappedData.telegram_username) {
      const byUsername = await db.query(
        'SELECT id FROM users WHERE LOWER(telegram_username) = LOWER($1)',
        [mappedData.telegram_username.replace(/^@/, '')]
      );
      for (const row of byUsername.rows) {
        this._addScore(candidates, row.id, 30, 'strong:telegram_username');
      }
    }

    // ── SCORE EVALUATION ──────────────────────────────────────
    if (candidates.size === 0) {
      return { matched: false, confidence: 'none', score: 0, reasons: [], candidates: [] };
    }

    // Sort by score descending
    const sorted = [...candidates.entries()]
      .map(([userId, data]) => ({ userId, ...data }))
      .sort((a, b) => b.score - a.score);

    const top = sorted[0];

    let confidence;
    if (top.score >= 60)      confidence = 'exact';
    else if (top.score >= 40) confidence = 'strong';
    else                      confidence = 'weak';

    return {
      matched:     confidence !== 'weak' || sorted.length === 1,
      userId:      top.userId,
      confidence,
      score:       top.score,
      reasons:     top.reasons,
      candidates:  sorted.slice(0, 5).map(c => ({
        userId: c.userId, score: c.score, reasons: c.reasons
      })),
    };
  }

  /**
   * Process a batch of source records: match them and update DB.
   */
  async processBatch(sourceId, records) {
    const stats = { matched: 0, unmatched: 0, review: 0, conflicts: 0 };

    for (const record of records) {
      try {
        const result = await this.match(record.mapped_data || {});

        let matchStatus, matchedUserId;

        if (result.confidence === 'exact' && result.matched) {
          matchStatus    = 'matched';
          matchedUserId  = result.userId;
          stats.matched++;

          // Merge data into user record
          await this.mergeIntoUser(result.userId, record.mapped_data, sourceId, record.id);

        } else if (result.confidence === 'strong' && result.matched) {
          matchStatus    = 'matched';
          matchedUserId  = result.userId;
          stats.matched++;
          await this.mergeIntoUser(result.userId, record.mapped_data, sourceId, record.id);

        } else if (result.score > 0) {
          // Needs review
          matchStatus    = 'pending_review';
          matchedUserId  = result.userId;
          stats.review++;

          await db.query(`
            INSERT INTO matching_queue
              (source_record_id, data_source_id, candidate_user_ids, top_candidate_id, top_score)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING
          `, [
            record.id, sourceId,
            JSON.stringify(result.candidates),
            result.userId, result.score,
          ]);

        } else {
          // No match → create new stub user
          matchStatus   = 'unmatched';
          matchedUserId = await this.createStubUser(record.mapped_data, sourceId, record.id);
          stats.unmatched++;
        }

        // Update source record
        await db.query(`
          UPDATE source_records SET
            match_status = $1, match_confidence = $2, match_score = $3,
            matched_user_id = $4, match_reasons = $5, synced_at = NOW()
          WHERE id = $6
        `, [
          matchStatus, result.confidence, result.score,
          matchedUserId, JSON.stringify(result.reasons), record.id,
        ]);

      } catch (err) {
        logger.error(`[Matcher] Record ${record.id}: ${err.message}`);
        await db.query('UPDATE source_records SET error=$1 WHERE id=$2', [err.message, record.id]);
      }
    }

    return stats;
  }

  /**
   * Merge mapped fields into user record and extended fields table.
   * Respects field locks and source priority rules.
   */
  async mergeIntoUser(userId, mappedData, sourceId, recordId) {
    if (!mappedData || !userId) return;

    // Check locked fields
    const locksResult = await db.query(
      'SELECT field_name FROM field_locks WHERE user_id=$1', [userId]
    );
    const lockedFields = new Set(locksResult.rows.map(r => r.field_name));

    // Update core user fields if present and not locked
    const coreUpdates = {};
    const coreFields = ['email','first_name','last_name','telegram_username','telegram_id','structure_id'];
    for (const f of coreFields) {
      if (mappedData[f] != null && !lockedFields.has(f)) {
        coreUpdates[f] = mappedData[f];
      }
    }

    if (Object.keys(coreUpdates).length) {
      const sets   = Object.keys(coreUpdates).map((k, i) => `${k}=$${i+1}`);
      const vals   = [...Object.values(coreUpdates), userId];
      await db.query(
        `UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`,
        vals
      );

      // Log each field change
      for (const [field, newVal] of Object.entries(coreUpdates)) {
        await db.query(`
          INSERT INTO field_value_log (user_id, field_name, new_value, source_id, source_record_id)
          VALUES ($1,$2,$3,$4,$5)
        `, [userId, field, String(newVal), sourceId, recordId]);
      }
    }

    // Upsert extended fields
    const extFields = [
      'phone','country','language','timezone',
      'net_deposit','gross_deposit','withdrawal','balance','equity',
      'lots_total','trades_total','last_trade_ext','last_deposit_ext',
      'last_withdrawal_ext','ftd_amount','ftd_date',
      'crm_owner','crm_status','pipeline_stage','lead_source',
      'kyc_status','account_status',
    ];

    const extUpdates = {};
    for (const f of extFields) {
      const mapped = mappedData[f] ?? mappedData[f.replace(/_ext$/, '')];
      if (mapped != null && !lockedFields.has(f)) {
        extUpdates[f] = mapped;
      }
    }

    if (Object.keys(extUpdates).length) {
      const cols  = Object.keys(extUpdates);
      const vals  = Object.values(extUpdates);
      const sets  = cols.map((c, i) => `${c}=$${i+2}`);

      await db.query(`
        INSERT INTO user_external_fields (user_id, ${cols.join(',')}, source_id, last_updated_at)
        VALUES ($1, ${cols.map((_,i) => `$${i+2}`).join(',')}, $${cols.length+2}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          ${sets.join(',')},
          source_id=$${cols.length+2},
          last_updated_at=NOW()
      `, [userId, ...vals, sourceId]);
    }

    // Save external ID link
    if (mappedData.external_id) {
      await db.query(`
        INSERT INTO user_source_links (user_id, data_source_id, external_id)
        VALUES ($1,$2,$3)
        ON CONFLICT (data_source_id, external_id) DO UPDATE SET synced_at=NOW()
      `, [userId, sourceId, String(mappedData.external_id)]);
    }
  }

  /**
   * Create a stub user from partial external data.
   */
  async createStubUser(data, sourceId, recordId) {
    const result = await db.query(`
      INSERT INTO users (
        email, first_name, last_name, telegram_id, telegram_username,
        tauro_client_id, status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'registered',NOW())
      RETURNING id
    `, [
      data.email || null,
      data.first_name || null,
      data.last_name  || null,
      data.telegram_id ? parseInt(data.telegram_id) : null,
      data.telegram_username || null,
      data.broker_client_id || data.tauro_client_id || null,
    ]);

    const userId = result.rows[0].id;
    await this.mergeIntoUser(userId, data, sourceId, recordId);
    logger.info(`[Matcher] Created stub user ${userId} from source ${sourceId}`);
    return userId;
  }

  // ── Helpers ──────────────────────────────────────────────────

  _addScore(map, userId, points, reason) {
    if (!userId) return;
    const existing = map.get(userId) || { score: 0, reasons: [] };
    existing.score += points;
    existing.reasons.push(reason);
    map.set(userId, existing);
  }

  _normalizePhone(phone) {
    return String(phone).replace(/[\s\-\(\)\+]/g, '');
  }
}

module.exports = new IdentityMatcher();
