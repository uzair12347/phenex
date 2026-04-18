const db = require('../db');

/**
 * Write an admin audit log entry.
 */
async function auditLog(admin, action, targetType, targetId, targetName, metadata, req) {
  await db.query(`
    INSERT INTO audit_logs
      (log_type, action, actor_id, actor_name, target_type, target_id, target_name, metadata, ip_address)
    VALUES ('admin',$1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    action,
    admin?.id || 'system',
    admin?.name || 'System',
    targetType,
    targetId,
    targetName,
    metadata ? JSON.stringify(metadata) : null,
    req?.ip || null,
  ]);
}

module.exports = auditLog;
