-- ============================================================
-- Migration 002: External Data Sync & VIP Group CRM Module
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- ENUM ADDITIONS
-- ─────────────────────────────────────────────────────────────

CREATE TYPE data_source_type AS ENUM (
  'broker_api',
  'google_sheets',
  'database',
  'kommo',
  'notion',
  'python_middleware',
  'generic_api',
  'webhook',
  'csv'
);

CREATE TYPE sync_direction AS ENUM (
  'import_only',
  'export_only',
  'bidirectional'
);

CREATE TYPE match_status AS ENUM (
  'matched',
  'unmatched',
  'pending_review',
  'conflict',
  'ignored',
  'manually_linked'
);

CREATE TYPE match_confidence AS ENUM (
  'exact',
  'strong',
  'weak',
  'none'
);

CREATE TYPE field_status AS ENUM (
  'present',
  'empty',
  'unknown',
  'not_requested',
  'not_available',
  'locked'
);

CREATE TYPE invite_status AS ENUM (
  'created',
  'sent',
  'opened',
  'redeemed',
  'expired',
  'revoked'
);

CREATE TYPE backsync_status AS ENUM (
  'pending',
  'sent',
  'confirmed',
  'failed',
  'retrying',
  'skipped'
);

-- ─────────────────────────────────────────────────────────────
-- DATA SOURCES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE data_sources (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(255) NOT NULL,
  type              data_source_type NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT false,
  priority          SMALLINT NOT NULL DEFAULT 50,        -- lower = higher priority
  direction         sync_direction NOT NULL DEFAULT 'import_only',
  -- Connection config (type-specific, stored as JSONB)
  config            JSONB NOT NULL DEFAULT '{}',
  -- Sync settings
  sync_interval_min INTEGER DEFAULT 60,
  last_sync_at      TIMESTAMPTZ,
  last_error        TEXT,
  last_error_at     TIMESTAMPTZ,
  total_synced      INTEGER DEFAULT 0,
  total_conflicts   INTEGER DEFAULT 0,
  total_unmatched   INTEGER DEFAULT 0,
  -- Health
  health_status     VARCHAR(20) DEFAULT 'unknown',       -- 'ok'|'degraded'|'error'|'unknown'
  health_checked_at TIMESTAMPTZ,
  created_by        UUID REFERENCES admins(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_data_sources_type   ON data_sources(type);
CREATE INDEX idx_data_sources_active ON data_sources(is_active);

-- Field mapping per source
CREATE TABLE source_field_mappings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id    UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  external_field    VARCHAR(255) NOT NULL,   -- field name in the external source
  internal_field    VARCHAR(255) NOT NULL,   -- field path in our master record
  data_type         VARCHAR(50) DEFAULT 'string', -- string|integer|decimal|boolean|datetime
  is_required       BOOLEAN NOT NULL DEFAULT false,
  is_matching_field BOOLEAN NOT NULL DEFAULT false,  -- used for identity matching
  is_backsync_field BOOLEAN NOT NULL DEFAULT false,  -- written back to source
  is_readonly       BOOLEAN NOT NULL DEFAULT false,  -- never overwrite from source
  transform         VARCHAR(100),            -- optional transform: 'lowercase'|'trim'|'date_iso'
  priority_override SMALLINT,               -- overrides source priority for this field only
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_field_mappings_source ON source_field_mappings(data_source_id);

-- Source priority rules (per field group)
CREATE TABLE source_priority_rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  field_group     VARCHAR(100) NOT NULL,    -- 'trading'|'contact'|'telegram'|'status'|'crm'
  field_pattern   VARCHAR(255),             -- regex or exact field name
  sources_order   JSONB NOT NULL,           -- ordered list of source IDs
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw records imported from external sources (before matching)
CREATE TABLE source_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id  UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  external_id     VARCHAR(500),             -- ID in the source system
  raw_data        JSONB NOT NULL,           -- original row/object as received
  mapped_data     JSONB,                    -- after field mapping applied
  match_status    match_status NOT NULL DEFAULT 'pending_review',
  match_confidence match_confidence,
  match_score     SMALLINT,                 -- 0–100
  matched_user_id UUID REFERENCES users(id),
  match_reasons   JSONB,                    -- which fields caused the match
  conflict_fields JSONB,                    -- fields that conflict with existing data
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at       TIMESTAMPTZ,
  error           TEXT
);

CREATE INDEX idx_source_records_source    ON source_records(data_source_id);
CREATE INDEX idx_source_records_status    ON source_records(match_status);
CREATE INDEX idx_source_records_user      ON source_records(matched_user_id);
CREATE INDEX idx_source_records_ext       ON source_records(external_id);
CREATE INDEX idx_source_records_imported  ON source_records(imported_at DESC);

-- Identity matching queue (records needing manual review)
CREATE TABLE matching_queue (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_record_id  UUID NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  data_source_id    UUID NOT NULL REFERENCES data_sources(id),
  -- Possible candidate matches
  candidate_user_ids JSONB DEFAULT '[]',    -- array of {user_id, score, reasons}
  top_candidate_id  UUID REFERENCES users(id),
  top_score         SMALLINT,
  -- Review
  reviewed_by       UUID REFERENCES admins(id),
  reviewed_at       TIMESTAMPTZ,
  resolution        VARCHAR(50),            -- 'linked'|'new_user'|'ignored'|'conflict_kept'
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matching_queue_unreviewed ON matching_queue(reviewed_at) WHERE reviewed_at IS NULL;

-- Field-level value history (which source wrote which value when)
CREATE TABLE field_value_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_name      VARCHAR(255) NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  source_id       UUID REFERENCES data_sources(id),
  source_record_id UUID REFERENCES source_records(id),
  priority_rule   VARCHAR(100),
  overridden_by   UUID REFERENCES admins(id),  -- if manual override
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_field_log_user  ON field_value_log(user_id, field_name);
CREATE INDEX idx_field_log_at    ON field_value_log(created_at DESC);

-- Field lock (prevent auto-updates for specific fields per user)
CREATE TABLE field_locks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_name  VARCHAR(255) NOT NULL,
  locked_by   UUID REFERENCES admins(id),
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT,
  UNIQUE(user_id, field_name)
);

-- Extended user profile fields from external sources
CREATE TABLE user_external_fields (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id       UUID REFERENCES data_sources(id),
  -- Extended contact
  phone           VARCHAR(50),
  country         VARCHAR(10),
  language        VARCHAR(10),
  timezone        VARCHAR(50),
  -- Trading (from external source, fallback when broker API unavailable)
  net_deposit     DECIMAL(18,2),
  gross_deposit   DECIMAL(18,2),
  withdrawal      DECIMAL(18,2),
  balance         DECIMAL(18,2),
  equity          DECIMAL(18,2),
  lots_total      DECIMAL(18,4),
  trades_total    INTEGER,
  last_trade_ext  TIMESTAMPTZ,
  last_deposit_ext TIMESTAMPTZ,
  last_withdrawal_ext TIMESTAMPTZ,
  ftd_amount      DECIMAL(18,2),
  ftd_date        TIMESTAMPTZ,
  -- CRM fields
  crm_owner       VARCHAR(255),
  crm_status      VARCHAR(100),
  pipeline_stage  VARCHAR(100),
  lead_source     VARCHAR(255),
  kyc_status      VARCHAR(50),
  account_status  VARCHAR(50),
  internal_flags  JSONB DEFAULT '{}',
  -- Field presence tracking
  field_status    JSONB DEFAULT '{}',   -- {fieldName: 'present'|'empty'|'not_requested'...}
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_ext_fields_user ON user_external_fields(user_id);

-- External ID mappings (user ↔ external system IDs)
CREATE TABLE user_source_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_source_id  UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  external_id     VARCHAR(500) NOT NULL,
  external_url    VARCHAR(1000),
  label           VARCHAR(100),           -- 'sheet_row_42', 'crm_contact', 'db_record'
  synced_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(data_source_id, external_id)
);

CREATE INDEX idx_source_links_user   ON user_source_links(user_id);
CREATE INDEX idx_source_links_source ON user_source_links(data_source_id);

-- ─────────────────────────────────────────────────────────────
-- VIP GROUPS CRM
-- ─────────────────────────────────────────────────────────────

CREATE TABLE vip_groups (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(255) NOT NULL,            -- internal name, e.g. "Signals DE VIP"
  telegram_group_id VARCHAR(100) UNIQUE NOT NULL,     -- Telegram chat_id (negative number)
  telegram_name     VARCHAR(255),                     -- display name in Telegram
  group_type        VARCHAR(20) DEFAULT 'supergroup', -- 'group'|'supergroup'|'channel'
  brand             VARCHAR(100),                     -- e.g. 'Phenex'
  structure_id      VARCHAR(100),                     -- Tauro structure link
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- Stats (updated by sync job)
  total_invites_sent    INTEGER DEFAULT 0,
  total_invites_redeemed INTEGER DEFAULT 0,
  total_members         INTEGER DEFAULT 0,
  total_banned          INTEGER DEFAULT 0,
  -- Config
  invite_expiry_hours   INTEGER DEFAULT 24,
  require_mini_app      BOOLEAN NOT NULL DEFAULT true,
  auto_backsync         BOOLEAN NOT NULL DEFAULT true,
  notes                 TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vip_groups_active ON vip_groups(is_active);

-- Mini App submissions (per user session, before full verification)
CREATE TABLE mini_app_submissions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  -- Raw form data (partial OK – not all fields required)
  telegram_id     BIGINT,
  telegram_username VARCHAR(255),
  telegram_name   VARCHAR(255),
  first_name      VARCHAR(255),
  last_name       VARCHAR(255),
  email           VARCHAR(255),
  phone           VARCHAR(50),
  country         VARCHAR(10),
  language        VARCHAR(10),
  broker_client_id VARCHAR(100),
  broker_account_id VARCHAR(100),
  referral_code   VARCHAR(100),
  custom_fields   JSONB DEFAULT '{}',      -- any extra fields from the form
  -- Target group (which VIP group this submission is for)
  target_vip_group_id UUID REFERENCES vip_groups(id),
  -- Status
  is_complete     BOOLEAN NOT NULL DEFAULT false,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      VARCHAR(45),
  user_agent      TEXT
);

CREATE INDEX idx_submissions_user    ON mini_app_submissions(user_id);
CREATE INDEX idx_submissions_tg      ON mini_app_submissions(telegram_id);
CREATE INDEX idx_submissions_group   ON mini_app_submissions(target_vip_group_id);
CREATE INDEX idx_submissions_at      ON mini_app_submissions(submitted_at DESC);

-- Invite links (one per user per group, unique and trackable)
CREATE TABLE invite_links (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vip_group_id      UUID NOT NULL REFERENCES vip_groups(id),
  submission_id     UUID REFERENCES mini_app_submissions(id),
  -- Telegram link data
  telegram_link     VARCHAR(500) NOT NULL,
  telegram_link_id  VARCHAR(255),          -- Telegram's internal invite link name
  -- Status
  status            invite_status NOT NULL DEFAULT 'created',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,
  redeemed_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID REFERENCES admins(id),
  -- Who redeemed (might differ from intended user)
  redeemed_by_telegram_id BIGINT,
  is_mismatch       BOOLEAN DEFAULT false,  -- if redeemed by different TG user
  mismatch_notes    TEXT,
  -- Member limit (Telegram allows 1 per link)
  member_limit      SMALLINT DEFAULT 1,
  -- Source
  created_by_rule   UUID REFERENCES rules(id),
  created_by_admin  UUID REFERENCES admins(id)
);

CREATE INDEX idx_invite_links_user   ON invite_links(user_id);
CREATE INDEX idx_invite_links_group  ON invite_links(vip_group_id);
CREATE INDEX idx_invite_links_status ON invite_links(status);

-- Join events (when a user actually joins the group)
CREATE TABLE join_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  vip_group_id    UUID NOT NULL REFERENCES vip_groups(id),
  invite_link_id  UUID REFERENCES invite_links(id),
  telegram_user_id BIGINT NOT NULL,
  telegram_username VARCHAR(255),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at         TIMESTAMPTZ,
  leave_reason    VARCHAR(50),            -- 'voluntary'|'kicked'|'banned'|'link_revoked'
  is_active       BOOLEAN NOT NULL DEFAULT true,
  raw_telegram_event JSONB
);

