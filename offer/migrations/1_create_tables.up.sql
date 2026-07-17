-- =============================================================
-- Offer letters with native e-signature
--   offer_letters       – the envelope: candidate + terms + signing state
--   offer_letter_events – immutable audit trail (who/when/ip/agent)
--   offer_letter_docs    – sealed signed PDF versions (base64)
--
-- Status flow:
--   draft → sent → viewed → signed_by_candidate → countersigned → completed
--   terminal side-paths: declined | cancelled | expired
-- =============================================================

CREATE SEQUENCE IF NOT EXISTS offer_letter_ref_seq START 1;

CREATE TABLE offer_letters (
  id                     TEXT PRIMARY KEY,
  reference              TEXT UNIQUE NOT NULL,   -- OFF-YYYY-NNNNNN

  -- Candidate (external, not an ERP user)
  candidate_name         TEXT NOT NULL,
  candidate_email        TEXT NOT NULL,
  candidate_phone        TEXT,

  -- Offer terms
  job_title              TEXT NOT NULL,
  department             TEXT,
  work_location          TEXT,
  customer_id            TEXT,                   -- client the role is for (optional)
  customer_name          TEXT,
  employment_type        TEXT NOT NULL DEFAULT 'full_time'
                           CHECK (employment_type IN ('full_time','part_time','contract','internship')),
  joining_date           DATE,
  offer_expiry_date      DATE,                   -- candidate must sign by this date
  probation_months       INTEGER,
  notice_period_days     INTEGER,
  annual_leave_days      INTEGER,

  -- Compensation
  currency               TEXT NOT NULL DEFAULT 'SAR',
  monthly_salary         NUMERIC(12,2) NOT NULL DEFAULT 0,
  basic_amount           NUMERIC(12,2),
  housing_allowance      NUMERIC(12,2),
  transport_allowance    NUMERIC(12,2),
  other_allowance        NUMERIC(12,2),
  benefits               TEXT,                   -- free text (medical, tickets, etc.)
  additional_terms       TEXT,                   -- extra clauses / custom message

  -- Company signatory (an ERP user who countersigns)
  signatory_id           TEXT,
  signatory_name         TEXT,
  signatory_title        TEXT,

  -- Signing state
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN (
                             'draft','sent','viewed','signed_by_candidate',
                             'countersigned','completed','declined','cancelled','expired'
                           )),
  sign_token             TEXT UNIQUE,            -- secure random token for the candidate link
  token_expires_at       TIMESTAMPTZ,

  -- Candidate signature
  candidate_signature    TEXT,                   -- PNG data URL (drawn) or typed name
  candidate_signature_type TEXT CHECK (candidate_signature_type IN ('drawn','typed')),
  candidate_signed_at     TIMESTAMPTZ,
  candidate_signer_ip     TEXT,
  candidate_signer_agent  TEXT,
  first_viewed_at         TIMESTAMPTZ,
  decline_reason          TEXT,

  -- Company countersignature
  company_signature       TEXT,                  -- PNG data URL (drawn) or typed name
  company_signature_type  TEXT CHECK (company_signature_type IN ('drawn','typed')),
  countersigned_at        TIMESTAMPTZ,
  countersigned_by        TEXT,
  countersigned_by_name   TEXT,

  -- Integrity
  document_hash           TEXT,                  -- sha256 of the sealed PDF

  -- Audit
  created_by             TEXT NOT NULL,
  created_by_name        TEXT,
  sent_by                TEXT,
  sent_at                TIMESTAMPTZ,
  cancelled_by           TEXT,
  cancelled_at           TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_offer_letters_status  ON offer_letters(status);
CREATE INDEX idx_offer_letters_email   ON offer_letters(candidate_email);
CREATE INDEX idx_offer_letters_created ON offer_letters(created_at DESC);

CREATE TABLE offer_letter_events (
  id            TEXT PRIMARY KEY,
  offer_id      TEXT NOT NULL REFERENCES offer_letters(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,          -- created|sent|viewed|signed|declined|countersigned|completed|cancelled
  actor         TEXT,                   -- ERP user id, or 'candidate:<email>'
  actor_name    TEXT,
  ip            TEXT,
  user_agent    TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_offer_letter_events_offer ON offer_letter_events(offer_id, created_at);

CREATE TABLE offer_letter_docs (
  id            TEXT PRIMARY KEY,
  offer_id      TEXT NOT NULL REFERENCES offer_letters(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,          -- 'unsigned' | 'candidate_signed' | 'completed'
  file_name     TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/pdf',
  data_base64   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_offer_letter_docs_offer ON offer_letter_docs(offer_id, created_at DESC);
