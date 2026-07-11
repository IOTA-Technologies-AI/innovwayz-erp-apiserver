-- BDM → Employee assignment table.
-- A BDM can manage and view only employees assigned to them.
-- Stored in the billing service DB alongside employees.

CREATE TABLE IF NOT EXISTS bdm_assignments (
    bdm_user_id  TEXT        NOT NULL,
    employee_id  UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    assigned_by  TEXT,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bdm_user_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_bdm_assignments_bdm      ON bdm_assignments(bdm_user_id);
CREATE INDEX IF NOT EXISTS idx_bdm_assignments_employee ON bdm_assignments(employee_id);
