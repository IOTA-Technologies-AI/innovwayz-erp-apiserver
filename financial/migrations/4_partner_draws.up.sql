-- =========================================================================
-- FINANCIAL SERVICE — Partner Draws Table
-- Tracks individual partner fund withdrawals against their accrued share.
-- Partners may draw at any time; available_balance = accrued - total_drawn.
-- =========================================================================

CREATE TABLE partner_draws (
    id               TEXT          PRIMARY KEY,
    partner_id       TEXT          NOT NULL REFERENCES partner_capital_accounts(id) ON DELETE RESTRICT,
    fiscal_period    VARCHAR(7)    NOT NULL,   -- YYYY-MM of the accrual period being drawn against
    amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    drawn_by_name    VARCHAR(100),             -- Physical recipient / executor name
    reference        TEXT,                     -- Payment reference / cheque number
    notes            TEXT,
    draw_date        DATE          NOT NULL,
    created_by       TEXT          NOT NULL,
    created_by_name  TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_partner_draws_partner ON partner_draws(partner_id);
CREATE INDEX idx_partner_draws_period  ON partner_draws(fiscal_period);
CREATE INDEX idx_partner_draws_date    ON partner_draws(draw_date);
