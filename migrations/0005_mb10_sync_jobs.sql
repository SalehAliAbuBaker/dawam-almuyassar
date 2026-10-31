-- MB10 on-demand sync jobs. Existing raw punch logs are unchanged.
CREATE TABLE IF NOT EXISTS mb10_sync_jobs (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','done','error')),
 requested_at TEXT NOT NULL DEFAULT (datetime('now')),
 started_at TEXT,
 finished_at TEXT,
 new_count INTEGER NOT NULL DEFAULT 0,
 duplicate_count INTEGER NOT NULL DEFAULT 0,
 error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_mb10_sync_jobs_org_state ON mb10_sync_jobs(organization_id,state,requested_at);
