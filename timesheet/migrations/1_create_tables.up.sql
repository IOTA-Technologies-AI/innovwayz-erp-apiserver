-- ─── Timesheets ──────────────────────────────────────────────────────────────
-- One record per employee per billing period (month/year).
-- Tracks attendance, leave, and overtime for payroll and leave-balance purposes.
-- Status flow: draft → submitted → approved | rejected
CREATE TABLE timesheets (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,

    -- Employee snapshot (denormalised for history)
    employee_id         TEXT,
    employee_name       TEXT NOT NULL,
    customer_id         TEXT,
    customer_name       TEXT,

    -- Billing period
    period_month        INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    period_year         INT NOT NULL,

    -- Attendance breakdown (all in working days)
    total_working_days  INT NOT NULL DEFAULT 0,   -- calendar working days in period
    days_present        INT NOT NULL DEFAULT 0,   -- days physically present
    leave_days          INT NOT NULL DEFAULT 0,   -- annual leave days taken
    sick_leave_days     INT NOT NULL DEFAULT 0,   -- sick leave days taken
    public_holidays     INT NOT NULL DEFAULT 0,   -- public holidays in period
    absent_days         INT NOT NULL DEFAULT 0,   -- unexplained absences
    overtime_hours      NUMERIC(6,2) NOT NULL DEFAULT 0,

    -- Validation: days_present + leave_days + sick_leave_days + public_holidays + absent_days
    --             should equal total_working_days (enforced in app layer)

    notes               TEXT,
    file_url            TEXT,   -- approved timesheet attachment

    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','rejected')),
    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    submitted_by        TEXT,
    submitted_at        TIMESTAMPTZ,
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    rejected_by         TEXT,
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (employee_id, period_month, period_year)
);

CREATE INDEX ON timesheets (employee_id);
CREATE INDEX ON timesheets (status);
CREATE INDEX ON timesheets (period_year, period_month);
CREATE INDEX ON timesheets (created_at DESC);

-- ─── Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE timesheet_events (
    id              TEXT PRIMARY KEY,
    timesheet_id    TEXT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    performed_by    TEXT NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON timesheet_events (timesheet_id);

-- ─── Reference sequence: TS-YYYY-000001 ──────────────────────────────────────
CREATE SEQUENCE timesheet_ref_seq START 1;
