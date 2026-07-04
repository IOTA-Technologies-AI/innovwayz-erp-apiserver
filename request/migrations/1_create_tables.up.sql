-- ─── Employee Requests ───────────────────────────────────────────────────────
-- HR service requests: visa, insurance, Iqama, employment letters, etc.
-- Status flow: submitted → in_review → completed | rejected | cancelled
CREATE TABLE employee_requests (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,
    request_type        TEXT NOT NULL
                        CHECK (request_type IN (
                            'exit_reentry',
                            'insurance_update',
                            'family_status',
                            'dependent_add',
                            'iqama_renewal',
                            'chamber_commerce',
                            'employment_letter',
                            'salary_certificate',
                            'experience_letter',
                            'noc_letter',
                            'other'
                        )),
    -- optional sub-classification (e.g. letter language, visa type)
    request_subtype     TEXT,

    -- employee snapshot (denormalised for history)
    employee_id         TEXT,
    employee_name       TEXT NOT NULL,
    customer_id         TEXT,
    customer_name       TEXT,

    title               TEXT NOT NULL,
    description         TEXT,
    priority            TEXT NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    requested_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    required_by_date    DATE,
    attachment_url      TEXT,

    -- HR internal notes (editable by manager/admin)
    notes               TEXT,

    status              TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted', 'in_review', 'completed', 'rejected', 'cancelled')),

    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    reviewed_by         TEXT,
    reviewed_at         TIMESTAMPTZ,
    completed_by        TEXT,
    completed_at        TIMESTAMPTZ,
    completion_notes    TEXT,
    rejected_by         TEXT,
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON employee_requests (created_by);
CREATE INDEX ON employee_requests (employee_id);
CREATE INDEX ON employee_requests (status);
CREATE INDEX ON employee_requests (request_type);
CREATE INDEX ON employee_requests (created_at DESC);

-- ─── Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE employee_request_events (
    id              TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    performed_by    TEXT NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON employee_request_events (request_id);

-- ─── Reference sequence: REQ-YYYY-000001 ─────────────────────────────────────
CREATE SEQUENCE employee_request_ref_seq START 1;
