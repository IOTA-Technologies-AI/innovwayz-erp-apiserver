-- =============================================================
-- Migration 2: Generated request documents
--   Stores letters (experience letter, salary certificate, …)
--   generated automatically when a request is completed.
--   Regeneration inserts a new row; the latest row is served.
-- =============================================================

CREATE TABLE request_documents (
  id                UUID PRIMARY KEY,
  request_id        UUID NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE,
  document_type     TEXT NOT NULL,          -- request_type at generation time
  file_name         TEXT NOT NULL,
  content_type      TEXT NOT NULL DEFAULT 'application/pdf',
  data_base64       TEXT NOT NULL,          -- PDF bytes, base64-encoded
  generated_by      TEXT NOT NULL,
  generated_by_name TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_request_documents_request ON request_documents(request_id, created_at DESC);
