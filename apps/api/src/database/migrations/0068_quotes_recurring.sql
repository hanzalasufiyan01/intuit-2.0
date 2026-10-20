-- 0068_quotes_recurring — sales quotes and recurring invoice schedules (FP-28).
--
-- A quote (estimate) is a non-posting offer to a customer: draft, sent, accepted or declined, or
-- expired by its validity date, and CONVERTED once into a draft sales invoice (a quote converts at
-- most once). A recurring schedule produces DRAFT invoices on a calendar (weekly, monthly,
-- quarterly, yearly); it never issues or sends anything by itself, and a unique (schedule, run
-- date) record makes a run idempotent, so a repeated poll or a retried request cannot create the
-- same invoice twice. Neither touches the ledger: quotes post nothing and drafts post nothing.

INSERT INTO permissions (key, module, description) VALUES
  ('quotes.view', 'sales', 'View sales quotes'),
  ('quotes.create', 'sales', 'Create, edit, send and record the outcome of sales quotes'),
  ('quotes.convert', 'sales', 'Convert accepted quotes into draft invoices'),
  ('recurring_invoices.view', 'sales', 'View recurring invoice schedules'),
  ('recurring_invoices.manage', 'sales', 'Create, edit, pause and run recurring invoice schedules')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE quotes_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO quotes_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('quotes.view'), ('quotes.create'), ('quotes.convert'),
  ('recurring_invoices.view'), ('recurring_invoices.manage')
) AS p (key);

CREATE TEMPORARY TABLE quotes_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN quotes_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO quotes_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0068_quotes_recurring',
       jsonb_build_object(
         'reason', 'Quotes and recurring invoice permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM quotes_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

CREATE TABLE quote_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('quote')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE sales_quotes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number                text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  customer_id           uuid NOT NULL,
  quote_date            date NOT NULL,
  valid_until           date NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED')),
  reference             text CHECK (reference IS NULL OR length(reference) <= 100),
  memo                  text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  -- Net amount before tax (tax is calculated when the quote becomes an invoice).
  net_total             numeric(28, 4) NOT NULL CHECK (net_total >= 0),
  sent_at               timestamptz,
  decided_at            timestamptz,
  decline_reason        text CHECK (decline_reason IS NULL OR length(btrim(decline_reason)) BETWEEN 1 AND 500),
  invoice_id            uuid,
  converted_at          timestamptz,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT sales_quotes_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_quotes_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_quotes_dates CHECK (valid_until >= quote_date),
  CONSTRAINT sales_quotes_converted CHECK ((status = 'CONVERTED') = (invoice_id IS NOT NULL))
);
CREATE UNIQUE INDEX sales_quotes_number_idx ON sales_quotes (organization_id, number);
CREATE INDEX sales_quotes_list_idx ON sales_quotes (organization_id, quote_date DESC, id);
-- A draft invoice is the result of at most one quote.
CREATE UNIQUE INDEX sales_quotes_invoice_idx ON sales_quotes (organization_id, invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE TABLE sales_quote_lines (
  organization_id  uuid NOT NULL,
  quote_id         uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid,
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  tax_code_id      uuid,
  net_amount       numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  PRIMARY KEY (quote_id, line_no),
  CONSTRAINT sales_quote_lines_quote_fkey FOREIGN KEY (quote_id, organization_id)
    REFERENCES sales_quotes (id, organization_id),
  CONSTRAINT sales_quote_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id)
);

-- Quotes move forward only. Their content changes only while DRAFT; a converted quote is final.
CREATE FUNCTION sales_guard_quote() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'quote % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('CONVERTED', 'DECLINED', 'EXPIRED') THEN
    RAISE EXCEPTION '% quote % is final', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'SENT'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('ACCEPTED', 'CONVERTED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'quote % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.number, NEW.customer_id, NEW.quote_date, NEW.valid_until, NEW.net_total, NEW.created_at)
     IS DISTINCT FROM (
       OLD.number, OLD.customer_id, OLD.quote_date, OLD.valid_until, OLD.net_total, OLD.created_at) THEN
    RAISE EXCEPTION 'the content of quote % is frozen once it is sent', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_quotes_guard BEFORE UPDATE OR DELETE ON sales_quotes
  FOR EACH ROW EXECUTE FUNCTION sales_guard_quote();

