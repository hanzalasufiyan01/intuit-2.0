-- 0049_expense_claims — Employee expense claims (approved 2026-10-07).
--
-- * An employee is a Party with the `employee` role. A claim (`EC-`) lists what the employee spent
--   (date, description, expense account, amount) with receipts attached (file link type
--   'expense_claim'); an organization can require receipts above an amount.
-- * Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED → POSTED, or CANCELLED before posting, or VOID
--   after. Submitting opens an approval request when a policy step matches (no self-approval);
--   with none the claim is approved at once.
-- * Posting reuses the AP engine: the claim becomes a posted bill from the employee as a vendor
--   (Dr each expense account / Cr the AP control account, subledgered by employee), so
--   reimbursement is an ordinary vendor payment and the employee's payable appears in the AP aging.
--   `bill_id` links the claim to that bill; the claim's own tables never write the ledger.
-- * A claim is immutable once submitted except its lifecycle columns.

CREATE TABLE expense_claim_settings (
  organization_id          uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  default_expense_account_id uuid,
  -- A claim with a line at or above this amount needs at least one receipt to be submitted.
  receipt_required_over    numeric(28, 4) CHECK (receipt_required_over IS NULL OR receipt_required_over >= 0),
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL,
  CONSTRAINT expense_claim_settings_account_fkey FOREIGN KEY (default_expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE expense_claim_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('claim')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE expense_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'VOID')),
  number                text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  employee_party_id     uuid NOT NULL,
  claim_date            date NOT NULL,
  memo                  text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  total                 numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  approval_request_id   uuid,
  submitted_by_user_id  uuid REFERENCES users (id),
  submitted_at          timestamptz,
  approved_at           timestamptz,
  bill_id               uuid,
  posted_by_user_id     uuid REFERENCES users (id),
  posted_at             timestamptz,
  cancelled_by_user_id  uuid REFERENCES users (id),
  cancelled_at          timestamptz,
  cancel_reason         text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  voided_by_user_id     uuid REFERENCES users (id),
  voided_at             timestamptz,
  void_reason           text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT expense_claims_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT expense_claims_employee_fkey FOREIGN KEY (employee_party_id, organization_id)
    REFERENCES parties (id, organization_id),
  CONSTRAINT expense_claims_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT expense_claims_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT expense_claims_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT expense_claims_numbered CHECK (status = 'DRAFT' OR number IS NOT NULL),
  CONSTRAINT expense_claims_posted_consistency CHECK ((status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)),
  CONSTRAINT expense_claims_cancelled_consistency CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)),
  CONSTRAINT expense_claims_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX expense_claims_number_idx ON expense_claims (organization_id, number) WHERE number IS NOT NULL;
CREATE INDEX expense_claims_list_idx ON expense_claims (organization_id, status, claim_date DESC, id);
CREATE INDEX expense_claims_employee_idx ON expense_claims (organization_id, employee_party_id);

CREATE TABLE expense_claim_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  claim_id         uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  expense_date     date NOT NULL,
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  account_id       uuid NOT NULL,
  amount           numeric(28, 4) NOT NULL CHECK (amount > 0),
  CONSTRAINT expense_claim_lines_claim_fkey FOREIGN KEY (claim_id, organization_id)
    REFERENCES expense_claims (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT expense_claim_lines_number_key UNIQUE (claim_id, line_no),
  CONSTRAINT expense_claim_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION expense_claims_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft expense claims can be deleted (claim %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'expense claim % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'expense claim % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'APPROVED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('POSTED', 'CANCELLED'))
    OR (OLD.status = 'POSTED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'expense claim % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CANCELLED', 'VOID') THEN
    RAISE EXCEPTION '% expense claim % is immutable', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (NEW.employee_party_id, NEW.claim_date, NEW.memo, NEW.total)
       IS DISTINCT FROM (OLD.employee_party_id, OLD.claim_date, OLD.memo, OLD.total) THEN
      RAISE EXCEPTION 'submitted expense claim % cannot be edited', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The bill link is set once.
  IF OLD.bill_id IS NOT NULL AND NEW.bill_id IS DISTINCT FROM OLD.bill_id THEN
    RAISE EXCEPTION 'expense claim % bill cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expense_claims_guard
  BEFORE UPDATE OR DELETE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION expense_claims_guard();

CREATE FUNCTION expense_claim_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_row    record;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.claim_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.claim_id) THEN
    RAISE EXCEPTION 'expense claim line % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM expense_claims
   WHERE id = v_row.claim_id AND organization_id = v_row.organization_id;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status IS NULL OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'lines of a submitted expense claim are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END;
$$;
CREATE TRIGGER expense_claim_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON expense_claim_lines
  FOR EACH ROW EXECUTE FUNCTION expense_claim_lines_guard();

-- ---------------------------------------------------------------------------
-- Receipts (attachments), truncation, RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill',
                'vendor_credit', 'vendor_payment', 'expense', 'purchase_order', 'expense_claim'));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'expense_claim_settings', 'expense_claim_number_sequences', 'expense_claims', 'expense_claim_lines'
  ] LOOP
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
GRANT DELETE ON expense_claims, expense_claim_lines TO intuit_app;

-- ---------------------------------------------------------------------------
-- Permissions and the backfill for existing organizations
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('expense_claims.view', 'expense_claims', 'View expense claims'),
  ('expense_claims.create', 'expense_claims', 'Create, edit, submit and cancel expense claims'),
  ('expense_claims.approve', 'expense_claims', 'Approve expense claims'),
  ('expense_claims.post', 'expense_claims', 'Post approved expense claims for reimbursement'),
  ('expense_claims.void', 'expense_claims', 'Void posted expense claims'),
  ('expense_claims.settings.manage', 'expense_claims', 'Manage expense claim settings')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE expense_claim_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO expense_claim_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('expense_claims.view'), ('expense_claims.create'), ('expense_claims.approve'),
  ('expense_claims.post'), ('expense_claims.void'), ('expense_claims.settings.manage')
) AS p (key);
INSERT INTO expense_claim_backfill_grants (template_key, permission_key) VALUES
  ('member', 'expense_claims.view');

CREATE TEMPORARY TABLE expense_claim_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN expense_claim_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO expense_claim_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0049_expense_claims',
       jsonb_build_object(
         'reason', 'Expense claim permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM expense_claim_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
