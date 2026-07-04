-- ─── Leave Balances ──────────────────────────────────────────────────────────
-- One row per employee per leave type per year.
-- entitled_days is set by HR; used_days is incremented when a leave is approved.
CREATE TABLE leave_balances (
    id                  TEXT PRIMARY KEY,
    employee_id         TEXT,
    employee_name       TEXT NOT NULL,
    customer_id         TEXT,
    customer_name       TEXT,
    year                INT NOT NULL,
    leave_type          TEXT NOT NULL CHECK (leave_type IN (
                            'annual','sick','emergency','maternity','paternity',
                            'unpaid','compensatory','other'
                        )),
    entitled_days       NUMERIC(6,2) NOT NULL DEFAULT 0,
    used_days           NUMERIC(6,2) NOT NULL DEFAULT 0,
    carry_forward_days  NUMERIC(6,2) NOT NULL DEFAULT 0,
    notes               TEXT,
    created_by          TEXT,
    updated_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (employee_id, leave_type, year)
);

CREATE INDEX ON leave_balances (employee_id);
CREATE INDEX ON leave_balances (year);
CREATE INDEX ON leave_balances (leave_type);

-- ─── Leave Requests ───────────────────────────────────────────────────────────
-- One record per leave application.
-- Status flow: draft → submitted → approved | rejected | cancelled
CREATE TABLE leave_requests (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,

    -- Employee snapshot
    employee_id         TEXT,
    employee_name       TEXT NOT NULL,
    customer_id         TEXT,
    customer_name       TEXT,

    leave_type          TEXT NOT NULL CHECK (leave_type IN (
                            'annual','sick','emergency','maternity','paternity',
                            'unpaid','compensatory','other'
                        )),
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    total_days          NUMERIC(6,2) NOT NULL,

    reason              TEXT,
    notes               TEXT,
    file_url            TEXT,   -- supporting document (e.g. medical certificate)

    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),

    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    submitted_by        TEXT,
    submitted_at        TIMESTAMPTZ,
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    rejected_by         TEXT,
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    cancelled_by        TEXT,
    cancelled_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON leave_requests (employee_id);
CREATE INDEX ON leave_requests (status);
CREATE INDEX ON leave_requests (leave_type);
CREATE INDEX ON leave_requests (start_date);
CREATE INDEX ON leave_requests (created_at DESC);

-- ─── Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE leave_request_events (
    id              TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    performed_by    TEXT NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON leave_request_events (request_id);

-- ─── Reference sequence: LV-YYYY-000001 ──────────────────────────────────────
CREATE SEQUENCE leave_ref_seq START 1;
