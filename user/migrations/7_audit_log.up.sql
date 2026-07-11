-- =========================================================================
-- USER SERVICE — Audit Log & System Settings
-- Separate audit_log table for all user activity tracking.
-- system_settings controls logging verbosity per environment.
-- =========================================================================

-- ── Audit Log ─────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
    id           TEXT         PRIMARY KEY,
    user_id      TEXT,                       -- NULL for pre-auth events
    user_email   TEXT,
    user_name    TEXT,
    action       TEXT         NOT NULL,      -- login | logout | invite_sent | page_denied | permission_changed | session_flushed | password_set | login_failed
    resource     TEXT,                       -- URL path or entity acted on
    details      TEXT,                       -- JSON: additional context
    ip_address   TEXT,
    user_agent   TEXT,
    result       TEXT         NOT NULL DEFAULT 'success',  -- success | denied | error
    log_level    TEXT         NOT NULL DEFAULT 'info',     -- info | debug | verbose
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user    ON audit_log(user_id);
CREATE INDEX idx_audit_log_action  ON audit_log(action);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_result  ON audit_log(result);

-- ── System Settings ────────────────────────────────────────────────────────
-- key/value store for runtime-configurable ERP behaviour.
CREATE TABLE system_settings (
    key        TEXT         PRIMARY KEY,
    value      TEXT         NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed defaults
INSERT INTO system_settings (key, value) VALUES
    ('audit_log_level', 'production')   -- production | debug | verbose
ON CONFLICT (key) DO NOTHING;
