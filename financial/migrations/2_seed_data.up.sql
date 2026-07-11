-- =========================================================================
-- FINANCIAL SERVICE — Seed Data
-- Chart of Accounts (full CoA per BRD) + Partner equity matrix
-- Partner split (user-confirmed): 30% / 30% / 30% + 10% Org Growth
-- =========================================================================

-- ── Chart of Accounts ─────────────────────────────────────────────────────

INSERT INTO chart_of_accounts (account_code, account_name, account_class) VALUES
-- [1xxxx] ASSETS ── Current
('11100', 'Corporate Operating Account (USD)',        'Asset'),
('11200', 'Bank Escrow & Security Deposits',          'Asset'),
('11300', 'Accounts Receivable (A/R) - Bank Placements', 'Asset'),
-- [1xxxx] ASSETS ── Non-Current
('12100', 'Office Infrastructure & IT Assets',        'Asset'),
-- [2xxxx] LIABILITIES ── Current
('21100', 'Accounts Payable (A/P) - Subcontractors/Vendors', 'Liability'),
('21200', 'Accrued Payroll & Resource Salaries',      'Liability'),
('21300', 'Corporate Tax Provisioning',               'Liability'),
-- [2xxxx] LIABILITIES ── Non-Current
('22100', 'Long-Term Institutional Credit Lines',     'Liability'),
-- [3xxxx] EQUITY
('31100', 'Paid-in Capital',                          'Equity'),
('31200', 'Retained Earnings',                        'Equity'),
('32100', 'Ja Capital / Draws',                        'Equity'),
('32200', 'Wa Capital / Draws',                        'Equity'),
('32300', 'Za Capital / Draws',                        'Equity'),
('32400', 'Organization Growth Reserve',              'Equity'),
-- [4xxxx] REVENUE
('41100', 'Bank Tier-1 Placement Fees',               'Revenue'),
('41200', 'Monthly Retainer Advisory Income',         'Revenue'),
('41300', 'SLA Milestones & Performance Bonuses',     'Revenue'),
-- [5xxxx] EXPENSES ── COGS
('51100', 'Contracted Resource Monthly Payroll',      'Expense'),
('51200', 'Client Site Insurance & Onboarding Compliance', 'Expense'),
-- [5xxxx] EXPENSES ── OPEX
('52100', 'Executive Staff Salaries',                 'Expense'),
('52200', 'Enterprise Software Licenses & SaaS Subscriptions', 'Expense'),
('52300', 'Legal, Compliance & Banking Audit Fees',   'Expense');

-- ── Partner Capital Accounts ──────────────────────────────────────────────
-- All three partners share 30% equally; 10% allocated to Organization Growth.
-- Disbursement pool = Net Profit × 0.80 (20% stays as retained earnings [31200]).
-- Of the 80% pool: Ja 30%, Wa 30%, Za 30%, Org 10%.

INSERT INTO partner_capital_accounts (id, partner_name, equity_percentage, associated_account, is_org_reserve) VALUES
('partner-a',   'Ja (Managing)',               30.00, '32100', FALSE),
('partner-b',   'Wa (Origination)',             30.00, '32200', FALSE),
('partner-c',   'Za (Operations)',              30.00, '32300', FALSE),
('partner-org', 'Organization Growth Reserve',  10.00, '32400', TRUE);
