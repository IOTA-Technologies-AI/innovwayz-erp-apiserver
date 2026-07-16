-- =============================================================
-- Migration 4: Salary component breakdown
--   Optional itemization of the monthly salary, mirroring the
--   InnovWayz payslip structure (Basic / HRA / Travel & Other).
--   When NULL, the salary is treated as a single gross amount.
-- =============================================================

ALTER TABLE salaries
  ADD COLUMN basic_amount        NUMERIC(12,2),
  ADD COLUMN housing_allowance   NUMERIC(12,2),
  ADD COLUMN transport_allowance NUMERIC(12,2),
  ADD COLUMN other_allowance     NUMERIC(12,2);
