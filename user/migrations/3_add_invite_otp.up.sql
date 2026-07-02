-- users: track invite/activation status
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Invite-only registration tokens
CREATE TABLE IF NOT EXISTS invitations (
    token        TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    accepted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email);

-- Email OTP codes for 2-FA
CREATE TABLE IF NOT EXISTS otp_codes (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    code        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes (email);
