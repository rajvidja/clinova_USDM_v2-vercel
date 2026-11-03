import { db, tx } from './db.ts';

// Versioned, forward-only migrations on top of the baseline schema in db.ts. Existing records are never dropped.
// Each migration runs once, inside a transaction, and is recorded in schema_migrations.

interface Migration {
  version: number;
  name: string;
  up: () => void;
}

const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
const addColumn = (table: string, name: string, ddl: string) => {
  if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'users, roles, permissions and settings',
    up: () =>
      db.exec(`
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','DATA_STEWARD','PROTOCOL_AUTHOR','REVIEWER','VIEWER')),
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE TABLE user_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`),
  },
  {
    version: 2,
    name: 'append-only audit log',
    up: () =>
      db.exec(`
CREATE TABLE audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  study_id TEXT,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_study ON audit_logs(study_id, created_at);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
`),
  },
  {
    version: 3,
    name: 'lineage, element versions and data ownership',
    up: () =>
      db.exec(`
CREATE TABLE lineage_records (
  element_id TEXT PRIMARY KEY,
  element_type TEXT NOT NULL,
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL CHECK (source_type IN ('builder','digitisation','ocr','system')),
  source_document_id TEXT,
  source_page INTEGER,
  source_section TEXT,
  source_text TEXT,
  extraction_method TEXT NOT NULL,
  internal_entity_type TEXT NOT NULL,
  usdm_mapping_id TEXT,
  usdm_entity TEXT,
  usdm_run_id TEXT,
  created_by TEXT NOT NULL,
  modified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'Pending' CHECK (review_status IN ('Pending','Approved','Rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_lineage_protocol ON lineage_records(protocol_id, element_type);
CREATE INDEX idx_lineage_study ON lineage_records(study_id);
CREATE INDEX idx_lineage_modified ON lineage_records(modified_at);

CREATE TABLE element_versions (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  element_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','modified','deleted')),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  reason TEXT,
  change_request_id TEXT,
  frozen INTEGER NOT NULL DEFAULT 0,
  UNIQUE (element_id, version)
);
CREATE INDEX idx_element_versions_protocol ON element_versions(protocol_id, changed_at);

CREATE TABLE data_owners (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL DEFAULT '*',
  responsibility TEXT NOT NULL CHECK (responsibility IN ('Owner','Steward')),
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  UNIQUE (study_id, entity_type, responsibility)
);
`),
  },
  {
    version: 4,
    name: 'governance rules, quality results and issues',
    up: () =>
      db.exec(`
CREATE TABLE governance_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('completeness','consistency','validity','traceability')),
  severity TEXT NOT NULL CHECK (severity IN ('Critical','High','Medium','Low','Informational')),
  entity_type TEXT NOT NULL,
  check_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE governance_rule_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES governance_rules(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL,
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  executed_by TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  findings INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  error TEXT
);
CREATE INDEX idx_rule_runs_rule ON governance_rule_runs(rule_id, executed_at);
CREATE INDEX idx_rule_runs_run ON governance_rule_runs(run_id);
CREATE TABLE governance_issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('rule','manual')),
  study_id TEXT NOT NULL,
  protocol_id TEXT,
  element_id TEXT,
  element_type TEXT,
  rule_id TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Critical','High','Medium','Low','Informational')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  detected_value TEXT,
  expected_condition TEXT,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Assigned','In Progress','Resolved','Accepted Exception')),
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_detected_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution TEXT,
  exception_reason TEXT,
  exception_approved_by TEXT,
  exception_approved_at TEXT
);
CREATE INDEX idx_issues_study ON governance_issues(study_id, status);
CREATE INDEX idx_issues_protocol ON governance_issues(protocol_id, status);
CREATE TABLE governance_issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES governance_issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE data_quality_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  element_id TEXT,
  element_type TEXT,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_value TEXT,
  expected_condition TEXT,
  validated_at TEXT NOT NULL,
  issue_id TEXT,
  resolution_status TEXT NOT NULL,
  assigned_owner TEXT
);
CREATE INDEX idx_dq_results_run ON data_quality_results(run_id);
CREATE INDEX idx_dq_results_protocol ON data_quality_results(protocol_id, validated_at);
`),
  },
  {
    version: 5,
    name: 'protocol version approvals, change requests and approval records',
    up: () => {
      addColumn('protocol_versions', 'amendment_number', `amendment_number TEXT NOT NULL DEFAULT ''`);
      addColumn('protocol_versions', 'change_reason', `change_reason TEXT NOT NULL DEFAULT ''`);
      addColumn('protocol_versions', 'author_id', 'author_id TEXT');
      addColumn('protocol_versions', 'approval_status', `approval_status TEXT NOT NULL DEFAULT 'Recorded'`);
      addColumn('protocol_versions', 'approved_by', 'approved_by TEXT');
      addColumn('protocol_versions', 'approved_at', 'approved_at TEXT');
      addColumn('protocol_versions', 'change_request_id', 'change_request_id TEXT');
      addColumn('protocol_versions', 'content_hash', `content_hash TEXT NOT NULL DEFAULT ''`);
      addColumn('protocol_versions', 'mapping_snapshot_json', 'mapping_snapshot_json TEXT');
      db.exec(`
CREATE TRIGGER protocol_versions_approved_immutable BEFORE UPDATE ON protocol_versions
  WHEN OLD.approval_status = 'Approved'
  BEGIN SELECT RAISE(ABORT, 'Approved protocol versions cannot be modified'); END;
CREATE TRIGGER protocol_versions_approved_undeletable BEFORE DELETE ON protocol_versions
  WHEN OLD.approval_status = 'Approved'
  BEGIN SELECT RAISE(ABORT, 'Approved protocol versions cannot be deleted'); END;

CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  justification TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Draft','Pending Review','Approved','Rejected','Withdrawn')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  base_revision INTEGER NOT NULL,
  validation_json TEXT,
  diff_json TEXT,
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_comment TEXT,
  resulting_version_id TEXT
);
CREATE INDEX idx_change_requests_protocol ON change_requests(protocol_id, status);
CREATE TABLE approval_records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  study_id TEXT,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_entity ON approval_records(entity_type, entity_id);
CREATE TRIGGER approval_records_no_update BEFORE UPDATE ON approval_records BEGIN SELECT RAISE(ABORT, 'approval_records is append-only'); END;
CREATE TRIGGER approval_records_no_delete BEFORE DELETE ON approval_records BEGIN SELECT RAISE(ABORT, 'approval_records is append-only'); END;
`);
    },
  },
  {
    version: 6,
    name: 'data dictionary',
    up: () =>
      db.exec(`
CREATE TABLE data_dictionary (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL,
  permitted_values_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  owner_role TEXT NOT NULL DEFAULT '',
  entity_types_json TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  terminology_ref TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`),
  },
  {
    version: 7,
    name: 'USDM releases, mapping registry, terminology and exports',
    up: () =>
      db.exec(`
CREATE TABLE usdm_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema_location TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  root_schema TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  model_json TEXT,
  ct_json TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'Inactive' CHECK (status IN ('Active','Inactive')),
  is_selected INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE usdm_mapping_registry (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES usdm_releases(id),
  source_entity TEXT NOT NULL,
  source_field TEXT NOT NULL,
  target_entity TEXT,
  target_property TEXT,
  transformation_type TEXT NOT NULL CHECK (transformation_type IN ('direct','value','terminology','relationship','manual','unsupported')),
  rule_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('Not Mapped','Mapped','Requires Review','Validated','Rejected')),
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  scope_study_id TEXT,
  scope_element_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL CHECK (origin IN ('seed','user')),
  reviewer TEXT,
  reviewed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mapping_release ON usdm_mapping_registry(release_id, source_entity, active);
CREATE INDEX idx_mapping_scope ON usdm_mapping_registry(scope_study_id);
CREATE TABLE usdm_mapping_history (
  id TEXT PRIMARY KEY,
  mapping_id TEXT NOT NULL REFERENCES usdm_mapping_registry(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_mapping_history ON usdm_mapping_history(mapping_id, version);
CREATE TRIGGER usdm_mapping_history_no_update BEFORE UPDATE ON usdm_mapping_history BEGIN SELECT RAISE(ABORT, 'usdm_mapping_history is append-only'); END;
CREATE TRIGGER usdm_mapping_history_no_delete BEFORE DELETE ON usdm_mapping_history BEGIN SELECT RAISE(ABORT, 'usdm_mapping_history is append-only'); END;
CREATE TABLE usdm_terminology (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES usdm_releases(id),
  domain TEXT NOT NULL,
  source_value TEXT NOT NULL,
  source_terminology TEXT NOT NULL DEFAULT 'ProtocolIQ',
  target_codelist TEXT,
  target_code TEXT,
  target_decode TEXT,
  preferred_term TEXT,
  target_terminology TEXT,
  version TEXT,
  effective_date TEXT,
  match_basis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Not Mapped','Mapped','Requires Review','Validated','Rejected')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (release_id, domain, source_value)
);
CREATE TABLE usdm_mapping_runs (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES usdm_releases(id),
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  protocol_revision INTEGER NOT NULL,
  include_pending INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid','invalid')),
  output_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  schema_errors INTEGER NOT NULL,
  reference_errors INTEGER NOT NULL,
  unmapped INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'Pending Review' CHECK (review_status IN ('Pending Review','Approved','Rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_comment TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mapping_runs_protocol ON usdm_mapping_runs(protocol_id, created_at);
CREATE TABLE usdm_export_records (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES usdm_mapping_runs(id),
  release_id TEXT NOT NULL REFERENCES usdm_releases(id),
  release_version TEXT NOT NULL,
  study_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  protocol_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('exported','rejected')),
  conformance_label TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  file_sha256 TEXT,
  reason TEXT NOT NULL DEFAULT '',
  exported_by TEXT NOT NULL,
  exported_at TEXT NOT NULL
);
CREATE INDEX idx_exports_study ON usdm_export_records(study_id, exported_at);
`),
  },
];

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[]).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    tx(() => {
      m.up();
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)`).run(m.version, m.name, new Date().toISOString());
    });
  }
}

export const appliedMigrations = () => db.prepare(`SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version`).all();
