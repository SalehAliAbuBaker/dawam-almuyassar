-- Additive staging migration: manager-approved monthly MB10 adherence (no payroll postings).
CREATE TABLE IF NOT EXISTS finance_attendance_ratings (
 organization_id TEXT NOT NULL,
 employee_id TEXT NOT NULL,
 effective_month TEXT NOT NULL,
 percentage REAL NOT NULL CHECK(percentage BETWEEN 0 AND 100),
 points REAL NOT NULL CHECK(points BETWEEN 0 AND 25),
 reviewed_by TEXT NOT NULL,
 review_note TEXT NOT NULL,
 source_event_count INTEGER NOT NULL,
 approved_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(organization_id,employee_id,effective_month)
);
CREATE INDEX IF NOT EXISTS finance_attendance_rating_month
 ON finance_attendance_ratings(organization_id,effective_month);
