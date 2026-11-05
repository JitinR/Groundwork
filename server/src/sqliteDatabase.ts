import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";
import { migrateTotpSeeds } from "./mfa.js";
import { ENGINEERING_SCHEMA_SQLITE } from "./engineeringSchema.js";

const raw = new DatabaseSync(DB_PATH);
raw.exec(ENGINEERING_SCHEMA_SQLITE);

raw.exec("PRAGMA journal_mode = WAL;");
raw.exec("PRAGMA foreign_keys = ON;");
raw.exec("PRAGMA secure_delete = ON;");
raw.exec("PRAGMA busy_timeout = 5000;");

raw.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  otp_code_hash TEXT,
  otp_expires_at INTEGER,
  otp_attempts  INTEGER NOT NULL DEFAULT 0,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  last_login_at INTEGER,
  password_changed_at INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_token    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | pending_2fa | revoked
  user_agent    TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS secrets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secrets_user ON secrets(user_id);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'house',
  design_data TEXT,
  width_mm    INTEGER NOT NULL DEFAULT 6000,
  depth_mm    INTEGER NOT NULL DEFAULT 4000,
  photo_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
  ,revision   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_revisions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  design_data TEXT NOT NULL,
  project_type TEXT NOT NULL,
  width_mm    INTEGER NOT NULL,
  depth_mm    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_revisions_project ON project_revisions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_share_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_share_links_project ON project_share_links(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_collaboration_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_collaboration_events_project ON project_collaboration_events(project_id, id DESC);

CREATE TABLE IF NOT EXISTS project_collaboration_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_collaboration_items_project ON project_collaboration_items(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('editor','viewer')),
  invited_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_locks (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_project_locks_expiry ON project_locks(expires_at);

CREATE TABLE IF NOT EXISTS project_operations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id    TEXT NOT NULL,
  base_revision   INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(project_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_project_operations_project ON project_operations(project_id, id DESC);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  seat_limit INTEGER NOT NULL DEFAULT 5 CHECK(seat_limit BETWEEN 1 AND 10000),
  audit_retention_days INTEGER NOT NULL DEFAULT 365 CHECK(audit_retention_days BETWEEN 30 AND 3650),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_owner ON organization_members(organization_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);
CREATE TABLE IF NOT EXISTS organization_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_organization_audit_org ON organization_audit(organization_id,id DESC);
CREATE TABLE IF NOT EXISTS organization_sso (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  secret_encrypted TEXT,
  redirect_uri TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  configuration_revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_sso_identities (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(organization_id,issuer,subject),
  UNIQUE(organization_id,user_id)
);
CREATE TABLE IF NOT EXISTS organization_sso_flows (
  state_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  browser_hash TEXT NOT NULL,
  verifier_encrypted TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  linking_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_presence (
  connection_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_presence_project ON project_presence(project_id,expires_at);
CREATE TABLE IF NOT EXISTS project_sync_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  logical_clock INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id,operation_id)
);
CREATE INDEX IF NOT EXISTS idx_project_sync_sequence ON project_sync_operations(project_id,sequence);
CREATE TABLE IF NOT EXISTS project_workspace_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('engineering','exchange','geometry')),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 67108864),
  sha256 TEXT NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(id,project_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_project ON project_workspace_artifacts(project_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS project_workspace_snapshots (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('engineering','exchange','geometry')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  payload_artifact_id TEXT NOT NULL,
  referenced_artifact_ids TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_id,kind,revision),
  FOREIGN KEY(payload_artifact_id,project_id,kind) REFERENCES project_workspace_artifacts(id,project_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_payload ON project_workspace_snapshots(payload_artifact_id,project_id,kind);
CREATE TABLE IF NOT EXISTS project_workspace_artifact_refs (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(project_id,kind,revision,artifact_id),
  FOREIGN KEY(project_id,kind,revision) REFERENCES project_workspace_snapshots(project_id,kind,revision) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id,project_id,kind) REFERENCES project_workspace_artifacts(id,project_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_workspace_artifact_refs_artifact ON project_workspace_artifact_refs(artifact_id,project_id,kind);
CREATE TABLE IF NOT EXISTS project_workspaces (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('engineering','exchange','geometry')),
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  PRIMARY KEY(project_id,kind),
  FOREIGN KEY(project_id,kind,current_revision) REFERENCES project_workspace_snapshots(project_id,kind,revision)
);
CREATE TABLE IF NOT EXISTS project_native_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('dwg-to-dxf','dxf-to-dwg','opensees-static')),
  workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('engineering','exchange')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
  input_artifact_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_workspace_revision INTEGER,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  claim_token TEXT,
  claim_until INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  summary_json TEXT,
  UNIQUE(project_id,created_by,idempotency_key),
  UNIQUE(id,project_id,workspace_kind),
  FOREIGN KEY(input_artifact_id,project_id,workspace_kind) REFERENCES project_workspace_artifacts(id,project_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_native_jobs_due ON project_native_jobs(state,claim_until,created_at,id);
CREATE INDEX IF NOT EXISTS idx_native_jobs_project ON project_native_jobs(project_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_native_jobs_scoped_queue ON project_native_jobs(project_id,state,kind,created_at,id);
CREATE TABLE IF NOT EXISTS project_native_job_artifacts (
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(job_id,artifact_id),
  FOREIGN KEY(job_id,project_id,workspace_kind) REFERENCES project_native_jobs(id,project_id,workspace_kind) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id,project_id,workspace_kind) REFERENCES project_workspace_artifacts(id,project_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_native_job_artifacts_artifact ON project_native_job_artifacts(artifact_id,project_id);
CREATE TABLE IF NOT EXISTS native_worker_outputs (
  job_id TEXT NOT NULL REFERENCES project_native_jobs(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK(output_index BETWEEN 0 AND 7),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1 AND 33554432),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=total_bytes),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,claim_token,output_index),
  UNIQUE(job_id,claim_token,filename)
);
CREATE INDEX IF NOT EXISTS idx_native_worker_outputs_expiry ON native_worker_outputs(expires_at);
CREATE TABLE IF NOT EXISTS native_worker_output_chunks (
  job_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  chunk_offset INTEGER NOT NULL CHECK(chunk_offset>=0 AND chunk_offset<33554432),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 262144),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  iv BLOB NOT NULL CHECK(length(iv)=12),
  tag BLOB NOT NULL CHECK(length(tag)=16),
  ciphertext BLOB NOT NULL CHECK(length(ciphertext)=byte_length),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,claim_token,output_index,chunk_offset),
  FOREIGN KEY(job_id,claim_token,output_index) REFERENCES native_worker_outputs(job_id,claim_token,output_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_native_worker_chunks_expiry ON native_worker_output_chunks(expires_at);
CREATE TABLE IF NOT EXISTS project_event_outbox (
  event_id INTEGER PRIMARY KEY REFERENCES project_collaboration_events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claim_owner TEXT,
  claim_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_project_event_outbox_due ON project_event_outbox(next_attempt_at,claim_until,event_id);
CREATE TABLE IF NOT EXISTS project_sync_registers (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  logical_clock INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY(project_id,entity_id,field)
);

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  method        TEXT NOT NULL,
  plan          TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | failed
  provider_order_id TEXT,
  provider_url  TEXT,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_subscriptions (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL CHECK(status IN ('active', 'past_due', 'canceled', 'unpaid', 'trialing')),
  base_seats INTEGER NOT NULL DEFAULT 5,
  paid_seats INTEGER NOT NULL DEFAULT 0,
  total_seats INTEGER NOT NULL DEFAULT 5,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'demo',
  provider_subscription_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_transitions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK(action IN ('subscribe', 'seat_change', 'renew', 'cancel', 'reactivate', 'expire', 'payment_failed')),
  previous_state TEXT,
  new_state TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_transitions_org ON billing_transitions(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_image_artifact_id TEXT NOT NULL REFERENCES project_workspace_artifacts(id) ON DELETE CASCADE,
  source_image_sha256 TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  style_preset TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unconfigured')),
  output_artifact_id TEXT REFERENCES project_workspace_artifacts(id) ON DELETE SET NULL,
  output_sha256 TEXT,
  error_code TEXT,
  error_message TEXT,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON project_render_jobs(project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON project_render_jobs(status, created_at);

-- Immutable priced intents precede any provider request. A lost response is
-- retained for reconciliation instead of creating a second charge blindly.
CREATE TABLE IF NOT EXISTS tenant_billing_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(plan = 'standard'),
  target_paid_seats INTEGER NOT NULL CHECK(target_paid_seats BETWEEN 1 AND 9999),
  base_seats INTEGER NOT NULL CHECK(base_seats BETWEEN 1 AND 5),
  unit_price INTEGER NOT NULL CHECK(unit_price > 0),
  amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 100000000),
  currency TEXT NOT NULL CHECK(currency = 'INR'),
  term_days INTEGER NOT NULL CHECK(term_days BETWEEN 1 AND 365),
  base_subscription_revision INTEGER NOT NULL,
  merchant_account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'razorpay'),
  provider_link_id TEXT,
  checkout_url TEXT,
  status TEXT NOT NULL CHECK(status IN ('creating','pending','creation_unknown','failed','verified','requires_review','expired')),
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(organization_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_billing_open ON tenant_billing_orders(organization_id)
  WHERE status IN ('creating','pending','creation_unknown');
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_billing_link ON tenant_billing_orders(provider_link_id) WHERE provider_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_billing_history ON tenant_billing_orders(organization_id,created_at DESC);
CREATE TABLE IF NOT EXISTS payment_receipts (
  provider TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  payment_id TEXT NOT NULL UNIQUE,
  provider_order_id TEXT NOT NULL,
  merchant_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('applied','requires_review')),
  reason TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(provider, receipt_id)
);
`);

/* Lightweight migrations for pre-existing databases */
const userCols = (raw.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
const authUserMigrations: [string, string][] = [
  ["credential_version", "INTEGER NOT NULL DEFAULT 0"],
  ["totp_failed_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["totp_attempt_window_start", "INTEGER"],
  ["totp_locked_until", "INTEGER"],
  ["totp_last_used_step", "INTEGER"],
];
const sessionCols = (raw.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
raw.exec("BEGIN IMMEDIATE");
try {
  for (const [name, definition] of authUserMigrations) {
    if (!userCols.includes(name)) raw.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
  if (!sessionCols.includes("credential_version")) {
    raw.exec("ALTER TABLE sessions ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0");
    // Legacy pending challenges have no reliable credential epoch and must be restarted.
    raw.prepare("UPDATE sessions SET status='revoked',revoked_at=? WHERE status='pending_2fa'").run(Math.floor(Date.now() / 1000));
  }
  if (!sessionCols.includes("totp_attempts")) raw.exec("ALTER TABLE sessions ADD COLUMN totp_attempts INTEGER NOT NULL DEFAULT 0");
  migrateTotpSeeds(raw);
  raw.exec("COMMIT");
} catch (error) {
  raw.exec("ROLLBACK");
  raw.close();
  throw error;
}
raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
if (!userCols.includes("plan")) {
  raw.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';");
}
if (!userCols.includes("plan_expires_at")) {
  raw.exec("ALTER TABLE users ADD COLUMN plan_expires_at INTEGER;");
}
if (!userCols.includes("country")) {
  raw.exec("ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT 'IN';");
}
if (!userCols.includes("phone")) {
  raw.exec("ALTER TABLE users ADD COLUMN phone TEXT;");
}
if (!userCols.includes("account_type")) {
  raw.exec("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'individual';");
}
if (!userCols.includes("gstin")) {
  raw.exec("ALTER TABLE users ADD COLUMN gstin TEXT;");
}
/* OTP email verification (new column; default 1 grandfathers pre-existing accounts) */
if (!userCols.includes("username")) {
  raw.exec("ALTER TABLE users ADD COLUMN username TEXT;");
}
if (!userCols.includes("email_verified")) {
  raw.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;");
}
if (!userCols.includes("otp_code_hash")) {
  raw.exec("ALTER TABLE users ADD COLUMN otp_code_hash TEXT;");
}
if (!userCols.includes("otp_expires_at")) {
  raw.exec("ALTER TABLE users ADD COLUMN otp_expires_at INTEGER;");
}
if (!userCols.includes("otp_attempts")) {
  raw.exec("ALTER TABLE users ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0;");
}
raw.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL AND username != '';",
);

const projectCols = (raw.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
if (!projectCols.includes("project_type")) {
  raw.exec("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'house';");
}
if (!projectCols.includes("revision")) {
  raw.exec("ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;");
}
if (!projectCols.includes("folder")) {
  raw.exec("ALTER TABLE projects ADD COLUMN folder TEXT NOT NULL DEFAULT '';");
}
if (!projectCols.includes("archived")) {
  raw.exec("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;");
}
if (!projectCols.includes("is_template")) {
  raw.exec("ALTER TABLE projects ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;");
}
if (!projectCols.includes("organization_id")) {
  raw.exec("ALTER TABLE projects ADD COLUMN organization_id TEXT REFERENCES organizations(id);");
}
raw.exec("CREATE INDEX IF NOT EXISTS idx_projects_organization ON projects(organization_id,updated_at DESC);");
const flowCols = (raw.prepare("PRAGMA table_info(organization_sso_flows)").all() as { name: string }[]).map((column) => column.name);
if (!flowCols.includes("linking_user_id")) raw.exec("ALTER TABLE organization_sso_flows ADD COLUMN linking_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;");
const ssoCols = (raw.prepare("PRAGMA table_info(organization_sso)").all() as { name: string }[]).map((column) => column.name);
if (!ssoCols.includes("configuration_revision")) raw.exec("ALTER TABLE organization_sso ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 1;");
const paymentCols = (raw.prepare("PRAGMA table_info(payments)").all() as { name: string }[]).map((column) => column.name);
if (!paymentCols.includes("organization_id")) raw.exec("ALTER TABLE payments ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;");
raw.exec(`
  INSERT OR IGNORE INTO organization_subscriptions (organization_id, plan, status, base_seats, paid_seats, total_seats, current_period_start, current_period_end, cancel_at_period_end, provider, created_at, updated_at)
  SELECT id, 'standard', 'active', 5, 0, 5, created_at, created_at + 31536000, 0, 'demo', created_at, updated_at FROM organizations;
`);
const subscriptionCols = (raw.prepare("PRAGMA table_info(organization_subscriptions)").all() as { name: string }[]).map((column) => column.name);
if (!subscriptionCols.includes("entitlement_revision")) raw.exec("ALTER TABLE organization_subscriptions ADD COLUMN entitlement_revision INTEGER NOT NULL DEFAULT 0;");
if (!subscriptionCols.includes("verified_order_id")) raw.exec("ALTER TABLE organization_subscriptions ADD COLUMN verified_order_id TEXT REFERENCES tenant_billing_orders(id);");

raw.exec(`
  CREATE TABLE IF NOT EXISTS provider_daily_usage (
    scope TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope,kind,day)
  );
  CREATE TABLE IF NOT EXISTS provider_active_permits (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0,
    reserved_artifacts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS provider_permits_kind ON provider_active_permits(kind,user_id,expires_at);
  CREATE INDEX IF NOT EXISTS provider_permits_project ON provider_active_permits(project_id,expires_at);
`);

export type Db = typeof raw;
export const db: Db = raw;

/** Synchronous SQLite transaction for atomic revision and operation-log writes. */
let transactionDepth = 0;
export function withTransaction<T>(work: () => T): T {
  const depth = transactionDepth;
  const savepoint = `groundwork_nested_${depth}`;
  raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  transactionDepth += 1;
  try {
    const result = work();
    raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (depth === 0) raw.exec("ROLLBACK");
    else { raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); raw.exec(`RELEASE SAVEPOINT ${savepoint}`); }
    throw error;
  } finally {
    transactionDepth = depth;
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
