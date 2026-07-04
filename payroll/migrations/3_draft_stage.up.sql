-- Add a 'draft' stage so generated salaries can be amended before being posted.
ALTER TABLE salary_payments DROP CONSTRAINT IF EXISTS salary_payments_status_check;
ALTER TABLE salary_payments ADD CONSTRAINT salary_payments_status_check
  CHECK (status IN ('draft', 'pending_manager', 'pending_admin', 'approved', 'processing', 'paid', 'rejected', 'cancelled'));

ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS posted_by  TEXT;
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS posted_at  TIMESTAMPTZ;
