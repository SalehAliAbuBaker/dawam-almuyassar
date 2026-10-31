-- Granular user permissions, grant/deny; no existing user record is changed.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 permission_key TEXT NOT NULL,
 allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(organization_id,user_id,permission_key)
);
CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user ON user_permission_overrides(organization_id,user_id);
