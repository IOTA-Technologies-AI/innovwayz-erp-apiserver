-- =============================================================
-- Migration 2: Self-service employee timesheet portal
--   employee_sessions – short-lived tokens issued after OTP login
--   timesheets         – attachment + OCR verification columns
-- =============================================================

-- Sessions issued to employees after they verify an OTP (Authentica).
-- These are separate from ERP user sessions and only grant access to the
-- employee's own timesheet submission.
CREATE TABLE employee_sessions (
    token          TEXT PRIMARY KEY,
    employee_id    TEXT NOT NULL,
    employee_name  TEXT NOT NULL,
    customer_id    TEXT,
    customer_name  TEXT,
    mobile_number  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_employee_sessions_employee ON employee_sessions (employee_id);
CREATE INDEX idx_employee_sessions_expires  ON employee_sessions (expires_at);

-- Attachment (manager-signed timesheet) + OCR verification result.
ALTER TABLE timesheets
    ADD COLUMN source            TEXT NOT NULL DEFAULT 'erp'
                                   CHECK (source IN ('erp','employee_portal')),
    ADD COLUMN attachment_name   TEXT,
    ADD COLUMN attachment_type   TEXT,         -- image/png | image/jpeg | application/pdf
    ADD COLUMN attachment_data   TEXT,         -- base64-encoded bytes
    ADD COLUMN ocr_status        TEXT,         -- ok | pdf_manual_review | unavailable | skipped
    ADD COLUMN ocr_text          TEXT,         -- extracted text (truncated)
    ADD COLUMN ocr_flags         TEXT;         -- JSON array of discrepancy strings
