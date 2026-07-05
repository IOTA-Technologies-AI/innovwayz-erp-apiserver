-- Track when a session was last used (for inactivity timeout).
-- Sessions inactive for more than 6 hours are considered locked.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Back-fill existing rows so they don't immediately lock
UPDATE sessions SET last_active_at = NOW();

CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions (last_active_at);
