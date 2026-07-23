-- =============================================================
-- Migration 6: Contract linkage + VAT on invoices
--   contract_id – the active contract that generated this invoice
--   vat_rate    – VAT % applied (e.g. 15.00); 0 = no VAT (back-compat)
--   vat_amount  – computed VAT value; total_amount = amount + vat_amount
--
-- VAT is an invoice-document figure only. The ledger continues to post the
-- NET `amount` to revenue on payment (VAT-payable accounting deferred).
-- =============================================================

ALTER TABLE invoices
  ADD COLUMN contract_id TEXT,
  ADD COLUMN vat_rate    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN vat_amount  NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE INDEX idx_invoices_contract ON invoices(contract_id);
