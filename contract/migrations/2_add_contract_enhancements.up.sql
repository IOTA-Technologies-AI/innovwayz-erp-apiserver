-- =========================================================================
-- CONTRACT SERVICE — Enhanced Contract Fields
-- Renewal cycles, value breakdown (GOSI/benefits/tickets/Iqama),
-- sales manager tracking, and expiry alert state.
-- =========================================================================

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS renewal_cycle TEXT NOT NULL DEFAULT 'yearly'
    CHECK (renewal_cycle IN ('monthly','quarterly','yearly')),

  -- Total contract value (ceiling for component expenses)
  ADD COLUMN IF NOT EXISTS contract_value   NUMERIC(14,2),

  -- Which benefit package applies (determines family_benefit vs single_benefit)
  ADD COLUMN IF NOT EXISTS benefit_type TEXT NOT NULL DEFAULT 'single'
    CHECK (benefit_type IN ('single','family')),

  -- Contract cost components (all drawn from contract_value)
  ADD COLUMN IF NOT EXISTS gosi_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS family_benefit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS single_benefit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS annual_ticket_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iqama_amount           NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Salary is captured in existing salary_amount column
  -- Overtime is paid separately and NOT part of contract_value

  -- Sales manager responsible for renewal (receives alert emails)
  ADD COLUMN IF NOT EXISTS sales_manager_id   TEXT,
  ADD COLUMN IF NOT EXISTS sales_manager_name TEXT,

  -- Expiry alert tracking (prevents duplicate sends)
  ADD COLUMN IF NOT EXISTS alert_90_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alert_60_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alert_30_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS breach_notified_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_daily_alert_at    TIMESTAMPTZ;

-- Index for the expiry alert cron query
CREATE INDEX IF NOT EXISTS idx_contracts_end_date_status
  ON contracts(end_date, status)
  WHERE status = 'active';
