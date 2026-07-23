-- =============================================================
-- Migration 10: Backfill serial_no for employees imported/created
-- without one (the candidates-sheet new hires). serial_no is nullable
-- and the API now tolerates NULL, but assigning sequential numbers
-- after the current max keeps the roster clean and ordered.
-- =============================================================

WITH base AS (
  SELECT COALESCE(MAX(serial_no), 0) AS m FROM employees
),
numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, name) AS rn
  FROM employees
  WHERE serial_no IS NULL
)
UPDATE employees e
SET serial_no = base.m + numbered.rn
FROM numbered, base
WHERE e.id = numbered.id;
