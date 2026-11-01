-- دوام الميسر stage 0.2.27 | finance groundwork
-- Additive only. Does not alter punch, employee, payroll or historical payment tables.
-- The Finance API also uses CREATE TABLE IF NOT EXISTS to initialize staging on first access.
CREATE TABLE IF NOT EXISTS finance_policies (
 organization_id TEXT PRIMARY KEY,policy_json TEXT NOT NULL,updated_by TEXT,
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_profiles (
 organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,
 hire_date TEXT,family_count INTEGER,salary_override REAL,transport_override REAL,
 company_insurance REAL,total_insurance REAL,income_tax REAL,
 rank TEXT NOT NULL DEFAULT 'none',duty TEXT NOT NULL DEFAULT 'none',
 achievement_bonus REAL NOT NULL DEFAULT 0,updated_by TEXT,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(organization_id,employee_id),FOREIGN KEY(employee_id) REFERENCES employees(id)
);
CREATE TABLE IF NOT EXISTS finance_evaluations (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,
 effective_month TEXT NOT NULL,scores_json TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',
 approved_by TEXT NOT NULL,approved_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(organization_id,employee_id,effective_month)
);
CREATE TABLE IF NOT EXISTS finance_extras (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,
 work_date TEXT NOT NULL,task TEXT NOT NULL,
 amount REAL NOT NULL CHECK(amount>=3000 AND amount<=7000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_by TEXT NOT NULL,approved_by TEXT,approved_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS finance_extras_emp_date ON finance_extras(organization_id,employee_id,work_date);
CREATE INDEX IF NOT EXISTS finance_eval_emp_month ON finance_evaluations(organization_id,employee_id,effective_month);
