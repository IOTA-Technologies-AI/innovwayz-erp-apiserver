-- =============================================================
-- Migration 6: Employee payslip identity fields
--   Static per-employee attributes printed on the payslip that
--   are not derivable from existing data:
--     national_id  – government ID / Iqama number ("ID #")
--     band         – internal grade/band (e.g. "A2")
--     location     – duty station (defaults to Riyadh, KSA)
--     payment_mode – salary disbursement mode (defaults to Bank Transfer)
-- =============================================================

ALTER TABLE employees
  ADD COLUMN national_id  TEXT,
  ADD COLUMN band         TEXT,
  ADD COLUMN location     TEXT,
  ADD COLUMN payment_mode TEXT;
