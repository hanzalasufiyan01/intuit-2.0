-- 0051_fixed_asset_source_bill — guard against capitalizing an asset twice.
--
-- A bill that debits an asset cost account already capitalizes the purchase. Registering the asset
-- must then not post the acquisition again. An asset registered as already in the ledger can name
-- the posted bill that capitalized it (`source_bill_id`); the service checks that the bill really
-- debited the category cost account and that the linked assets do not exceed what the bill
-- capitalized. A bill with linked assets cannot be voided. Journals and bill accounting are
-- untouched; existing assets keep a NULL link.

ALTER TABLE fixed_assets ADD COLUMN source_bill_id uuid;
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_source_bill_fkey
  FOREIGN KEY (source_bill_id, organization_id) REFERENCES purchases_bills (id, organization_id);
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_source_bill_in_ledger
  CHECK (source_bill_id IS NULL OR (in_ledger AND acquisition_journal_id IS NULL));
CREATE INDEX fixed_assets_source_bill_idx ON fixed_assets (organization_id, source_bill_id)
  WHERE source_bill_id IS NOT NULL;

-- The link is part of the fixed terms of the asset.
CREATE OR REPLACE FUNCTION fixed_assets_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fixed assets are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.acquisition_date, NEW.in_service_date, NEW.cost,
      NEW.salvage_value, NEW.life_months, NEW.acquisition_journal_id, NEW.in_ledger, NEW.created_at,
      NEW.created_by_user_id, NEW.source_bill_id)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.acquisition_date, OLD.in_service_date, OLD.cost,
      OLD.salvage_value, OLD.life_months, OLD.acquisition_journal_id, OLD.in_ledger, OLD.created_at,
      OLD.created_by_user_id, OLD.source_bill_id) THEN
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

-- Backstop: a bill that capitalized registered assets cannot be voided.
CREATE FUNCTION purchases_refuse_bill_void_with_assets() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fixed_assets a
              WHERE a.organization_id = NEW.organization_id AND a.source_bill_id = NEW.id) THEN
    RAISE EXCEPTION 'bill % capitalized fixed assets; they cannot be unlinked', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_bills_asset_backstop
  BEFORE UPDATE OF status ON purchases_bills
  FOR EACH ROW WHEN (OLD.status = 'POSTED' AND NEW.status = 'VOID')
  EXECUTE FUNCTION purchases_refuse_bill_void_with_assets();
