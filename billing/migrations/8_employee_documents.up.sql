-- =============================================================
-- Migration 8: Employee allied documents + family members
--
-- employee_documents — one row per tracked document (Iqama, Insurance, GOSI,
--   Saudi Council of Engineers cert, Air Ticket, Passport, …), each with an
--   expiry_date that drives renewal reminders to the responsible BDM/AM.
--   Co-located with employees + bdm_assignments so the responsible BDM is a
--   single JOIN away. The alert-dedup columns mirror the contract expiry cron.
--
-- family_members — dependants for family-status / benefit purposes.
-- =============================================================

CREATE TABLE employee_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type   TEXT NOT NULL,        -- Iqama | Insurance | GOSI | Saudi_Council_Engineers | Air_Ticket | Passport | Other
  document_number TEXT,
  issue_date      DATE,
  expiry_date     DATE,
  -- active | expiring | expired | pending_renewal | renewed
  status          TEXT NOT NULL DEFAULT 'active',
  -- Optional scanned copy (base64), mirrors request_documents.
  file_base64     TEXT,
  notes           TEXT,
  -- Renewal approval (mirrors leave_requests: pending_renewal → approved/rejected)
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  rejected_by     TEXT,
  rejected_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  -- Reminder dedup (mirrors contract expiry alert columns)
  alert_90_sent_at    TIMESTAMPTZ,
  alert_60_sent_at    TIMESTAMPTZ,
  alert_30_sent_at    TIMESTAMPTZ,
  breach_notified_at  TIMESTAMPTZ,
  last_daily_alert_at TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employee_documents_employee ON employee_documents(employee_id);
CREATE INDEX idx_employee_documents_expiry
  ON employee_documents(expiry_date, status)
  WHERE expiry_date IS NOT NULL;

CREATE TABLE family_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  relationship  TEXT,                   -- Spouse | Son | Daughter | Parent | Other
  is_dependent  BOOLEAN NOT NULL DEFAULT TRUE,
  id_number     TEXT,                   -- Iqama / passport of the dependant
  date_of_birth DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_family_members_employee ON family_members(employee_id);
