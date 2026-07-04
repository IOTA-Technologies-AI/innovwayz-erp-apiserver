-- ─── Expense type catalog ─────────────────────────────────────────────────────
-- Common, reusable expense types (KSA IT services / consulting context).
-- applies_to: 'employee' | 'company' | 'both'
CREATE TABLE expense_types (
    id          TEXT PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    applies_to  TEXT NOT NULL DEFAULT 'both'
                CHECK (applies_to IN ('employee', 'company', 'both')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Expenses ─────────────────────────────────────────────────────────────────
-- category:   'employee' (tied to an employee) | 'company' (general/overhead)
-- expense_class: petty | infrastructure | management | operational | employee | other
-- status flow: pending_manager → pending_admin → approved → processing → paid
--              (rejected / cancelled are terminal)
CREATE TABLE expenses (
    id                  TEXT PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,
    category            TEXT NOT NULL DEFAULT 'company'
                        CHECK (category IN ('employee', 'company')),
    expense_class       TEXT NOT NULL DEFAULT 'operational'
                        CHECK (expense_class IN ('petty', 'infrastructure', 'management', 'operational', 'employee', 'other')),
    expense_type_code   TEXT,
    expense_type_name   TEXT NOT NULL,

    -- optional employee link (denormalized snapshot for history)
    employee_id         TEXT,
    employee_name       TEXT,

    -- optional customer/account link
    customer_id         TEXT,
    customer_name       TEXT,

    title               TEXT NOT NULL,
    description         TEXT,
    amount              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'SAR',
    expense_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    vendor              TEXT,
    payment_method      TEXT,
    attachment_url      TEXT,

    status              TEXT NOT NULL DEFAULT 'pending_manager'
                        CHECK (status IN ('pending_manager', 'pending_admin', 'approved', 'processing', 'paid', 'rejected', 'cancelled')),

    -- audit / workflow trail
    created_by          TEXT NOT NULL,
    created_by_name     TEXT,
    manager_approved_by TEXT,
    manager_approved_at TIMESTAMPTZ,
    admin_approved_by   TEXT,
    admin_approved_at   TIMESTAMPTZ,
    rejected_by         TEXT,
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    processed_by        TEXT,
    processed_at        TIMESTAMPTZ,
    payment_reference   TEXT,
    paid_amount         NUMERIC(14, 2),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expenses_status       ON expenses (status);
CREATE INDEX idx_expenses_category     ON expenses (category);
CREATE INDEX idx_expenses_employee     ON expenses (employee_id);
CREATE INDEX idx_expenses_expense_date ON expenses (expense_date);
CREATE INDEX idx_expenses_created_by   ON expenses (created_by);

-- ─── Expense audit log ────────────────────────────────────────────────────────
CREATE TABLE expense_events (
    id          TEXT PRIMARY KEY,
    expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expense_events_expense ON expense_events (expense_id);

-- Sequence for human-friendly reference numbers (EXP-YYYY-000001)
CREATE SEQUENCE expense_reference_seq START 1;

-- ─── Seed common KSA expense types ────────────────────────────────────────────
INSERT INTO expense_types (id, code, name, applies_to, sort_order) VALUES
    ('et_wakala',        'WAKALA_FEE',        'Wakala Fee',                    'employee',  10),
    ('et_saudization',   'SAUDIZATION_FEE',   'Saudization / Nitaqat Fee',     'company',   20),
    ('et_air_ticket',    'AIR_TICKET',        'Air Ticket',                    'employee',  30),
    ('et_exit_reentry',  'EXIT_REENTRY',      'Exit / Re-Entry Fee',           'employee',  40),
    ('et_insurance',     'INSURANCE',         'Medical Insurance',             'employee',  50),
    ('et_gosi',          'GOSI',              'GOSI Contribution',             'employee',  60),
    ('et_iqama_issue',   'IQAMA_ISSUE',       'Iqama Issuance',                'employee',  70),
    ('et_iqama_renew',   'IQAMA_RENEW',       'Iqama Renewal',                 'employee',  80),
    ('et_iqama_charges', 'IQAMA_CHARGES',     'Iqama Charges',                 'employee',  90),
    ('et_work_permit',   'WORK_PERMIT',       'Work Permit Fee',               'employee', 100),
    ('et_visa',          'VISA_FEE',          'Visa Fee',                      'employee', 110),
    ('et_medical_test',  'MEDICAL_TEST',      'Medical Test',                  'employee', 120),
    ('et_labor_office',  'LABOR_OFFICE',      'Labor Office Fee',              'company',  130),
    ('et_chamber',       'CHAMBER_COMMERCE',  'Chamber of Commerce Fee',       'company',  140),
    ('et_muqeem',        'MUQEEM',            'Muqeem / Absher Fee',           'employee', 150),
    ('et_eos',           'END_OF_SERVICE',    'End of Service Benefit',        'employee', 160),
    ('et_bank_charges',  'BANK_CHARGES',      'Bank Charges',                  'company',  170),
    ('et_office_rent',   'OFFICE_RENT',       'Office Rent',                   'company',  180),
    ('et_utilities',     'UTILITIES',         'Utilities',                     'company',  190),
    ('et_software',      'SOFTWARE',          'Software / Subscriptions',      'company',  200),
    ('et_hardware',      'HARDWARE',          'Hardware / Equipment',          'company',  210),
    ('et_legal',         'LEGAL_PROFESSIONAL','Legal / Professional Fees',     'company',  220),
    ('et_marketing',     'MARKETING',         'Marketing',                     'company',  230),
    ('et_travel',        'TRAVEL',            'Travel & Transport',            'both',     240),
    ('et_training',      'TRAINING',          'Training & Development',        'employee', 250),
    ('et_accommodation', 'ACCOMMODATION',     'Accommodation',                 'employee', 260),
    ('et_petty_cash',    'PETTY_CASH',        'Petty Cash',                    'company',  270),
    ('et_stationery',    'STATIONERY',        'Office Supplies / Stationery',  'company',  280),
    ('et_communication', 'COMMUNICATION',     'Communication (Mobile / Internet)', 'both', 290),
    ('et_other',         'OTHER',             'Other',                         'both',     999);
