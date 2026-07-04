-- ─── Salary / Payroll processing ──────────────────────────────────────────────
-- Monthly salary runs per employee with an approval + finance-processing
-- workflow that mirrors the expense module.
--
-- status flow: pending_manager → pending_admin → approved → processing → paid
--              (rejected / cancelled are terminal)
--
-- Employee/customer are denormalized snapshots (the HR master lives in the
-- billing service; there is no shared database across Encore services).
CREATE TABLE salary_payments (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,

    employee_id         TEXT NOT NULL,
    employee_name       TEXT NOT NULL,
    position            TEXT,
    customer_id         TEXT,
    customer_name       TEXT,

    period_month        INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    period_year         INTEGER NOT NULL,

    base_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
    additions           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    deductions          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net_amount          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'SAR',
    notes               TEXT,
    payment_method      TEXT,

    status              TEXT NOT NULL DEFAULT 'pending_manager'
                        CHECK (status IN ('pending_manager', 'pending_admin', 'approved', 'processing', 'paid', 'rejected', 'cancelled')),

    -- audit / workflow trail
    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    manager_approved_by TEXT,
    manager_approved_at TIMESTAMPTZ,
    admin_approved_by   TEXT,
    admin_approved_at   TIMESTAMPTZ,
    rejected_by         TEXT,
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    processed_by        TEXT,
    processed_at        TIMESTAMPTZ,
    payment_reference   TEXT,
    paid_amount         NUMERIC(14, 2),
    paid_at             TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (employee_id, period_month, period_year)
);

CREATE INDEX idx_salary_payments_status   ON salary_payments (status);
CREATE INDEX idx_salary_payments_employee ON salary_payments (employee_id);
CREATE INDEX idx_salary_payments_period   ON salary_payments (period_year, period_month);
CREATE INDEX idx_salary_payments_created  ON salary_payments (created_by);

-- ─── Salary audit log ─────────────────────────────────────────────────────────
CREATE TABLE salary_payment_events (
    id          TEXT PRIMARY KEY,
    salary_id   TEXT NOT NULL REFERENCES salary_payments(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_salary_payment_events_salary ON salary_payment_events (salary_id);

-- Sequence for human-friendly reference numbers (SAL-YYYY-000001)
CREATE SEQUENCE salary_reference_seq START 1;
