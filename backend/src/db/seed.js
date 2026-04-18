require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function seed() {
  const client = await pool.connect();
  try {
    // Superadmin
    const hash = await bcrypt.hash('admin123', 12);
    await client.query(`
      INSERT INTO admins (name, email, password_hash, role)
      VALUES ('Super Admin', 'admin@phenex.com', $1, 'superadmin')
      ON CONFLICT (email) DO NOTHING
    `, [hash]);
    console.log('[seed] Admin created: admin@phenex.com / admin123');

    // Register integrations
    await client.query(`
      INSERT INTO integrations (name, type, is_active, config)
      VALUES
        ('TauroMarkets API',  'kommo',          false, '{}'),
        ('Kommo CRM',         'kommo',          false, '{}'),
        ('Google Sheets',     'google_sheets',  false, '{}'),
        ('Notion',            'notion',         false, '{}'),
        ('Generic Webhook',   'custom_webhook', false, '{}')
      ON CONFLICT DO NOTHING
    `);

    // Example rules
    const adminRes = await client.query("SELECT id FROM admins WHERE role='superadmin' LIMIT 1");
    const adminId  = adminRes.rows[0]?.id;

    const exampleRules = [
      {
        name: 'Inactivity Flag – 7 Days',
        description: 'Flags users who have not traded in 7 days',
        conditions: [
          { field: 'days_since_last_trade', operator: 'gte', value: 7 },
          { field: 'vip_member', operator: 'is_true' },
        ],
        conditions_logic: 'AND',
        actions: [
          { type: 'set_status', value: 'inactive' },
          { type: 'set_tag', value: 'inactive_7d' },
          { type: 'notify_admin', severity: 'medium', title: 'User inactive 7d' },
        ],
        cooldown_hours: 24,
        priority: 10,
      },
      {
        name: 'Inactivity Reminder – 7 Days',
        description: 'Sends Telegram reminder after 7 days inactivity',
        conditions: [
          { field: 'days_since_last_trade', operator: 'gte', value: 7 },
          { field: 'vip_member', operator: 'is_true' },
          { field: 'reminders_last_3d', operator: 'lte', value: 0 },
        ],
        conditions_logic: 'AND',
        actions: [
          { type: 'send_telegram', template: 'inactivity_reminder' },
          { type: 'create_crm_task', taskType: 'follow_up', title: 'Follow up – 7d inactivity', severity: 'medium' },
        ],
        cooldown_hours: 72,
        priority: 20,
      },
      {
        name: 'Auto-Ban – 30 Days Inactivity',
        description: 'Auto-bans users inactive for 30 days with no open tasks',
        conditions: [
          { field: 'days_since_last_trade', operator: 'gte', value: 30 },
          { field: 'vip_member', operator: 'is_true' },
          { field: 'open_tasks_count', operator: 'lte', value: 0 },
        ],
        conditions_logic: 'AND',
        actions: [
          { type: 'ban_user', banType: 'hard', reason: 'Auto-ban: 30 days inactivity' },
          { type: 'create_crm_case', caseType: 'inactivity', severity: 'high', title: 'Auto-banned: 30d inactivity' },
        ],
        cooldown_hours: 0,
        priority: 5,
      },
      {
        name: 'Full Withdrawal Alert',
        description: 'Alerts when withdrawal ratio exceeds 90%',
        conditions: [
          { field: 'withdrawal_ratio', operator: 'gte', value: 0.9 },
          { field: 'vip_member', operator: 'is_true' },
        ],
        conditions_logic: 'AND',
        actions: [
          { type: 'set_status', value: 'withdrawn' },
          { type: 'notify_admin', severity: 'high', title: 'Full withdrawal detected', alertType: 'withdrawal' },
          { type: 'create_crm_case', caseType: 'withdrawal', severity: 'high', title: 'Full withdrawal alert' },
        ],
        cooldown_hours: 48,
        priority: 8,
      },
      {
        name: 'High Value Tag',
        description: 'Tags users with deposits > 5000 and active trading',
        conditions: [
          { field: 'total_deposits', operator: 'gte', value: 5000 },
          { field: 'days_since_last_trade', operator: 'lte', value: 14 },
        ],
        conditions_logic: 'AND',
        actions: [
          { type: 'set_segment', value: 'high_value' },
          { type: 'set_tag', value: 'high_value_active' },
        ],
        cooldown_hours: 168, // 1 week
        priority: 30,
      },
    ];

    for (const rule of exampleRules) {
      await client.query(`
        INSERT INTO rules (
          name, description, trigger_type, conditions, conditions_logic,
          actions, cooldown_hours, priority, created_by, is_active
        ) VALUES ($1,$2,'scheduled',$3,$4,$5,$6,$7,$8,false)
        ON CONFLICT DO NOTHING
      `, [
        rule.name, rule.description,
        JSON.stringify(rule.conditions), rule.conditions_logic,
        JSON.stringify(rule.actions), rule.cooldown_hours,
        rule.priority, adminId,
      ]);
    }

    console.log(`[seed] ${exampleRules.length} example rules created (inactive by default).`);
    console.log('[seed] Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error('[seed] ERROR:', err); process.exit(1); });