CREATE INDEX idx_join_events_user   ON join_events(user_id);
CREATE INDEX idx_join_events_group  ON join_events(vip_group_id);
CREATE INDEX idx_join_events_tgid   ON join_events(telegram_user_id);

-- Backsync events (push join/status info back to CRMs)
CREATE TABLE backsync_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_source_id  UUID NOT NULL REFERENCES data_sources(id),
  event_type      VARCHAR(100) NOT NULL,   -- 'vip_joined'|'vip_left'|'status_changed'|'note_added'
  vip_group_id    UUID REFERENCES vip_groups(id),
  join_event_id   UUID REFERENCES join_events(id),
  -- What was sent
  payload         JSONB NOT NULL,
  -- Status
  status          backsync_status NOT NULL DEFAULT 'pending',
  attempts        SMALLINT DEFAULT 0,
  max_attempts    SMALLINT DEFAULT 3,
  sent_at         TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  last_error      TEXT,
  -- External response
  external_ref    VARCHAR(255),           -- ID returned by CRM (e.g. Kommo note ID)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backsync_user    ON backsync_events(user_id);
CREATE INDEX idx_backsync_source  ON backsync_events(data_source_id);
CREATE INDEX idx_backsync_status  ON backsync_events(status);
CREATE INDEX idx_backsync_retry   ON backsync_events(next_retry_at) WHERE status IN ('pending','retrying','failed');

-- ─────────────────────────────────────────────────────────────
-- UPDATED_AT TRIGGERS
-- ─────────────────────────────────────────────────────────────

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['data_sources','vip_groups'] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      tbl, tbl
    );
  END LOOP;
END;
$$;
