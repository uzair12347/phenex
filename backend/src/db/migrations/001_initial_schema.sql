-- ============================================================
-- Phenex VIP System – Full Database Schema
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- ENUM TYPES
-- ─────────────────────────────────────────────────────────────

CREATE TYPE user_status AS ENUM (
  'registered',
  'profile_completed',
  'verification_pending',
  'broker_verified',
  'qualified',
  'vip_active',
  'at_risk',
  'inactive',
  'withdrawn',
  'disqualified',
  'banned',
  'reactivated'
);

CREATE TYPE ban_type AS ENUM (
  'soft',     -- no new join, still visible
  'hard',     -- removed from group, rejoin blocked
  'shadow'    -- flagged internally, not notified
);

CREATE TYPE account_type AS ENUM (
  'trading_live_mt4',
  'trading_live_mt5',
  'trading_demo',
  'wallet',
  'pamm',
  'ib_wallet',
  'unknown'
);

CREATE TYPE rule_action_type AS ENUM (
  'set_status',
  'set_segment',
  'set_tag',
  'send_telegram',
  'create_crm_task',
  'create_crm_case',
  'ban_user',
  'unban_user',
  'send_webhook',
  'push_to_kommo',
  'push_to_sheets',
  'push_to_notion',
  'notify_admin',
  'set_watchlist'
);

CREATE TYPE rule_trigger_type AS ENUM (
  'scheduled',
  'on_event',
  'manual'
);

CREATE TYPE log_type AS ENUM (
  'admin',
  'system',
  'rule',
  'integration'
);

CREATE TYPE task_status AS ENUM (
  'open',
  'in_progress',
  'done',
  'cancelled'
);

CREATE TYPE case_type AS ENUM (
  'inactivity',
  'withdrawal',
  'qualification',
  'ban_review',
  'data_mismatch',
  'reactivation',
  'manual'
);

CREATE TYPE integration_type AS ENUM (
  'kommo',
  'google_sheets',
  'notion',
  'telegram',
  'custom_webhook',
  'python_middleware'
);

CREATE TYPE sync_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed'
);

