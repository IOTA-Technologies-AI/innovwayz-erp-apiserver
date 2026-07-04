-- Add a 'draft' stage plus recurring (standard monthly) expense templates.

-- 1. Allow 'draft' status (records amendable before being posted for approval).
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('draft', 'pending_manager', 'pending_admin', 'approved', 'processing', 'paid', 'rejected', 'cancelled'));

-- 2. Link generated expenses to their template + billing period (for dedup/reporting).
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_id  TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS period_month  INT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS period_year   INT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS posted_by     TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS posted_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_expenses_recurring ON expenses (recurring_id, period_year, period_month);

-- 3. Standard recurring expense templates (generated into drafts each month).
CREATE TABLE recurring_expenses (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    category          TEXT NOT NULL DEFAULT 'company'
                      CHECK (category IN ('employee', 'company')),
    expense_class     TEXT NOT NULL DEFAULT 'operational'
                      CHECK (expense_class IN ('petty', 'infrastructure', 'management', 'operational', 'employee', 'other')),
    expense_type_code TEXT,
    expense_type_name TEXT NOT NULL,
    employee_id       TEXT,
    employee_name     TEXT,
    customer_id       TEXT,
    customer_name     TEXT,
    description       TEXT,
    amount            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency          TEXT NOT NULL DEFAULT 'SAR',
    vendor            TEXT,
    payment_method    TEXT,
    day_of_month      INT NOT NULL DEFAULT 1,
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_by        TEXT NOT NULL,
    created_by_name   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_expenses_active ON recurring_expenses (active);
