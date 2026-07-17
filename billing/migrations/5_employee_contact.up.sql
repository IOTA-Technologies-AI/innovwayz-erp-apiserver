-- =============================================================
-- Migration 5: Employee contact details
--   Needed for the self-service timesheet portal, where employees
--   authenticate with their registered mobile number (OTP) and may
--   receive notifications by email.
--   mobile_number is stored in E.164 format (e.g. +9665XXXXXXXX).
-- =============================================================

ALTER TABLE employees
  ADD COLUMN mobile_number TEXT,
  ADD COLUMN email         TEXT;

-- Fast, case-insensitive lookup by mobile for portal login.
CREATE UNIQUE INDEX idx_employees_mobile
  ON employees (mobile_number)
  WHERE mobile_number IS NOT NULL;