-- Lines change only while the quote is a draft.
CREATE FUNCTION sales_guard_quote_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  quote_status text;
BEGIN
  SELECT status INTO quote_status FROM sales_quotes
   WHERE id = COALESCE(OLD.quote_id, NEW.quote_id)
     AND organization_id = COALESCE(OLD.organization_id, NEW.organization_id);
  IF quote_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the lines of a quote that is not a draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER sales_quote_lines_guard BEFORE UPDATE OR DELETE ON sales_quote_lines
  FOR EACH ROW EXECUTE FUNCTION sales_guard_quote_line();

-- ---------------------------------------------------------------------------
-- Recurring invoice schedules
-- ---------------------------------------------------------------------------

CREATE TABLE recurring_invoice_schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  customer_id           uuid NOT NULL,
  frequency             text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  -- Occurrence n is start_date + n periods (month-end clamped, no drift); next_run_date is
  -- occurrence run_count.
  start_date            date NOT NULL,
  next_run_date         date NOT NULL,
  end_date              date,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED')),
  reference             text CHECK (reference IS NULL OR length(reference) <= 100),
  memo                  text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  payment_terms_days    integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  -- The person whose permissions the background run uses.
  acting_user_id        uuid NOT NULL REFERENCES users (id),
  run_count             integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  last_run_at           timestamptz,
  last_error            text CHECK (last_error IS NULL OR length(last_error) <= 500),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT recurring_invoice_schedules_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT recurring_invoice_schedules_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT recurring_invoice_schedules_end CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT recurring_invoice_schedules_next CHECK (next_run_date >= start_date)
);
CREATE INDEX recurring_invoice_schedules_due_idx ON recurring_invoice_schedules (next_run_date)
  WHERE status = 'ACTIVE';

CREATE TABLE recurring_invoice_lines (
  organization_id  uuid NOT NULL,
  schedule_id      uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid,
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  tax_code_id      uuid,
  PRIMARY KEY (schedule_id, line_no),
  CONSTRAINT recurring_invoice_lines_schedule_fkey FOREIGN KEY (schedule_id, organization_id)
    REFERENCES recurring_invoice_schedules (id, organization_id),
  CONSTRAINT recurring_invoice_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id)
);

-- One draft per schedule and run date: the idempotency record of the generator.
CREATE TABLE recurring_invoice_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  schedule_id      uuid NOT NULL,
  run_date         date NOT NULL,
  invoice_id       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  CONSTRAINT recurring_invoice_runs_schedule_fkey FOREIGN KEY (schedule_id, organization_id)
    REFERENCES recurring_invoice_schedules (id, organization_id),
  CONSTRAINT recurring_invoice_runs_once UNIQUE (schedule_id, run_date)
);

CREATE TRIGGER recurring_invoice_runs_immutable BEFORE UPDATE OR DELETE ON recurring_invoice_runs
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- Background discovery: schedules due on or before a date, across organizations (ids only, the
-- same narrow pattern as the file purge scheduler).
CREATE FUNCTION app_due_recurring_schedules(as_of date, batch integer)
  RETURNS TABLE (organization_id uuid, schedule_id uuid, acting_user_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.organization_id, s.id, s.acting_user_id
    FROM recurring_invoice_schedules s
   WHERE s.status = 'ACTIVE' AND s.next_run_date <= as_of
   ORDER BY s.next_run_date, s.id
   LIMIT batch
$$;
REVOKE ALL ON FUNCTION app_due_recurring_schedules(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_recurring_schedules(date, integer) TO intuit_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quote_number_sequences', 'sales_quotes', 'sales_quote_lines',
    'recurring_invoice_schedules', 'recurring_invoice_lines', 'recurring_invoice_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON quote_number_sequences, sales_quotes, recurring_invoice_schedules
  TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_quote_lines, recurring_invoice_lines TO intuit_app;
GRANT DELETE ON sales_quotes TO intuit_app;
GRANT SELECT, INSERT ON recurring_invoice_runs TO intuit_app;
