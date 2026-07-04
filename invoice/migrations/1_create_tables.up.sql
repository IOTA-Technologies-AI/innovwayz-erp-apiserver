-- Invoicing (accounts receivable) — monthly outsourcing billing to customers.

CREATE TABLE invoices (
  id                TEXT PRIMARY KEY,
  reference         TEXT UNIQUE NOT NULL,
  customer_id       TEXT,
  customer_name     TEXT NOT NULL,
  employee_id       TEXT,
  employee_name     TEXT,
  period_month      INT CHECK (period_month BETWEEN 1 AND 12),
  period_year       INT,
  description       TEXT,
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'SAR',
  -- draft | sent | partially_paid | paid | overdue | cancelled
  status            TEXT NOT NULL DEFAULT 'draft',
  issue_date        DATE,
  due_date          DATE,
  paid_date         DATE,
  paid_amount       NUMERIC(14,2),
  payment_reference TEXT,
  notes             TEXT,
  created_by        TEXT NOT NULL,
  created_by_name   TEXT,
  sent_by           TEXT,
  sent_at           TIMESTAMPTZ,
  cancelled_by      TEXT,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_status       ON invoices (status);
CREATE INDEX idx_invoices_customer     ON invoices (customer_id);
CREATE INDEX idx_invoices_employee     ON invoices (employee_id);
CREATE INDEX idx_invoices_period       ON invoices (period_year, period_month);
CREATE INDEX idx_invoices_issue_date   ON invoices (issue_date);
CREATE INDEX idx_invoices_created_by   ON invoices (created_by);

CREATE TABLE invoice_events (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor_id    TEXT,
  actor_name  TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_events_invoice ON invoice_events (invoice_id);

CREATE SEQUENCE invoice_reference_seq START 1;
