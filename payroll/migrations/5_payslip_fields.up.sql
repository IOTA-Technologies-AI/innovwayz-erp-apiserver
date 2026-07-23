-- =============================================================
-- Migration 5: Per-period payslip fields on salary_payments
--
-- These populate the InnovWayz payslip for a given pay period.
-- The authoritative payable figure remains net_amount / deductions
-- (unchanged) — the itemized deduction columns below are the
-- breakdown printed on the payslip, and the create/update endpoints
-- keep `deductions` in sync as their sum.
--   attendance_days             – days present
--   government_holidays         – paid public holidays in the period
--   annual_leaves / sick_leaves – leave days taken in the period
--   loss_of_pay_days            – unpaid leave days (drives LOP amount)
--   days_payable                – payroll days in the month (default 30)
--   pay_date                    – salary disbursement date
--   remote_work_half            – 50%-salary remote arrangement applied
--   salary_advance              – advance recovered this period
--   employee_requests_deduction – CoC / Exit-Re-Entry etc. recovered
-- =============================================================

ALTER TABLE salary_payments
  ADD COLUMN attendance_days             INTEGER,
  ADD COLUMN government_holidays         INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN annual_leaves               NUMERIC(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN sick_leaves                 NUMERIC(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN loss_of_pay_days            NUMERIC(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN days_payable                INTEGER       NOT NULL DEFAULT 30,
  ADD COLUMN pay_date                    DATE,
  ADD COLUMN remote_work_half            BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN salary_advance              NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN employee_requests_deduction NUMERIC(12,2) NOT NULL DEFAULT 0;
