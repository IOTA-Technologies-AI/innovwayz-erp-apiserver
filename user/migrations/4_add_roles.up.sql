-- Add role to users table
-- Roles: super_admin, admin, manager, user
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('super_admin', 'admin', 'manager', 'user'));

-- First registered user (the earliest created_at) becomes super_admin
UPDATE users
SET role = 'super_admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);
