-- دوام الميسر 0.2.0 | Phase 1: foundational data model.
-- Run only against an isolated staging D1 database. No real worker/employee data here.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  device_user_id TEXT,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'regular' CHECK(type IN ('regular','trial','task')),
  basic_salary REAL NOT NULL DEFAULT 0 CHECK(basic_salary >= 0),
  transport_allowance REAL NOT NULL DEFAULT 0 CHECK(transport_allowance >= 0),
  daily_incentive REAL NOT NULL DEFAULT 0 CHECK(daily_incentive >= 0),
  evening_amount REAL NOT NULL DEFAULT 0 CHECK(evening_amount >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id,code)
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_device_user_unique ON employees(organization_id,device_user_id) WHERE device_user_id IS NOT NULL AND device_user_id <> '';
CREATE INDEX IF NOT EXISTS employees_org_department ON employees(organization_id,department,status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  employee_id TEXT REFERENCES employees(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','accountant','supervisor','viewer')),
  department_scope TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK(password_iterations >= 210000),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id,email)
);
CREATE INDEX IF NOT EXISTS users_org_role ON users(organization_id,role,is_active);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  crosses_midnight INTEGER NOT NULL DEFAULT 0 CHECK(crosses_midnight IN (0,1)),
  grace_minutes INTEGER NOT NULL DEFAULT 0 CHECK(grace_minutes >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(organization_id,name)
);

CREATE TABLE IF NOT EXISTS shift_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX IF NOT EXISTS shift_assignments_employee ON shift_assignments(organization_id,employee_id,valid_from);

CREATE TABLE IF NOT EXISTS punch_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('in','out','other')),
  source TEXT NOT NULL CHECK(source IN ('manual','device','import','demo')),
  device_id TEXT,
  device_event_id TEXT,
  imported_batch_id TEXT,
  entered_by TEXT REFERENCES users(id),
  correction_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS punch_device_event_unique ON punch_events(organization_id,device_id,device_event_id) WHERE device_id IS NOT NULL AND device_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS punch_employee_time ON punch_events(organization_id,employee_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS punch_org_time ON punch_events(organization_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  leave_type TEXT NOT NULL CHECK(leave_type IN ('annual','sick','emergency','permission','other')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  minutes INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS leave_employee_dates ON leave_requests(organization_id,employee_id,starts_at);

CREATE TABLE IF NOT EXISTS evening_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  assigned_date TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  approved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','closed')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id,date_from,date_to),
  CHECK(date_to >= date_from)
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  period_id TEXT NOT NULL REFERENCES payroll_periods(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  item_type TEXT NOT NULL,
  amount REAL NOT NULL,
  source_reference TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payroll_items_period ON payroll_items(organization_id,period_id,employee_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  actor_user_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_org_time ON audit_events(organization_id,occurred_at DESC);
