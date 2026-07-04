-- ─── Contracts ───────────────────────────────────────────────────────────────
-- Tracks employment / service contracts per employee.
-- Status flow: draft → active → expired | terminated | renewed
CREATE TABLE contracts (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,

    -- Parties (employee snapshot)
    employee_id         TEXT,
    employee_name       TEXT NOT NULL,
    customer_id         TEXT,
    customer_name       TEXT,
    job_title           TEXT,

    -- Contract type
    contract_type       TEXT NOT NULL DEFAULT 'employment'
                        CHECK (contract_type IN (
                            'employment', 'service', 'freelance',
                            'internship', 'probation', 'renewal', 'other'
                        )),

    -- Dates
    start_date          DATE NOT NULL,
    end_date            DATE,           -- NULL = indefinite / open-ended
    probation_end_date  DATE,

    -- Financials (optional snapshot)
    salary_amount       NUMERIC(14,2),
    salary_currency     TEXT DEFAULT 'SAR',
    notice_period_days  INT  DEFAULT 30,

    -- Document
    file_url            TEXT,
    notes               TEXT,

    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','expired','terminated','renewed')),

    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    activated_by        TEXT,
    activated_at        TIMESTAMPTZ,
    terminated_by       TEXT,
    terminated_at       TIMESTAMPTZ,
    termination_reason  TEXT,
    renewed_by          TEXT,
    renewed_at          TIMESTAMPTZ,
    renewed_contract_id TEXT, -- links to the replacement contract

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON contracts (employee_id);
CREATE INDEX ON contracts (status);
CREATE INDEX ON contracts (end_date);
CREATE INDEX ON contracts (created_at DESC);

-- ─── Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE contract_events (
    id          TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    performed_by TEXT NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON contract_events (contract_id);

-- ─── Reference sequence: CT-YYYY-000001 ──────────────────────────────────────
CREATE SEQUENCE contract_ref_seq START 1;
