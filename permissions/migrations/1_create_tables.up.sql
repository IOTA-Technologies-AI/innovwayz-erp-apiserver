-- One row per user storing their explicit allowed route list.
-- If no row exists, role-based defaults are used.
CREATE TABLE user_permissions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT UNIQUE NOT NULL,
    allowed_routes  TEXT[] NOT NULL DEFAULT '{}',
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON user_permissions (user_id);
