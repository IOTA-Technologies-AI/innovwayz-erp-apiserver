-- InnovWayz ERP has no Tax/VAT. Invoices carry net amounts only, so the
-- tax_amount column is redundant: total_amount now always equals amount.
ALTER TABLE invoices DROP COLUMN IF EXISTS tax_amount;
