-- Dawam Al-Muyassar phase 2: raw device punches, staging only.
-- Run after 0001_foundation.sql; does not alter existing attendance or payroll.
CREATE TABLE IF NOT EXISTS biometric_devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  device_ip_hint TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Aden',
  time_authority TEXT NOT NULL DEFAULT 'device' CHECK(time_authority='device'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS device_raw_punches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  device_id TEXT NOT NULL REFERENCES biometric_devices(id),
  event_fingerprint TEXT NOT NULL,
  device_user_id TEXT NOT NULL,
  occurred_at_device TEXT NOT NULL,
  status_code INTEGER,
  punch_code INTEGER,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  matched_employee_id TEXT REFERENCES employees(id),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','matched','ambiguous','ignored')),
  UNIQUE(organization_id,device_id,event_fingerprint)
);
CREATE INDEX IF NOT EXISTS device_raw_unmatched ON device_raw_punches(organization_id,review_state,occurred_at_device);
CREATE INDEX IF NOT EXISTS device_raw_user_time ON device_raw_punches(organization_id,device_id,device_user_id,occurred_at_device);
-- Event fingerprints identify device + raw fields, not just the time. Exact identical
-- punches may be collapsed; distinguish only when the device supplies a stable event ID.
