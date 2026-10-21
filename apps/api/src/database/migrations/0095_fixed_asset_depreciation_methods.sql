-- Depreciation methods per asset (R-11; ADR 0008 FA-12; master specification section 21).
-- Forward-only. Every existing asset takes the default 'straight_line' with no rate, so its
-- schedule is unchanged; no data is updated. The method and the rate are financial terms: like
-- cost, salvage and life they are fixed once the asset is capitalized (fixed_assets_guard below
-- is the 0051 version plus the two new columns).

ALTER TABLE fixed_assets
  ADD COLUMN depreciation_method text NOT NULL DEFAULT 'straight_line'
    CHECK (depreciation_method IN ('straight_line', 'declining_balance', 'double_declining_balance')),
  -- Annual percentage for ordinary declining balance only: greater than 0, at most 100, up to
  -- four decimals. Double-declining derives its rate from the life and stores none.
  ADD COLUMN declining_rate numeric(7, 4);

ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_declining_rate_check CHECK (
  ((depreciation_method = 'declining_balance') = (declining_rate IS NOT NULL))
  AND (declining_rate IS NULL OR (declining_rate > 0 AND declining_rate <= 100))
);

CREATE OR REPLACE FUNCTION fixed_assets_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fixed assets are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.acquisition_date, NEW.in_service_date, NEW.cost,
      NEW.salvage_value, NEW.life_months, NEW.acquisition_journal_id, NEW.in_ledger, NEW.created_at,
      NEW.created_by_user_id, NEW.source_bill_id, NEW.depreciation_method, NEW.declining_rate)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.acquisition_date, OLD.in_service_date, OLD.cost,
      OLD.salvage_value, OLD.life_months, OLD.acquisition_journal_id, OLD.in_ledger, OLD.created_at,
      OLD.created_by_user_id, OLD.source_bill_id, OLD.depreciation_method, OLD.declining_rate) THEN
    RAISE EXCEPTION 'the terms of fixed asset % are fixed once capitalized', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'DISPOSED' AND NEW.status = 'DISPOSED'
     AND (NEW.accumulated_depreciation, NEW.category_id) IS DISTINCT FROM (OLD.accumulated_depreciation, OLD.category_id) THEN
    RAISE EXCEPTION 'disposed fixed asset % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
