-- Refine expense types to match the actual PNL ledger terminology.
-- (Adds company-specific KSA types observed in PNLStatementProjectWise.)
INSERT INTO expense_types (id, code, name, applies_to, sort_order) VALUES
    ('et_sponsor_fee',      'SPONSOR_FEE',         'Sponsor Fee (Wakala)',         'employee',  12),
    ('et_sponsor_transfer', 'SPONSORSHIP_TRANSFER','Sponsorship Transfer',         'employee',  14),
    ('et_levy',             'EXPAT_LEVY',          'Expat Levy',                   'employee',  22),
    ('et_mofa',             'MOFA_FEE',            'MOFA Fee',                     'employee',  95),
    ('et_onboarding',       'ONBOARDING',          'Onboarding (Airport / Welcome)', 'employee', 265),
    ('et_adv_salary',       'ADVANCE_SALARY',      'Advance Salary',               'employee', 155),
    ('et_referral',         'REFERRAL_BONUS',      'Referral Bonus',               'company',  232),
    ('et_commission',       'COMMISSION',          'Commission',                   'company',  234),
    ('et_transportation',   'TRANSPORTATION',      'Transportation',               'both',     242),
    ('et_documents',        'DOCUMENTS_MGMT',      'Documents Management',         'company',  236),
    ('et_sec',              'SEC_CHARGES',         'SEC / Electricity Charges',    'company',  192),
    ('et_vehicle',          'VEHICLE',             'Vehicle / Car Installment',    'company',  238),
    ('et_team_building',    'TEAM_BUILDING',       'Team Building',                'company',  240),
    ('et_recovery',         'RECOVERY',            'Recovered Amount',             'company',  900)
ON CONFLICT (code) DO NOTHING;
