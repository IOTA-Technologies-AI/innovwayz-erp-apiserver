-- =========================================================================
-- SALES CRM — Schema
-- Contacts, Deals (Pipeline), Activities, and Audit Events
-- =========================================================================

-- ── 1. Sales Contacts (leads → prospects → clients) ───────────────────────
CREATE TABLE sales_contacts (
    id           TEXT          PRIMARY KEY,
    full_name    VARCHAR(150)  NOT NULL,
    email        VARCHAR(255),
    phone        VARCHAR(50),
    company      VARCHAR(150),
    job_title    VARCHAR(100),
    contact_type TEXT          NOT NULL DEFAULT 'lead'
                 CHECK (contact_type IN ('lead','prospect','client','partner')),
    source       VARCHAR(80),  -- referral | website | linkedin | cold_call | event | other
    owner_id     TEXT,         -- BDM user_id
    owner_name   TEXT,
    notes        TEXT,
    is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
    created_by   TEXT          NOT NULL,
    created_by_name TEXT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sales_contacts_type  ON sales_contacts(contact_type);
CREATE INDEX idx_sales_contacts_owner ON sales_contacts(owner_id);
CREATE INDEX idx_sales_contacts_company ON sales_contacts(company);

-- ── 2. Deals / Opportunities ──────────────────────────────────────────────
CREATE TABLE sales_deals (
    id                  TEXT          PRIMARY KEY,
    reference           TEXT          NOT NULL UNIQUE,
    title               TEXT          NOT NULL,
    contact_id          TEXT          REFERENCES sales_contacts(id) ON DELETE SET NULL,
    contact_name        TEXT,
    company             TEXT,
    value               NUMERIC(14,2) NOT NULL DEFAULT 0,
    currency            TEXT          NOT NULL DEFAULT 'SAR',
    stage               TEXT          NOT NULL DEFAULT 'lead'
                        CHECK (stage IN ('lead','qualified','proposal','negotiation','closed_won','closed_lost')),
    probability         INT           NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
    expected_close_date DATE,
    actual_close_date   DATE,
    owner_id            TEXT,         -- BDM user_id
    owner_name          TEXT,
    description         TEXT,
    lost_reason         TEXT,
    created_by          TEXT          NOT NULL,
    created_by_name     TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sales_deals_stage     ON sales_deals(stage);
CREATE INDEX idx_sales_deals_owner     ON sales_deals(owner_id);
CREATE INDEX idx_sales_deals_close     ON sales_deals(expected_close_date);
CREATE INDEX idx_sales_deals_company   ON sales_deals(company);

CREATE SEQUENCE sales_deal_ref_seq START 1;

-- ── 3. Deal Activities ────────────────────────────────────────────────────
CREATE TABLE deal_activities (
    id              TEXT        PRIMARY KEY,
    deal_id         TEXT        NOT NULL REFERENCES sales_deals(id) ON DELETE CASCADE,
    activity_type   TEXT        NOT NULL
                    CHECK (activity_type IN ('call','email','meeting','demo','follow_up','proposal_sent','other')),
    subject         TEXT        NOT NULL,
    description     TEXT,
    scheduled_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    outcome         TEXT,
    created_by      TEXT        NOT NULL,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deal_activities_deal  ON deal_activities(deal_id);
CREATE INDEX idx_deal_activities_type  ON deal_activities(activity_type);
CREATE INDEX idx_deal_activities_sched ON deal_activities(scheduled_at);

-- ── 4. Deal Audit Events ──────────────────────────────────────────────────
CREATE TABLE deal_events (
    id         TEXT        PRIMARY KEY,
    deal_id    TEXT        NOT NULL REFERENCES sales_deals(id) ON DELETE CASCADE,
    action     TEXT        NOT NULL,
    actor_id   TEXT,
    actor_name TEXT,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deal_events_deal ON deal_events(deal_id);
