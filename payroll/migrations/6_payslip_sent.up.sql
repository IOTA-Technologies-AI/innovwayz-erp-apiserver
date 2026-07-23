-- =============================================================
-- Migration 6: Track payslip email delivery
--   payslip_sent_at — timestamp the employee's payslip PDF was emailed
--   after this salary was marked paid. Guards against re-sending on a
--   repeated pay/reconcile of the same row (once per employee per period).
-- =============================================================

ALTER TABLE salary_payments
  ADD COLUMN payslip_sent_at TIMESTAMPTZ;
