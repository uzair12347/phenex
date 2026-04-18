const db = require('../../db');

/**
 * Add an event to the customer timeline.
 * actorType: 'admin' | 'system' | 'rule' | 'integration'
 */
async function addTimelineEvent(userId, eventType, {
  title, description, metadata, actorId, actorType = 'system',
} = {}) {
  await db.query(`
    INSERT INTO customer_timeline
      (user_id, event_type, title, description, metadata, actor_id, actor_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [userId, eventType, title, description, metadata ? JSON.stringify(metadata) : null, actorId || null, actorType]);
}

module.exports = { addTimelineEvent };
