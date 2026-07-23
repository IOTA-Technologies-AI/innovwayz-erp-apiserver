-- =============================================================
-- Migration 3: Contract → Invoice billing fields
--   Makes a contract the driver of monthly client invoicing:
--     po_number             – client Purchase Order number (from the sheet)
--     monthly_billing_amount – client-facing monthly revenue (net, excl. VAT).
--                              Distinct from salary_amount (staff cost) and
--                              contract_value (internal cost ceiling).
--     vat_percent           – VAT rate applied on the invoice (default 15%).
-- Each active contract generates one invoice per month = billing + VAT.
-- =============================================================

ALTER TABLE contracts
  ADD COLUMN po_number              TEXT,
  ADD COLUMN monthly_billing_amount NUMERIC(14,2),
  ADD COLUMN vat_percent            NUMERIC(5,2) NOT NULL DEFAULT 15;

-- One active contract per employee is enforced in application logic
-- (activateContract); this partial index speeds the lookup.
CREATE INDEX idx_contracts_active_employee
  ON contracts(employee_id) WHERE status = 'active';
