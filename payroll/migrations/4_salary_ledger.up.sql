-- Salary → Corp Finance ledger posting.
-- salary_account: which expense account a paid salary debits (Cr 11100 Cash).
--   Placed/outsourced resources (have a client) → 51100 (Contracted Resource
--   Payroll, COGS); internal/management (no client) → 52100 (Executive Salaries).
-- pay_batch_ref: set when the row's payment has been posted to the ledger; also
--   the idempotency marker so a payment is never double-posted.
ALTER TABLE salary_payments
  ADD COLUMN IF NOT EXISTS salary_account VARCHAR(5) NOT NULL DEFAULT '51100';

UPDATE salary_payments
  SET salary_account = CASE WHEN customer_id IS NULL THEN '52100' ELSE '51100' END;

ALTER TABLE salary_payments
  ADD COLUMN IF NOT EXISTS pay_batch_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_salary_payments_pay_batch
  ON salary_payments (pay_batch_ref);
