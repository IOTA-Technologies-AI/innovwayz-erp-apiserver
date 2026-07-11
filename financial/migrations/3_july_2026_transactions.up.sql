-- =========================================================================
-- FINANCIAL SERVICE — July 2026 Opening Transactions
-- Source: "July 2026 Income/Expense — Jawaza Account" spreadsheet
--
-- Opening carry-forward (June closing):  SAR   604,391.44
-- Total income received (July):          SAR   625,900.12
-- Total expenses paid (July):            SAR    57,080.25
-- ─────────────────────────────────────────────────────
-- Remaining cash balance (11100):        SAR 1,173,211.31
--
-- Trial Balance verification:
--   Total Debits  = 604,391.44 + 625,900.12 + 57,080.25 = 1,287,371.81
--   Total Credits = 604,391.44 + 625,900.12 + 57,080.25 = 1,287,371.81 ✓
-- =========================================================================

-- ── Journal Entry Headers ─────────────────────────────────────────────────

INSERT INTO journal_entries (
    id, reference, fiscal_period, description,
    is_posted, posted_at, posted_by, posted_by_name,
    created_by, created_by_name, created_at, updated_at
) VALUES

-- 1. Opening balance – June 2026 closing → July 2026 carry-forward
(
    'je-2026-07-0001', 'JE-2026-07-0001', '2026-07',
    'Opening Balance — June 2026 Carry-Forward (Jawaza Account)',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 2. Income: ANB (Arab National Bank) — 06 Jul 2026 — SAR 30,000
(
    'je-2026-07-0002', 'JE-2026-07-0002', '2026-07',
    'Placement Fee Received — ANB (Arab National Bank) | 06 Jul 2026',
    TRUE, '2026-07-06 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-06 00:00:00+00', '2026-07-06 00:00:00+00'
),

-- 3. Income: Riyad Bank — 06 Jul 2026 — SAR 232,750
(
    'je-2026-07-0003', 'JE-2026-07-0003', '2026-07',
    'Placement Fee Received — Riyad Bank | 06 Jul 2026',
    TRUE, '2026-07-06 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-06 00:00:00+00', '2026-07-06 00:00:00+00'
),

-- 4. Income: ANB — 07 Jul 2026 — SAR 59,500 (1/4)
(
    'je-2026-07-0004', 'JE-2026-07-0004', '2026-07',
    'Placement Fee Received — ANB (Arab National Bank) | 07 Jul 2026 (1/4)',
    TRUE, '2026-07-07 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-07 00:00:00+00', '2026-07-07 00:00:00+00'
),

-- 5. Income: ANB — 07 Jul 2026 — SAR 59,000 (2/4)
(
    'je-2026-07-0005', 'JE-2026-07-0005', '2026-07',
    'Placement Fee Received — ANB (Arab National Bank) | 07 Jul 2026 (2/4)',
    TRUE, '2026-07-07 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-07 00:00:00+00', '2026-07-07 00:00:00+00'
),

-- 6. Income: ANB — 07 Jul 2026 — SAR 24,150.12 (3/4)
(
    'je-2026-07-0006', 'JE-2026-07-0006', '2026-07',
    'Placement Fee Received — ANB (Arab National Bank) | 07 Jul 2026 (3/4)',
    TRUE, '2026-07-07 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-07 00:00:00+00', '2026-07-07 00:00:00+00'
),

-- 7. Income: ANB — 07 Jul 2026 — SAR 220,500 (4/4)
(
    'je-2026-07-0007', 'JE-2026-07-0007', '2026-07',
    'Placement Fee Received — ANB (Arab National Bank) | 07 Jul 2026 (4/4)',
    TRUE, '2026-07-07 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-07 00:00:00+00', '2026-07-07 00:00:00+00'
),

-- 8. Expense: Rakhsith Amex June Salary — SAR 3,333
(
    'je-2026-07-0008', 'JE-2026-07-0008', '2026-07',
    'Payroll — Rakhsith Amex June Salary | 01 Jul 2026',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 9. Expense: Petty Cash to Zaki Bhai (D360 Account) — SAR 3,000
(
    'je-2026-07-0009', 'JE-2026-07-0009', '2026-07',
    'Operational Expense — Petty Cash to Zaki Bhai (D360 Account) | 01 Jul 2026',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 10. Expense: Faraz Family Insurance — SAR 2,014.36
(
    'je-2026-07-0010', 'JE-2026-07-0010', '2026-07',
    'Insurance — Faraz Family Insurance Premium | 01 Jul 2026',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 11. Expense: Saudization of Resources (Nitaqat) — SAR 34,250
(
    'je-2026-07-0011', 'JE-2026-07-0011', '2026-07',
    'Compliance — Saudization of Resources (Nitaqat Programme) | 01 Jul 2026',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 12. Expense: GOSI (Social Insurance) — SAR 14,000
(
    'je-2026-07-0012', 'JE-2026-07-0012', '2026-07',
    'Payroll — GOSI (General Organization for Social Insurance) | 01 Jul 2026',
    TRUE, '2026-07-01 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
),

-- 13. Expense: Deem Ali BUPA Health Insurance — SAR 482.89
(
    'je-2026-07-0013', 'JE-2026-07-0013', '2026-07',
    'Insurance — Deem Ali BUPA Health Insurance | 07 Jul 2026',
    TRUE, '2026-07-07 00:00:00+00', 'system', 'System Import',
    'system', 'System Import',
    '2026-07-07 00:00:00+00', '2026-07-07 00:00:00+00'
)

ON CONFLICT (id) DO NOTHING;

-- ── Ledger Lines (Double-Entry) ───────────────────────────────────────────
-- Account key:
--   11100 = Corporate Operating Account (SAR cash)
--   31200 = Retained Earnings (prior-period equity carry-forward)
--   41100 = Bank Tier-1 Placement Fees (service revenue)
--   51100 = Contracted Resource Monthly Payroll (salary + GOSI)
--   51200 = Client Site Insurance & Onboarding Compliance
--   52100 = Executive Staff Salaries (operational staff/admin)

INSERT INTO ledger_lines (
    id, journal_entry_id, account_code, debit, credit, description
) VALUES

-- ── JE-0001: Opening Balance ─────────────────────────────────────────────
--   Dr 11100 604,391.44 / Cr 31200 604,391.44
('ll-2026-07-0001-d', 'je-2026-07-0001', '11100', 604391.44, 0.00,
    'Opening cash balance — Jawaza Account (June 2026 closing)'),
('ll-2026-07-0001-c', 'je-2026-07-0001', '31200', 0.00, 604391.44,
    'Retained earnings — June 2026 carry-forward'),

-- ── JE-0002: ANB 06 Jul — SAR 30,000 ─────────────────────────────────────
('ll-2026-07-0002-d', 'je-2026-07-0002', '11100', 30000.00, 0.00,
    'Cash received — ANB transfer 06 Jul 2026'),
('ll-2026-07-0002-c', 'je-2026-07-0002', '41100', 0.00, 30000.00,
    'Managed services revenue — ANB'),

-- ── JE-0003: Riyad Bank 06 Jul — SAR 232,750 ─────────────────────────────
('ll-2026-07-0003-d', 'je-2026-07-0003', '11100', 232750.00, 0.00,
    'Cash received — Riyad Bank transfer 06 Jul 2026'),
('ll-2026-07-0003-c', 'je-2026-07-0003', '41100', 0.00, 232750.00,
    'Managed services revenue — Riyad Bank'),

-- ── JE-0004: ANB 07 Jul — SAR 59,500 (1/4) ──────────────────────────────
('ll-2026-07-0004-d', 'je-2026-07-0004', '11100', 59500.00, 0.00,
    'Cash received — ANB transfer 07 Jul 2026'),
('ll-2026-07-0004-c', 'je-2026-07-0004', '41100', 0.00, 59500.00,
    'Managed services revenue — ANB'),

-- ── JE-0005: ANB 07 Jul — SAR 59,000 (2/4) ──────────────────────────────
('ll-2026-07-0005-d', 'je-2026-07-0005', '11100', 59000.00, 0.00,
    'Cash received — ANB transfer 07 Jul 2026'),
('ll-2026-07-0005-c', 'je-2026-07-0005', '41100', 0.00, 59000.00,
    'Managed services revenue — ANB'),

-- ── JE-0006: ANB 07 Jul — SAR 24,150.12 (3/4) ───────────────────────────
('ll-2026-07-0006-d', 'je-2026-07-0006', '11100', 24150.12, 0.00,
    'Cash received — ANB transfer 07 Jul 2026'),
('ll-2026-07-0006-c', 'je-2026-07-0006', '41100', 0.00, 24150.12,
    'Managed services revenue — ANB'),

-- ── JE-0007: ANB 07 Jul — SAR 220,500 (4/4) ─────────────────────────────
('ll-2026-07-0007-d', 'je-2026-07-0007', '11100', 220500.00, 0.00,
    'Cash received — ANB transfer 07 Jul 2026'),
('ll-2026-07-0007-c', 'je-2026-07-0007', '41100', 0.00, 220500.00,
    'Managed services revenue — ANB'),

-- ── JE-0008: Rakhsith Amex June Salary — SAR 3,333 ──────────────────────
('ll-2026-07-0008-d', 'je-2026-07-0008', '51100', 3333.00, 0.00,
    'Rakhsith Amex June Salary'),
('ll-2026-07-0008-c', 'je-2026-07-0008', '11100', 0.00, 3333.00,
    'Payment from corporate operating account'),

-- ── JE-0009: Petty Cash to Zaki Bhai (D360) — SAR 3,000 ─────────────────
('ll-2026-07-0009-d', 'je-2026-07-0009', '52100', 3000.00, 0.00,
    'Petty cash — Zaki Bhai D360 Account'),
('ll-2026-07-0009-c', 'je-2026-07-0009', '11100', 0.00, 3000.00,
    'Payment from corporate operating account'),

-- ── JE-0010: Faraz Family Insurance — SAR 2,014.36 ───────────────────────
('ll-2026-07-0010-d', 'je-2026-07-0010', '51200', 2014.36, 0.00,
    'Faraz family insurance premium'),
('ll-2026-07-0010-c', 'je-2026-07-0010', '11100', 0.00, 2014.36,
    'Payment from corporate operating account'),

-- ── JE-0011: Saudization of Resources — SAR 34,250 ───────────────────────
('ll-2026-07-0011-d', 'je-2026-07-0011', '51200', 34250.00, 0.00,
    'Saudization levy — Nitaqat programme compliance'),
('ll-2026-07-0011-c', 'je-2026-07-0011', '11100', 0.00, 34250.00,
    'Payment from corporate operating account'),

-- ── JE-0012: GOSI — SAR 14,000 ───────────────────────────────────────────
('ll-2026-07-0012-d', 'je-2026-07-0012', '51100', 14000.00, 0.00,
    'GOSI contribution — resources social insurance'),
('ll-2026-07-0012-c', 'je-2026-07-0012', '11100', 0.00, 14000.00,
    'Payment from corporate operating account'),

-- ── JE-0013: Deem Ali BUPA Insurance — SAR 482.89 ────────────────────────
('ll-2026-07-0013-d', 'je-2026-07-0013', '51200', 482.89, 0.00,
    'Deem Ali — BUPA health insurance premium'),
('ll-2026-07-0013-c', 'je-2026-07-0013', '11100', 0.00, 482.89,
    'Payment from corporate operating account')

ON CONFLICT (id) DO NOTHING;

-- ── Verification ─────────────────────────────────────────────────────────
-- Expected summary for fiscal_period '2026-07':
--
--   Account 11100 net (Dr - Cr):
--     Dr:  604,391.44 + 30,000 + 232,750 + 59,500 + 59,000 + 24,150.12 + 220,500
--          = 1,230,291.56
--     Cr:  3,333 + 3,000 + 2,014.36 + 34,250 + 14,000 + 482.89
--          = 57,080.25
--     NET: 1,173,211.31  ← Remaining balance shown in spreadsheet ✓
--
--   Revenue (41100) net:    625,900.12
--   COGS/Exp (51100/51200): 53,080.25  [51100: 17,333 | 51200: 36,747.25]
--   Exec (52100):            3,000.00
--   Gross Profit:           572,819.87
--   Net Operating Income:   569,819.87
