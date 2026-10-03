-- 0030_purchases_settings_catalog — Phase 4A-4: Purchases settings and numbering, and the purchase
-- side of the shared items catalog. ADR 0004 P4-05, P4-07, P4-08, P4-19, P4-26, P4-51; R37.
--
-- * purchases_settings: one row per organization, created on the first save. The AP control
--   account (marked through accounting's generalized subledger-control operation, owned by
--   `purchases`, P4-08), default expense and payment accounts, default tax code, treatment and
--   payment terms. `ap_locked_at` is set by the first Purchases posting (a later stage); from then
--   on the AP control account cannot change (mirrors Phase 3B D12).
-- * purchases_number_sequences: bill, vendor credit, debit note, vendor payment, vendor refund and
--   expense numbering (P4-51). A number is assigned at posting or recording, never to drafts; the
--   next number only moves forward; numbering is not gapless (R37).
-- * sales_items (the shared catalog, P4-05; table name unchanged): sold/purchased facets and
--   purchase-side defaults. Every existing item stays sold and is not purchased. No inventory.
-- Everything is additive; nothing is deleted.

-- ---------------------------------------------------------------------------
-- Purchases settings
-- ---------------------------------------------------------------------------

CREATE TABLE purchases_settings (
  organization_id              uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  ap_account_id                uuid,
  default_expense_account_id   uuid,
  default_payment_account_id   uuid,
  default_tax_code_id          uuid,
  default_tax_treatment        text NOT NULL DEFAULT 'exclusive'
                                 CHECK (default_tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  default_payment_terms_days   integer NOT NULL DEFAULT 30
                                 CHECK (default_payment_terms_days BETWEEN 0 AND 365),
  ap_locked_at                 timestamptz,
  version                      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id           uuid NOT NULL REFERENCES users (id),
  created_at                   timestamptz NOT NULL,
  updated_by_user_id           uuid REFERENCES users (id),
  updated_at                   timestamptz NOT NULL,
  CONSTRAINT purchases_settings_ap_account_fkey FOREIGN KEY (ap_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_settings_expense_account_fkey FOREIGN KEY (default_expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_settings_payment_account_fkey FOREIGN KEY (default_payment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_settings_tax_code_fkey FOREIGN KEY (default_tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT purchases_settings_lock_needs_account CHECK (ap_locked_at IS NULL OR ap_account_id IS NOT NULL)
);

CREATE FUNCTION purchases_guard_settings() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchases settings are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.created_at) THEN
    RAISE EXCEPTION 'purchases settings identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ap_locked_at IS NOT NULL AND (
       NEW.ap_locked_at IS DISTINCT FROM OLD.ap_locked_at
       OR NEW.ap_account_id IS DISTINCT FROM OLD.ap_account_id) THEN
    RAISE EXCEPTION 'the AP control account is fixed once Purchases documents have been posted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_settings_guard
  BEFORE UPDATE OR DELETE ON purchases_settings
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_settings();

-- ---------------------------------------------------------------------------
-- Purchases document numbering (P4-51)
-- ---------------------------------------------------------------------------

CREATE TABLE purchases_number_sequences (
  organization_id     uuid NOT NULL REFERENCES purchases_settings (organization_id),
  document_type       text NOT NULL CHECK (document_type IN (
                        'bill', 'vendor_credit', 'debit_note', 'vendor_payment', 'vendor_refund', 'expense')),
  prefix              text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Za-z0-9/_.#-]{0,12}$'),
  min_digits          integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 10),
  next_number         bigint NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 999999999999),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, document_type)
);

CREATE FUNCTION purchases_guard_number_sequence() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'number sequences are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.document_type) IS DISTINCT FROM (OLD.organization_id, OLD.document_type) THEN
    RAISE EXCEPTION 'number sequence identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_number < OLD.next_number THEN
    RAISE EXCEPTION 'the next % number cannot move backwards', OLD.document_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_number_sequences_guard
  BEFORE UPDATE OR DELETE ON purchases_number_sequences
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_number_sequence();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases_settings', 'purchases_number_sequences'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO intuit_app', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- The shared catalog's purchase side (P4-05)
-- ---------------------------------------------------------------------------

ALTER TABLE sales_items
  ADD COLUMN is_sold boolean NOT NULL DEFAULT true,
  ADD COLUMN is_purchased boolean NOT NULL DEFAULT false,
  ADD COLUMN purchase_description text NOT NULL DEFAULT '' CHECK (length(purchase_description) <= 1000),
  -- Default purchase cost in the base currency; bill lines may override it.
  ADD COLUMN purchase_unit_cost numeric(28, 4) CHECK (purchase_unit_cost IS NULL OR purchase_unit_cost >= 0),
  ADD COLUMN expense_account_id uuid,
  ADD COLUMN purchase_tax_code_id uuid,
  ADD CONSTRAINT sales_items_expense_account_fkey FOREIGN KEY (expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  ADD CONSTRAINT sales_items_purchase_tax_code_fkey FOREIGN KEY (purchase_tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  ADD CONSTRAINT sales_items_has_facet CHECK (is_sold OR is_purchased);
