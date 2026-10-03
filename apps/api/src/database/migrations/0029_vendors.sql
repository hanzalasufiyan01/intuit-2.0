-- 0029_vendors — Phase 4A-3: vendors on the shared Party master. ADR 0004 P4-03, P4-20, P4-19,
-- P4-39, P4-43; Decisions 8, 28; R36.
--
-- * vendors: the Purchases/AP record of a Party that holds the `vendor` role. Identity (name, TIN,
--   contacts, addresses) stays on the Party; currency (the default for future bills, P4-20),
--   payment terms, a warning-only credit limit, the organization's account number with the vendor,
--   and default expense account / tax code (brief §6) live here. One vendor per party; a party can
--   be a customer and a vendor at the same time.
-- * Vendors are archived, never deleted. Their identity (id, organization, party) never changes.
-- * The Party keeps its `vendor` role while a vendor record exists (checked at commit, as for
--   customers in 0021).
-- * No bank or payment details (P4-43, deferred to Banking).

CREATE TABLE vendors (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES accounting_settings (organization_id),
  party_id                    uuid NOT NULL,
  currency_code               char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- NULL: the Purchases settings default applies.
  payment_terms_days          integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  -- In the vendor currency; a warning only.
  credit_limit                numeric(28, 4) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  account_number              text CHECK (account_number IS NULL OR length(btrim(account_number)) BETWEEN 1 AND 50),
  default_expense_account_id  uuid,
  default_tax_code_id         uuid,
  status                      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id          uuid NOT NULL REFERENCES users (id),
  created_at                  timestamptz NOT NULL,
  updated_by_user_id          uuid REFERENCES users (id),
  updated_at                  timestamptz NOT NULL,
  archived_by_user_id         uuid REFERENCES users (id),
  archived_at                 timestamptz,
  CONSTRAINT vendors_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT vendors_party_key UNIQUE (organization_id, party_id),
  CONSTRAINT vendors_party_fkey FOREIGN KEY (party_id, organization_id)
    REFERENCES parties (id, organization_id),
  CONSTRAINT vendors_expense_account_fkey FOREIGN KEY (default_expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT vendors_tax_code_fkey FOREIGN KEY (default_tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT vendors_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX vendors_list_idx ON vendors (organization_id, status);

CREATE FUNCTION vendors_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendors are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.party_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.party_id, OLD.created_at) THEN
    RAISE EXCEPTION 'vendor % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vendors_guard
  BEFORE UPDATE OR DELETE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_guard();

-- The Party keeps its `vendor` role while a vendor record exists. Checked at commit, because
-- party roles are replaced as a set (delete, then insert).
CREATE FUNCTION vendors_check_party_role() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_party uuid;
  v_org   uuid;
BEGIN
  IF TG_TABLE_NAME = 'vendors' THEN
    v_party := NEW.party_id;
    v_org := NEW.organization_id;
  ELSE
    IF OLD.role <> 'vendor' THEN
      RETURN NULL;
    END IF;
    v_party := OLD.party_id;
    v_org := OLD.organization_id;
  END IF;
  IF EXISTS (SELECT 1 FROM vendors v WHERE v.party_id = v_party AND v.organization_id = v_org)
     AND NOT EXISTS (SELECT 1 FROM party_roles r
                      WHERE r.party_id = v_party AND r.organization_id = v_org AND r.role = 'vendor') THEN
    RAISE EXCEPTION 'party % has a vendor record and must keep the vendor role', v_party
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER vendors_party_role_check
  AFTER INSERT ON vendors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vendors_check_party_role();
CREATE CONSTRAINT TRIGGER party_roles_vendor_check
  AFTER DELETE ON party_roles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vendors_check_party_role();

CREATE TRIGGER vendors_no_truncate BEFORE TRUNCATE ON vendors
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendors_tenant ON vendors FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON vendors FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON vendors TO intuit_app;
