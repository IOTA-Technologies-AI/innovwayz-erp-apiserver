-- Cash-basis posting: when an invoice is marked paid it credits a revenue
-- account (Dr 11100 Cash / Cr <revenue_account>). Each invoice carries its own
-- revenue account so different income streams post to the right P&L line.
-- Allowed values (validated in the app): 41100, 41200, 41300.
ALTER TABLE invoices
  ADD COLUMN revenue_account VARCHAR(5) NOT NULL DEFAULT '41100';
