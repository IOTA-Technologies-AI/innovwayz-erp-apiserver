-- =========================================================================
-- FINANCIAL SERVICE — Schema
-- Enterprise Financial Analytics & Partner Disbursement System
-- =========================================================================

-- ── 1. Chart of Accounts ──────────────────────────────────────────────────
CREATE TABLE chart_of_accounts (
    account_code  VARCHAR(5) PRIMARY KEY
                  CHECK (account_code ~ '^[1-5][0-9]{4}$'),
    account_name  VARCHAR(100)  NOT NULL,
    account_class VARCHAR(20)   NOT NULL
                  CHECK (account_class IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
    parent_code   VARCHAR(5)    REFERENCES chart_of_accounts(account_code),
    is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── 2. Bank Clients (Tier-1 banking partners) ─────────────────────────────
CREATE TABLE bank_clients (
    id               TEXT         PRIMARY KEY,
    bank_name        VARCHAR(100) NOT NULL UNIQUE,
    billing_currency VARCHAR(3)   NOT NULL DEFAULT 'USD',
    contact_name     VARCHAR(100),
    contact_email    VARCHAR(255),
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 3. Deployed Resources (Consultants / Developers / Agile Coaches) ──────
CREATE TABLE financial_resources (
    id                 TEXT         PRIMARY KEY,
    full_name          VARCHAR(100) NOT NULL,
    resource_type      VARCHAR(50)  NOT NULL,
    monthly_cogs_cost  NUMERIC(12,2) NOT NULL CHECK (monthly_cogs_cost >= 0),
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 4. Resource Placements (resource ↔ bank assignment + billing rate) ────
CREATE TABLE resource_placements (
    id                   TEXT         PRIMARY KEY,
    resource_id          TEXT         NOT NULL REFERENCES financial_resources(id) ON DELETE CASCADE,
    bank_id              TEXT         NOT NULL REFERENCES bank_clients(id) ON DELETE CASCADE,
    monthly_billing_rate NUMERIC(12,2) NOT NULL CHECK (monthly_billing_rate >= 0),
    start_date           DATE         NOT NULL,
    end_date             DATE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_placements_resource ON resource_placements(resource_id);
CREATE INDEX idx_placements_bank     ON resource_placements(bank_id);

-- ── 5. Journal Entries (double-entry header) ──────────────────────────────
CREATE TABLE journal_entries (
    id              TEXT         PRIMARY KEY,
    reference       TEXT         NOT NULL UNIQUE,
    fiscal_period   VARCHAR(7)   NOT NULL,   -- YYYY-MM
    description     TEXT         NOT NULL,
    is_posted       BOOLEAN      NOT NULL DEFAULT FALSE,
    posted_at       TIMESTAMPTZ,
    posted_by       TEXT,
    posted_by_name  TEXT,
    is_locked       BOOLEAN      NOT NULL DEFAULT FALSE,
    locked_reason   TEXT,
    created_by      TEXT         NOT NULL,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_je_period ON journal_entries(fiscal_period);
CREATE INDEX idx_je_posted ON journal_entries(is_posted);

-- ── 6. Ledger Lines (double-entry detail rows) ────────────────────────────
CREATE TABLE ledger_lines (
    id               TEXT         PRIMARY KEY,
    journal_entry_id TEXT         NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_code     VARCHAR(5)   NOT NULL REFERENCES chart_of_accounts(account_code),
    debit            NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (debit >= 0),
    credit           NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (credit >= 0),
    description      TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT check_single_direction CHECK (
        (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
    )
);

CREATE INDEX idx_ll_account ON ledger_lines(account_code);
CREATE INDEX idx_ll_entry   ON ledger_lines(journal_entry_id);

-- ── 7. Partner Capital Accounts ───────────────────────────────────────────
CREATE TABLE partner_capital_accounts (
    id                 TEXT         PRIMARY KEY,
    partner_name       VARCHAR(100) NOT NULL UNIQUE,
    equity_percentage  NUMERIC(5,2) NOT NULL CHECK (equity_percentage >= 0 AND equity_percentage <= 100),
    associated_account VARCHAR(5)   NOT NULL REFERENCES chart_of_accounts(account_code),
    is_org_reserve     BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 8. Financial Audit Log ────────────────────────────────────────────────
CREATE TABLE financial_audit_log (
    id              TEXT        PRIMARY KEY,
    table_name      TEXT        NOT NULL,
    record_id       TEXT        NOT NULL,
    action          TEXT        NOT NULL,
    changed_by      TEXT        NOT NULL,
    changed_by_name TEXT,
    changes         TEXT,       -- JSON string of before/after values
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fin_audit_table ON financial_audit_log(table_name, record_id);
CREATE INDEX idx_fin_audit_actor ON financial_audit_log(changed_by);

-- Sequence for journal entry auto-references (JE-YYYY-MM-0001)
CREATE SEQUENCE financial_je_seq START 1;
