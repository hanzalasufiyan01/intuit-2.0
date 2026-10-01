-- 0021_customers_items_sales_settings — Phase 3B steps 3–5: Sales settings and numbering,
-- customers and the items catalog. Decisions 8, 11, 14, 28, 31, 32, 42, 48, 52 (R36, R37); ADR 0003
-- D2, D3, D4, D7, D9; Phase 3B D6, D8, D12, E3.
--
-- * sales_settings: one row per organization, created on the first save. Default AR control,
--   revenue and deposit accounts, default tax code, tax treatment and payment terms. Missing
--   accounts block issue (D7). Once the first Sales document is issued, `ar_locked_at` is set and
--   the AR control account can no longer change (Phase 3B D12).
-- * sales_number_sequences: invoice, credit note and receipt numbering (D3). A number is assigned at
--   issue; numbering is not gapless (R37) and the next number only moves forward.
-- * customers: the customer record on the shared Party master (Decisions 8, 28; R36). Identity
--   (name, contacts, addresses, TIN) stays on the Party; currency, terms and credit limit (warning
--   only, Decision 48) live here. The Party keeps its `customer` role while a customer exists.
-- * sales_items: the product/service catalog without inventory (D4, Decision 31).
-- Everything is archived, never deleted.

-- ---------------------------------------------------------------------------
-- Sales settings
-- ---------------------------------------------------------------------------

CREATE TABLE sales_settings (
  organization_id              uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  ar_account_id                uuid,
  default_revenue_account_id   uuid,
  default_deposit_account_id   uuid,
  default_tax_code_id          uuid,
  default_tax_treatment        text NOT NULL DEFAULT 'exclusive'
                                 CHECK (default_tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  default_payment_terms_days   integer NOT NULL DEFAULT 30
                                 CHECK (default_payment_terms_days BETWEEN 0 AND 365),
  -- Set when the first Sales document is issued; the AR control account is fixed from then on.
  ar_locked_at                 timestamptz,
  version                      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id           uuid NOT NULL REFERENCES users (id),
  created_at                   timestamptz NOT NULL,
  updated_by_user_id           uuid REFERENCES users (id),
  updated_at                   timestamptz NOT NULL,
  CONSTRAINT sales_settings_ar_account_fkey FOREIGN KEY (ar_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_settings_revenue_account_fkey FOREIGN KEY (default_revenue_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_settings_deposit_account_fkey FOREIGN KEY (default_deposit_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_settings_tax_code_fkey FOREIGN KEY (default_tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT sales_settings_lock_needs_account CHECK (ar_locked_at IS NULL OR ar_account_id IS NOT NULL)
);

CREATE FUNCTION sales_guard_settings() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales settings are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.created_at) THEN
    RAISE EXCEPTION 'sales settings identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ar_locked_at IS NOT NULL AND (
       NEW.ar_locked_at IS DISTINCT FROM OLD.ar_locked_at
       OR NEW.ar_account_id IS DISTINCT FROM OLD.ar_account_id) THEN
    RAISE EXCEPTION 'the AR control account is fixed once Sales documents have been issued'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_settings_guard
  BEFORE UPDATE OR DELETE ON sales_settings
  FOR EACH ROW EXECUTE FUNCTION sales_guard_settings();

-- ---------------------------------------------------------------------------
-- Number sequences (D3, R37)
-- ---------------------------------------------------------------------------

CREATE TABLE sales_number_sequences (
  organization_id     uuid NOT NULL REFERENCES sales_settings (organization_id),
  document_type       text NOT NULL CHECK (document_type IN ('invoice', 'credit_note', 'receipt')),
  prefix              text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Za-z0-9/_.#-]{0,12}$'),
  min_digits          integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 10),
  next_number         bigint NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 999999999999),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, document_type)
);

CREATE FUNCTION sales_guard_number_sequence() RETURNS trigger
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
CREATE TRIGGER sales_number_sequences_guard
  BEFORE UPDATE OR DELETE ON sales_number_sequences
  FOR EACH ROW EXECUTE FUNCTION sales_guard_number_sequence();

-- ---------------------------------------------------------------------------
-- Customers (Decisions 8, 28, 48; D2; Phase 3B D6)
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES accounting_settings (organization_id),
  party_id             uuid NOT NULL,
  currency_code        char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- NULL: the Sales settings default applies.
  payment_terms_days   integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  -- In the customer currency; a warning only (Decision 48).
  credit_limit         numeric(28, 4) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  archived_by_user_id  uuid REFERENCES users (id),
  archived_at          timestamptz,
  CONSTRAINT customers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT customers_party_key UNIQUE (organization_id, party_id),
  CONSTRAINT customers_party_fkey FOREIGN KEY (party_id, organization_id)
    REFERENCES parties (id, organization_id),
  CONSTRAINT customers_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX customers_list_idx ON customers (organization_id, status);

CREATE FUNCTION sales_guard_customer() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customers are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.party_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.party_id, OLD.created_at) THEN
    RAISE EXCEPTION 'customer % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customers_guard
  BEFORE UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION sales_guard_customer();

-- The Party keeps its `customer` role while a customer record exists. Checked at commit, because
-- party roles are replaced as a set (delete, then insert).
CREATE FUNCTION sales_check_customer_role() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_party uuid;
  v_org   uuid;
BEGIN
  IF TG_TABLE_NAME = 'customers' THEN
    v_party := NEW.party_id;
    v_org := NEW.organization_id;
  ELSE
    IF OLD.role <> 'customer' THEN
      RETURN NULL;
    END IF;
    v_party := OLD.party_id;
    v_org := OLD.organization_id;
  END IF;
  IF EXISTS (SELECT 1 FROM customers c WHERE c.party_id = v_party AND c.organization_id = v_org)
     AND NOT EXISTS (SELECT 1 FROM party_roles r
                      WHERE r.party_id = v_party AND r.organization_id = v_org AND r.role = 'customer') THEN
    RAISE EXCEPTION 'party % has a customer record and must keep the customer role', v_party
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER customers_party_role_check
  AFTER INSERT ON customers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_check_customer_role();
CREATE CONSTRAINT TRIGGER party_roles_customer_check
  AFTER DELETE ON party_roles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_check_customer_role();

-- ---------------------------------------------------------------------------
-- Items catalog (D4, Decision 31; Phase 3B D8). No inventory.
-- ---------------------------------------------------------------------------

CREATE TABLE sales_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES accounting_settings (organization_id),
  sku                  text CHECK (sku IS NULL OR sku ~ '^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,49}$' AND sku = btrim(sku)),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  item_type            text NOT NULL CHECK (item_type IN ('service', 'product')),
  description          text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- Default unit price in the base currency; lines may override it.
  unit_price           numeric(28, 4) CHECK (unit_price IS NULL OR unit_price >= 0),
  -- NULL: the Sales settings default revenue account applies.
  revenue_account_id   uuid,
  tax_code_id          uuid,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  archived_by_user_id  uuid REFERENCES users (id),
  archived_at          timestamptz,
  CONSTRAINT sales_items_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_items_revenue_account_fkey FOREIGN KEY (revenue_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_items_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT sales_items_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX sales_items_sku_idx ON sales_items (organization_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE INDEX sales_items_list_idx ON sales_items (organization_id, status, lower(name), id);

CREATE FUNCTION sales_guard_item() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'items are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at) THEN
    RAISE EXCEPTION 'item % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_items_guard
  BEFORE UPDATE OR DELETE ON sales_items
  FOR EACH ROW EXECUTE FUNCTION sales_guard_item();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_settings', 'sales_number_sequences', 'customers', 'sales_items'] LOOP
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
