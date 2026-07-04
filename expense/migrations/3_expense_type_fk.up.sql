-- Make expenses.expense_type_code a proper foreign key into the expense_types
-- catalog. Any expense_type_code that no longer maps to a catalog entry is
-- reset to 'OTHER' first so the constraint can be added cleanly.
UPDATE expenses e
   SET expense_type_code = 'OTHER'
 WHERE expense_type_code IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM expense_types t WHERE t.code = e.expense_type_code
   );

ALTER TABLE expenses
    ADD CONSTRAINT fk_expenses_expense_type
    FOREIGN KEY (expense_type_code)
    REFERENCES expense_types (code)
    ON UPDATE CASCADE
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_expense_type_code
    ON expenses (expense_type_code);
