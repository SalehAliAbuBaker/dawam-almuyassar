-- Worker-owned, opt-in Web Push subscriptions for individual attendance notices.
-- All data belongs to an authenticated user, never matched by full name.
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 employee_id TEXT NOT NULL REFERENCES employees(id),
 endpoint TEXT NOT NULL,
 p256dh TEXT NOT NULL,
 auth_secret TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(organization_id,user_id,endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_active_worker ON push_subscriptions(organization_id,employee_id);
CREATE TABLE IF NOT EXISTS push_notification_deliveries (
 organization_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 attendance_day TEXT NOT NULL,
 alert_code TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('sending','sent','failed')),
 attempts INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(organization_id,subscription_id,attendance_day,alert_code)
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_recent ON push_notification_deliveries(organization_id,attendance_day);
