-- Add auto_generate flag to recurring expense templates.
-- When TRUE (company scope only): a monthly cron job sends a reminder email
-- if the template has not been generated for the current month by the 5th.
ALTER TABLE recurring_expenses
    ADD COLUMN IF NOT EXISTS auto_generate BOOLEAN NOT NULL DEFAULT FALSE;

-- Index to quickly find auto-generate company templates.
CREATE INDEX IF NOT EXISTS idx_recurring_auto_generate
    ON recurring_expenses (auto_generate, active)
    WHERE auto_generate = TRUE AND active = TRUE;