-- ─────────────────────────────────────────────────────────────
-- ADMINS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE admins (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'admin', -- 'superadmin' | 'admin' | 'cm'
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- USERS (Master Identity)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Telegram identity
  telegram_id           BIGINT UNIQUE,
  telegram_username     VARCHAR(255),
  telegram_first_name   VARCHAR(255),
  telegram_last_name    VARCHAR(255),
  -- Profile
  first_name            VARCHAR(255),
  last_name             VARCHAR(255),
  email                 VARCHAR(255),
  -- Broker link
  tauro_client_id       VARCHAR(100),
  broker_verified       BOOLEAN NOT NULL DEFAULT false,
  broker_verified_at    TIMESTAMPTZ,
  -- Status
  status                user_status NOT NULL DEFAULT 'registered',
  segment               VARCHAR(100),             -- 'high_value', 'retention_risk', etc.
  risk_score            SMALLINT DEFAULT 0,        -- 0–100
  -- VIP
  vip_member            BOOLEAN NOT NULL DEFAULT false,
  vip_granted_at        TIMESTAMPTZ,
  vip_revoked_at        TIMESTAMPTZ,
  in_telegram_group     BOOLEAN NOT NULL DEFAULT false,
  telegram_joined_at    TIMESTAMPTZ,
  -- Ban
  is_banned             BOOLEAN NOT NULL DEFAULT false,
  ban_type              ban_type,
  ban_reason            TEXT,
  banned_at             TIMESTAMPTZ,
  banned_by             UUID REFERENCES admins(id),
  -- Assignments
  assigned_cm           UUID REFERENCES admins(id),
  structure_id          VARCHAR(100),              -- Tauro structure/upline ID
  -- Flags
  watchlist             BOOLEAN NOT NULL DEFAULT false,
  tags                  TEXT[] DEFAULT '{}',
  -- Rule overrides
  rule_override_no_ban_until  TIMESTAMPTZ,
  rule_override_reason        TEXT,
  rule_override_set_by        UUID REFERENCES admins(id),
  -- Sync
  last_synced_at        TIMESTAMPTZ,
  -- Timestamps
  registered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id      ON users(telegram_id);
CREATE INDEX idx_users_tauro_client_id  ON users(tauro_client_id);
CREATE INDEX idx_users_status           ON users(status);
CREATE INDEX idx_users_is_banned        ON users(is_banned);
CREATE INDEX idx_users_vip_member       ON users(vip_member);
CREATE INDEX idx_users_structure_id     ON users(structure_id);

-- ─────────────────────────────────────────────────────────────
-- BROKER ACCOUNTS (per trading account)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE broker_accounts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Tauro identifiers
  broker_local_id       VARCHAR(100),              -- API "id" field
  account_number        VARCHAR(100),              -- real MT4/MT5 account number
  account_type          account_type NOT NULL DEFAULT 'unknown',
  platform              VARCHAR(50),               -- 'MT4', 'MT5', 'cTrader', etc.
  currency              VARCHAR(10),
  is_demo               BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  -- Balances (latest snapshot)
  balance               DECIMAL(18,2) DEFAULT 0,
  equity                DECIMAL(18,2),
  free_margin           DECIMAL(18,2),
  -- Totals
  total_deposits        DECIMAL(18,2) DEFAULT 0,
  total_withdrawals     DECIMAL(18,2) DEFAULT 0,
  total_profit          DECIMAL(18,2) DEFAULT 0,
  -- Trade stats
  total_trades          INTEGER DEFAULT 0,
  total_lots            DECIMAL(18,4) DEFAULT 0,
  open_positions        INTEGER DEFAULT 0,
  open_lots             DECIMAL(18,4) DEFAULT 0,
  -- Activity
  last_trade_at         TIMESTAMPTZ,
  signup_date           TIMESTAMPTZ,
  -- Sync
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_broker_accounts_user_id     ON broker_accounts(user_id);
CREATE INDEX idx_broker_accounts_broker_local ON broker_accounts(broker_local_id);
CREATE INDEX idx_broker_accounts_type        ON broker_accounts(account_type);

-- ─────────────────────────────────────────────────────────────
-- ACCOUNT SNAPSHOTS (daily history for charts)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE account_snapshots (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broker_account_id UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  snapshot_date     DATE NOT NULL,
  balance           DECIMAL(18,2),
  equity            DECIMAL(18,2),
  deposits_day      DECIMAL(18,2) DEFAULT 0,
  withdrawals_day   DECIMAL(18,2) DEFAULT 0,
  trades_day        INTEGER DEFAULT 0,
  lots_day          DECIMAL(18,4) DEFAULT 0,
  profit_day        DECIMAL(18,2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(broker_account_id, snapshot_date)
);

CREATE INDEX idx_snapshots_account_date ON account_snapshots(broker_account_id, snapshot_date DESC);

-- ─────────────────────────────────────────────────────────────
-- TRADE ACTIVITY (individual trades/events)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE trade_activity (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broker_account_id UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id          VARCHAR(100),                  -- external trade ID
  symbol            VARCHAR(50),
  trade_type        VARCHAR(20),                   -- 'buy', 'sell', 'deposit', 'withdrawal'
  lots              DECIMAL(10,4),
  profit            DECIMAL(18,2),
  open_price        DECIMAL(18,5),
  close_price       DECIMAL(18,5),
  opened_at         TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  raw_data          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_activity_user       ON trade_activity(user_id);
CREATE INDEX idx_trade_activity_account    ON trade_activity(broker_account_id);
CREATE INDEX idx_trade_activity_closed_at  ON trade_activity(closed_at DESC);

-- ─────────────────────────────────────────────────────────────
-- FUNDING EVENTS (deposits / withdrawals)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE funding_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id UUID REFERENCES broker_accounts(id),
  event_type        VARCHAR(20) NOT NULL,           -- 'deposit' | 'withdrawal'
  amount            DECIMAL(18,2) NOT NULL,
  currency          VARCHAR(10),
  happened_at       TIMESTAMPTZ,
  raw_data          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_funding_user     ON funding_events(user_id);
CREATE INDEX idx_funding_type     ON funding_events(event_type);
CREATE INDEX idx_funding_happened ON funding_events(happened_at DESC);

-- ─────────────────────────────────────────────────────────────
-- VIP MEMBERSHIPS (history)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE vip_memberships (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  granted_by    UUID REFERENCES admins(id),
  revoked_by    UUID REFERENCES admins(id),
  revoke_reason TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_vip_user ON vip_memberships(user_id);

-- ─────────────────────────────────────────────────────────────
-- BAN RECORDS (history)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE ban_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ban_type        ban_type NOT NULL,
  reason          TEXT NOT NULL,
  triggered_by    VARCHAR(100),  -- 'admin:<id>' | 'rule:<rule_id>'
  banned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unbanned_at     TIMESTAMPTZ,
  unbanned_by     UUID REFERENCES admins(id),
  unban_reason    TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_ban_records_user ON ban_records(user_id);

-- ─────────────────────────────────────────────────────────────
-- RULE ENGINE
-- ─────────────────────────────────────────────────────────────

CREATE TABLE rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  priority        SMALLINT NOT NULL DEFAULT 50,      -- lower = higher priority
  trigger_type    rule_trigger_type NOT NULL DEFAULT 'scheduled',
  trigger_event   VARCHAR(100),                      -- e.g. 'deposit', 'withdrawal'
  cron_expression VARCHAR(100),                      -- for scheduled rules
  -- Target scope
  target_scope    JSONB NOT NULL DEFAULT '{"type":"all"}',
  -- Conditions (array of condition objects)
  conditions      JSONB NOT NULL DEFAULT '[]',
  conditions_logic VARCHAR(10) DEFAULT 'AND',        -- 'AND' | 'OR'
  -- Actions (array of action objects)
  actions         JSONB NOT NULL DEFAULT '[]',
  -- Cooldown
  cooldown_hours  INTEGER DEFAULT 0,
  -- Escalation chain
  escalation      JSONB DEFAULT '[]',
  -- Metadata
  created_by      UUID REFERENCES admins(id),
  updated_by      UUID REFERENCES admins(id),
  last_run_at     TIMESTAMPTZ,
  total_hits      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rule_executions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id           UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id),
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  conditions_met    JSONB,                           -- which conditions matched
  actions_taken     JSONB,                           -- results of each action
  success           BOOLEAN NOT NULL DEFAULT true,
  error_message     TEXT,
  override_active   BOOLEAN DEFAULT false,
  execution_ms      INTEGER
);

CREATE INDEX idx_rule_exec_rule ON rule_executions(rule_id);
CREATE INDEX idx_rule_exec_user ON rule_executions(user_id);
CREATE INDEX idx_rule_exec_at   ON rule_executions(triggered_at DESC);

-- ─────────────────────────────────────────────────────────────
-- ALERTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  rule_id         UUID REFERENCES rules(id),
  alert_type      VARCHAR(100) NOT NULL,
  severity        VARCHAR(20) NOT NULL DEFAULT 'medium', -- 'low'|'medium'|'high'|'critical'
  title           VARCHAR(255) NOT NULL,
  message         TEXT,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  is_resolved     BOOLEAN NOT NULL DEFAULT false,
  resolved_by     UUID REFERENCES admins(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_user      ON alerts(user_id);
CREATE INDEX idx_alerts_unread    ON alerts(is_read) WHERE is_read = false;

-- ─────────────────────────────────────────────────────────────
-- EMBEDDED CRM
-- ─────────────────────────────────────────────────────────────

CREATE TABLE crm_notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES admins(id),
  category    VARCHAR(50),                 -- 'general'|'trading'|'compliance'|'support'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crm_notes_user ON crm_notes(user_id);

CREATE TABLE crm_tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES admins(id),
  assigned_to     UUID REFERENCES admins(id),
  task_type       VARCHAR(100),             -- 'call'|'follow_up'|'check_account'|'reactivation'
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  status          task_status NOT NULL DEFAULT 'open',
  due_at          TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  -- Integration refs
  kommo_task_id   VARCHAR(100),
  source          VARCHAR(50),              -- 'manual'|'rule'|'integration'
  source_rule_id  UUID REFERENCES rules(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crm_tasks_user     ON crm_tasks(user_id);
CREATE INDEX idx_crm_tasks_assigned ON crm_tasks(assigned_to);
CREATE INDEX idx_crm_tasks_status   ON crm_tasks(status);

CREATE TABLE crm_cases (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_type       case_type NOT NULL,
  severity        VARCHAR(20) NOT NULL DEFAULT 'medium',
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  status          task_status NOT NULL DEFAULT 'open',
  assigned_to     UUID REFERENCES admins(id),
  created_by      UUID REFERENCES admins(id),          -- NULL = system/rule
  source_rule_id  UUID REFERENCES rules(id),
  resolved_at     TIMESTAMPTZ,
  -- Integration refs
  kommo_lead_id   VARCHAR(100),
  notion_page_id  VARCHAR(100),
  comments        JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crm_cases_user   ON crm_cases(user_id);
CREATE INDEX idx_crm_cases_status ON crm_cases(status);
CREATE INDEX idx_crm_cases_type   ON crm_cases(case_type);

-- Customer timeline (all events in one place)
CREATE TABLE customer_timeline (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      VARCHAR(100) NOT NULL,   -- 'registered'|'verified'|'vip_granted'|'banned'|etc.
  title           VARCHAR(255),
  description     TEXT,
  metadata        JSONB,
  actor_id        UUID REFERENCES admins(id),   -- NULL = system
  actor_type      VARCHAR(20) DEFAULT 'system', -- 'admin'|'system'|'rule'|'integration'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_timeline_user ON customer_timeline(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- REMINDERS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE reminders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL,     -- 'telegram'|'email'|'internal'
  template        VARCHAR(100),
  message         TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rule_id         UUID REFERENCES rules(id),
  success         BOOLEAN,
  error           TEXT
);

CREATE INDEX idx_reminders_user ON reminders(user_id);
CREATE INDEX idx_reminders_sent ON reminders(sent_at DESC);

-- ─────────────────────────────────────────────────────────────
-- AUDIT LOGS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  log_type        log_type NOT NULL,
  action          VARCHAR(255) NOT NULL,
  actor_id        VARCHAR(255),             -- admin UUID or 'system' or 'rule:<id>'
  actor_name      VARCHAR(255),
  target_type     VARCHAR(50),              -- 'user'|'rule'|'integration'|'admin'
  target_id       VARCHAR(255),
  target_name     VARCHAR(255),
  description     TEXT,
  metadata        JSONB,
  ip_address      VARCHAR(45),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_type    ON audit_logs(log_type);
CREATE INDEX idx_audit_action  ON audit_logs(action);
CREATE INDEX idx_audit_actor   ON audit_logs(actor_id);
CREATE INDEX idx_audit_target  ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_at      ON audit_logs(created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- INTEGRATIONS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE integrations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  type            integration_type NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  config          JSONB NOT NULL DEFAULT '{}',  -- encrypted/masked in API
  webhook_url     VARCHAR(500),
  webhook_secret  VARCHAR(255),
  last_sync_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Maps internal user IDs to external system IDs
CREATE TABLE integration_mappings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_id        UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id           VARCHAR(255) NOT NULL,   -- e.g. Kommo contact ID
  external_url          VARCHAR(500),
  sync_status           VARCHAR(50) DEFAULT 'synced',
  last_synced_at        TIMESTAMPTZ,
  sync_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(integration_id, user_id)
);

CREATE INDEX idx_int_mappings_user ON integration_mappings(user_id);

-- Sync job log
CREATE TABLE sync_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type        VARCHAR(100) NOT NULL,   -- 'tauro_full'|'tauro_delta'|'kommo_push'|etc.
  status          sync_status NOT NULL DEFAULT 'pending',
  structure_id    VARCHAR(100),
  users_processed INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_log       JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_jobs_type   ON sync_jobs(job_type);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);

-- ─────────────────────────────────────────────────────────────
-- VERIFICATION TOKENS (for JWT email verify flow)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE verification_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      VARCHAR(255) NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  is_used         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_verify_tokens_user ON verification_tokens(user_id);

-- ─────────────────────────────────────────────────────────────
-- UPDATED_AT TRIGGER
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'admins','users','broker_accounts','rules','crm_tasks','crm_cases',
    'crm_notes','integrations','integration_mappings'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      tbl, tbl
    );
  END LOOP;
END;
$$;
