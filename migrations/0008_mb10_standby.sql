-- MB10 stage 0.2.23: failover metadata only (no changes to raw punches/payroll).
-- Runtime creates these idempotently for backward-compatible stage deployment.
CREATE TABLE IF NOT EXISTS mb10_sync_agents (
 organization_id TEXT NOT NULL,
 agent_id TEXT NOT NULL CHECK(agent_id IN ('primary','backup')),
 last_seen TEXT NOT NULL,
 device_ready INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,agent_id)
);
CREATE TABLE IF NOT EXISTS mb10_sync_job_owners (
 job_id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 agent_id TEXT NOT NULL CHECK(agent_id IN ('primary','backup')),
 last_heartbeat TEXT NOT NULL
);
