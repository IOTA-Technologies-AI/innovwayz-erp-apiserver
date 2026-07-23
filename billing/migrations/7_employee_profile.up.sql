-- =============================================================
-- Migration 7: Employee profile fields (from the candidates sheet)
--   nationality    – e.g. Indian, Saudi, Syrian (drives ticket eligibility etc.)
--   family_status  – e.g. Single / Family / With family (free text for now)
-- Iqama (national_id), band, location, mobile_number, email already exist.
-- =============================================================

ALTER TABLE employees
  ADD COLUMN nationality   TEXT,
  ADD COLUMN family_status TEXT;
