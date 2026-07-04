-- Add 'finance' role to the allowed roles.
-- Roles: super_admin, admin, manager, finance, user
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'manager', 'finance', 'user'));
