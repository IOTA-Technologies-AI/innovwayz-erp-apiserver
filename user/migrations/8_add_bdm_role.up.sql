-- Add 'bdm' (Business Development Manager) role.
-- BDMs have access only to Sales pages and see only their own deals/contacts.
-- Roles: super_admin, admin, manager, finance, user, bdm
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'manager', 'finance', 'user', 'bdm'));
