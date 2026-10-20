-- 0087_tax_treatment — keeps "zero-rated" and "exempt" apart (master specification section 15).
--
-- The specification requires that 0% / zero-rated and exempt treatment stay distinguishable, and
-- that tax types and reporting categories exist. This migration adds three CLASSIFICATION fields
-- to a tax code. It changes no rate, no posting and no historical document, and it encodes NO
-- Maldives (or other) tax rule: which of the labels applies to which supply is the organization's
-- (or its tax adviser's) decision.
--
-- * treatment: standard (taxed at the code's rate; every legacy code), zero_rated, exempt or
--   out_of_scope. A code with any treatment other than standard has a 0% rate in every version.
-- * tax_type: a free label ("GST", "Green tax"...), at most 40 characters.
-- * reporting_category: a free label that a future return mapping can use, at most 60.
--
-- The treatment is fixed when the code is created (a different treatment is a different code), so
-- a report over past documents cannot change meaning later.

ALTER TABLE tax_codes
  ADD COLUMN treatment text NOT NULL DEFAULT 'standard'
    CHECK (treatment IN ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  ADD COLUMN tax_type text CHECK (tax_type IS NULL OR length(btrim(tax_type)) BETWEEN 1 AND 40),
  ADD COLUMN reporting_category text
    CHECK (reporting_category IS NULL OR length(btrim(reporting_category)) BETWEEN 1 AND 60);

-- A non-standard treatment never carries a rate above zero.
CREATE FUNCTION tax_rate_matches_treatment() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  SELECT treatment INTO t FROM tax_codes
   WHERE id = NEW.tax_code_id AND organization_id = NEW.organization_id;
  IF t IS NOT NULL AND t <> 'standard' AND NEW.rate <> 0 THEN
    RAISE EXCEPTION 'a % tax code has a 0%% rate in every version', t
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tax_code_rates_treatment BEFORE INSERT ON tax_code_rates
  FOR EACH ROW EXECUTE FUNCTION tax_rate_matches_treatment();

-- The treatment never changes after creation.
CREATE OR REPLACE FUNCTION tax_guard_code() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax codes are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.code, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.code, OLD.created_at) THEN
    RAISE EXCEPTION 'tax code % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.treatment IS DISTINCT FROM OLD.treatment THEN
    RAISE EXCEPTION 'the treatment of tax code % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
