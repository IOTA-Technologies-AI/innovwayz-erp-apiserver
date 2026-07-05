-- Pending invoices imported from "Payment Pending Report July.xlsx" (as of 2026-07-05)
-- source columns: Candidate Name | Deployed at Client | Contract | Start Date | End Date | Pending Amount | Months | Status
-- Rules applied:
--   status='sent'    → "Invoiced" entries or active contracts ≤ 1 month pending
--   status='overdue' → past 30-day payment window, expired contracts, or > 1 month pending
--   Entries with pending_amount = 0 are excluded (Atif Minhaj, Talha Minaam, Shazad Moheeb – SAB, amounts TBD)
-- issue_date = 2026-07-05 minus months_pending (approx)
-- due_date   = issue_date + 30 days (net-30 terms)
-- created_by = 'import', created_by_name = 'Data Import'

INSERT INTO invoices (
  id, reference, customer_id, customer_name, employee_id, employee_name,
  period_month, period_year, description,
  amount, tax_amount, total_amount, currency, status,
  issue_date, due_date,
  notes, created_by, created_by_name
) VALUES

-- ─── Arab National Bank ────────────────────────────────────────────────────

-- Wasim Khan | 1 month | Invoiced | Active
('a1b2c3d4-0001-4000-8000-100000000001', 'INV-PEND-2607-001', NULL, 'Arab National Bank', NULL, 'Wasim Khan',
  6, 2026, 'Pending outsourcing billing for Wasim Khan — 1 month as of July 2026',
  24150.00, 0.00, 24150.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Rakesh Kumar | 1 month | Not Invoiced | Active
('a1b2c3d4-0002-4000-8000-100000000002', 'INV-PEND-2607-002', NULL, 'Arab National Bank', NULL, 'Rakesh Kumar',
  6, 2026, 'Pending outsourcing billing for Rakesh Kumar — 1 month as of July 2026',
  38700.00, 0.00, 38700.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Not Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Vignesh Prakash | 4.27 months | Invoiced | Active
('a1b2c3d4-0003-4000-8000-100000000003', 'INV-PEND-2607-003', NULL, 'Arab National Bank', NULL, 'Vignesh Prakash',
  3, 2026, 'Pending outsourcing billing for Vignesh Prakash — 4.27 months as of July 2026',
  220500.00, 0.00, 220500.00, 'SAR', 'overdue',
  '2026-02-25', '2026-03-27',
  'Contract: Active | Excel status: Invoiced | Months pending: 4.27', 'import', 'Data Import'),

-- Mohamed Elsobky | 2.15 months | Not Invoiced | Expired
('a1b2c3d4-0004-4000-8000-100000000004', 'INV-PEND-2607-004', NULL, 'Arab National Bank', NULL, 'Mohamed Elsobky',
  5, 2026, 'Pending outsourcing billing for Mohamed Elsobky — 2.15 months as of July 2026',
  172000.00, 0.00, 172000.00, 'SAR', 'overdue',
  '2026-04-30', '2026-05-30',
  'Contract: Expired | Excel status: Not Invoiced | Months pending: 2.15', 'import', 'Data Import'),

-- Pradeep Tiwari | 1 month | Not Invoiced | Active
('a1b2c3d4-0005-4000-8000-100000000005', 'INV-PEND-2607-005', NULL, 'Arab National Bank', NULL, 'Pradeep Tiwari',
  6, 2026, 'Pending outsourcing billing for Pradeep Tiwari — 1 month as of July 2026',
  45500.00, 0.00, 45500.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Not Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Aamer Ali | 2 months | Invoiced | Active
('a1b2c3d4-0006-4000-8000-100000000006', 'INV-PEND-2607-006', NULL, 'Arab National Bank', NULL, 'Aamer Ali',
  5, 2026, 'Pending outsourcing billing for Aamer Ali — 2 months as of July 2026',
  100000.00, 0.00, 100000.00, 'SAR', 'overdue',
  '2026-05-05', '2026-06-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 2', 'import', 'Data Import'),

-- Hassan AlKhateeb | 1 month | Invoiced | Active
('a1b2c3d4-0007-4000-8000-100000000007', 'INV-PEND-2607-007', NULL, 'Arab National Bank', NULL, 'Hassan AlKhateeb',
  6, 2026, 'Pending outsourcing billing for Hassan AlKhateeb — 1 month as of July 2026',
  59000.00, 0.00, 59000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Abdullah AlTahan | 1 month | Invoiced | Active
('a1b2c3d4-0008-4000-8000-100000000008', 'INV-PEND-2607-008', NULL, 'Arab National Bank', NULL, 'Abdullah AlTahan',
  6, 2026, 'Pending outsourcing billing for Abdullah AlTahan — 1 month as of July 2026',
  47150.00, 0.00, 47150.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Majd Alden | 1 month | Invoiced | Active
('a1b2c3d4-0009-4000-8000-100000000009', 'INV-PEND-2607-009', NULL, 'Arab National Bank', NULL, 'Majd Alden',
  6, 2026, 'Pending outsourcing billing for Majd Alden — 1 month as of July 2026',
  59500.00, 0.00, 59500.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Mujeebur Rehman | 3.13 months | Not Invoiced | Pending contract
('a1b2c3d4-0010-4000-8000-100000000010', 'INV-PEND-2607-010', NULL, 'Arab National Bank', NULL, 'Mujeebur Rehman',
  4, 2026, 'Pending outsourcing billing for Mujeebur Rehman — 3.13 months as of July 2026',
  228316.66, 0.00, 228316.66, 'SAR', 'overdue',
  '2026-04-01', '2026-05-01',
  'Contract: Pending | Excel status: Not Invoiced | Months pending: 3.13', 'import', 'Data Import'),

-- ─── Riyad Bank ───────────────────────────────────────────────────────────

-- Sandeep Puppala | 1 month | Not Invoiced | Active
('a1b2c3d4-0011-4000-8000-100000000011', 'INV-PEND-2607-011', NULL, 'Riyad Bank', NULL, 'Sandeep Puppala',
  6, 2026, 'Pending outsourcing billing for Sandeep Puppala — 1 month as of July 2026',
  42000.00, 0.00, 42000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Not Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Zakir Hussain | 1 month | Invoiced | Active
('a1b2c3d4-0012-4000-8000-100000000012', 'INV-PEND-2607-012', NULL, 'Riyad Bank', NULL, 'Zakir Hussain',
  6, 2026, 'Pending outsourcing billing for Zakir Hussain — 1 month as of July 2026',
  44000.00, 0.00, 44000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Hala Abu Khalaf | 2 months | Not Invoiced | Active
('a1b2c3d4-0013-4000-8000-100000000013', 'INV-PEND-2607-013', NULL, 'Riyad Bank', NULL, 'Hala Abu Khalaf',
  5, 2026, 'Pending outsourcing billing for Hala Abu Khalaf — 2 months as of July 2026',
  60000.00, 0.00, 60000.00, 'SAR', 'overdue',
  '2026-05-05', '2026-06-05',
  'Contract: Active | Excel status: Not Invoiced | Months pending: 2', 'import', 'Data Import'),

-- Uzair Bin Sohail | 1 month | Invoiced | Active
('a1b2c3d4-0014-4000-8000-100000000014', 'INV-PEND-2607-014', NULL, 'Riyad Bank', NULL, 'Uzair Bin Sohail',
  6, 2026, 'Pending outsourcing billing for Uzair Bin Sohail — 1 month as of July 2026',
  46000.00, 0.00, 46000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Syeda Zeba | 2 months | Invoiced | Active
('a1b2c3d4-0015-4000-8000-100000000015', 'INV-PEND-2607-015', NULL, 'Riyad Bank', NULL, 'Syeda Zeba',
  5, 2026, 'Pending outsourcing billing for Syeda Zeba — 2 months as of July 2026',
  56250.00, 0.00, 56250.00, 'SAR', 'overdue',
  '2026-05-05', '2026-06-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 2', 'import', 'Data Import'),

-- Venkateswara Reddy | 1 month | Invoiced | Active
('a1b2c3d4-0016-4000-8000-100000000016', 'INV-PEND-2607-016', NULL, 'Riyad Bank', NULL, 'Venkateswara Reddy',
  6, 2026, 'Pending outsourcing billing for Venkateswara Reddy — 1 month as of July 2026',
  42000.00, 0.00, 42000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- John Seleb | 5 months | Not Invoiced | Expired
('a1b2c3d4-0017-4000-8000-100000000017', 'INV-PEND-2607-017', NULL, 'Riyad Bank', NULL, 'John Seleb',
  2, 2026, 'Pending outsourcing billing for John Seleb — 5 months as of July 2026',
  135000.00, 0.00, 135000.00, 'SAR', 'overdue',
  '2026-02-05', '2026-03-07',
  'Contract: Expired | Excel status: Not Invoiced | Months pending: 5', 'import', 'Data Import'),

-- Marwa Shaltout | 4 months | Not Invoiced | Expired
('a1b2c3d4-0018-4000-8000-100000000018', 'INV-PEND-2607-018', NULL, 'Riyad Bank', NULL, 'Marwa Shaltout',
  3, 2026, 'Pending outsourcing billing for Marwa Shaltout — 4 months as of July 2026',
  108000.00, 0.00, 108000.00, 'SAR', 'overdue',
  '2026-03-05', '2026-04-05',
  'Contract: Expired | Excel status: Not Invoiced | Months pending: 4', 'import', 'Data Import'),

-- Amarnath Rao | 1 month | Invoiced | Active
('a1b2c3d4-0019-4000-8000-100000000019', 'INV-PEND-2607-019', NULL, 'Riyad Bank', NULL, 'Amarnath Rao',
  6, 2026, 'Pending outsourcing billing for Amarnath Rao — 1 month as of July 2026',
  41500.00, 0.00, 41500.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Amal ALWaheed | 1 month | Not Invoiced | Active
('a1b2c3d4-0020-4000-8000-100000000020', 'INV-PEND-2607-020', NULL, 'Riyad Bank', NULL, 'Amal ALWaheed',
  6, 2026, 'Pending outsourcing billing for Amal ALWaheed — 1 month as of July 2026',
  28400.00, 0.00, 28400.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Not Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Yasmine Khaldi | 1 month | Invoiced | Active
('a1b2c3d4-0021-4000-8000-100000000021', 'INV-PEND-2607-021', NULL, 'Riyad Bank', NULL, 'Yasmine Khaldi',
  6, 2026, 'Pending outsourcing billing for Yasmine Khaldi — 1 month as of July 2026',
  28000.00, 0.00, 28000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Mohammed Alshammari | 2 months | Invoiced | Active
('a1b2c3d4-0022-4000-8000-100000000022', 'INV-PEND-2607-022', NULL, 'Riyad Bank', NULL, 'Mohammed Alshammari',
  5, 2026, 'Pending outsourcing billing for Mohammed Alshammari — 2 months as of July 2026',
  58332.00, 0.00, 58332.00, 'SAR', 'overdue',
  '2026-05-05', '2026-06-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 2', 'import', 'Data Import'),

-- Nawaf ALMagooshi | 1 month | Invoiced | Active
('a1b2c3d4-0023-4000-8000-100000000023', 'INV-PEND-2607-023', NULL, 'Riyad Bank', NULL, 'Nawaf ALMagooshi',
  6, 2026, 'Pending outsourcing billing for Nawaf ALMagooshi — 1 month as of July 2026',
  20900.00, 0.00, 20900.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Syed Faraz Shah | 1 month | Invoiced | Active
('a1b2c3d4-0024-4000-8000-100000000024', 'INV-PEND-2607-024', NULL, 'Riyad Bank', NULL, 'Syed Faraz Shah',
  6, 2026, 'Pending outsourcing billing for Syed Faraz Shah — 1 month as of July 2026',
  17000.00, 0.00, 17000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import'),

-- Muzammil Basha | 1 month | Not Invoiced | Pending contract
('a1b2c3d4-0025-4000-8000-100000000025', 'INV-PEND-2607-025', NULL, 'Riyad Bank', NULL, 'Muzammil Basha',
  6, 2026, 'Pending outsourcing billing for Muzammil Basha — 1 month as of July 2026',
  40000.00, 0.00, 40000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Pending | Excel status: Not Invoiced | Months pending: 1', 'import', 'Data Import'),

-- ─── Al Rajhi Bank ────────────────────────────────────────────────────────

-- Balasubramanian | 3.2 months | Invoiced | Active
('a1b2c3d4-0026-4000-8000-100000000026', 'INV-PEND-2607-026', NULL, 'Al Rajhi Bank', NULL, 'Balasubramanian',
  4, 2026, 'Pending outsourcing billing for Balasubramanian — 3.2 months as of July 2026',
  51000.00, 0.00, 51000.00, 'SAR', 'overdue',
  '2026-03-29', '2026-04-28',
  'Contract: Active | Excel status: Invoiced | Months pending: 3.2', 'import', 'Data Import'),

-- Ravi Shankar | 1.07 months | Invoiced | Active
('a1b2c3d4-0027-4000-8000-100000000027', 'INV-PEND-2607-027', NULL, 'Al Rajhi Bank', NULL, 'Ravi Shankar',
  6, 2026, 'Pending outsourcing billing for Ravi Shankar — 1.07 months as of July 2026',
  52800.00, 0.00, 52800.00, 'SAR', 'sent',
  '2026-06-03', '2026-07-03',
  'Contract: Active | Excel status: Invoiced | Months pending: 1.07', 'import', 'Data Import'),

-- ─── SAB ──────────────────────────────────────────────────────────────────

-- Nandha Kumar | 1 month | Invoiced | Active
('a1b2c3d4-0028-4000-8000-100000000028', 'INV-PEND-2607-028', NULL, 'SAB', NULL, 'Nandha Kumar',
  6, 2026, 'Pending outsourcing billing for Nandha Kumar — 1 month as of July 2026',
  45000.00, 0.00, 45000.00, 'SAR', 'sent',
  '2026-06-05', '2026-07-05',
  'Contract: Active | Excel status: Invoiced | Months pending: 1', 'import', 'Data Import')

-- NOTE: Atif Minhaj, Talha Minaam, Shazad Moheeb (SAB) have SAR 0 pending amount
-- and are excluded from this import. Their invoices should be created separately
-- once billing amounts are confirmed.
;

-- Log an import event for each inserted invoice
INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_name, note)
SELECT
  concat('evt-pend-', id),
  id,
  'created',
  'import',
  'Data Import',
  'Imported from Payment Pending Report July 2026'
FROM invoices
WHERE reference LIKE 'INV-PEND-2607-%';
