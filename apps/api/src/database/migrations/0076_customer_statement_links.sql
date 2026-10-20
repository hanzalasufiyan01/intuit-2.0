-- 0076_customer_statement_links — read-only customer statement links (customer portal v1, FP-28).
--
-- A statement link is an unguessable token (only its hash is stored) that shows ONE customer's
-- open issued invoices, recent receipts and a pay action, with no sign-in. It can expire, be
-- revoked, and counts its views. There are no customer accounts (an open decision, see
-- docs/design/customer-portal.md). Creating and revoking uses the existing invoice_links.manage
-- permission, so no permission backfill is needed.

CREATE TABLE customer_statement_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  customer_id         uuid NOT NULL,
  token_hash          text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid REFERENCES users (id),
  view_count          integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at      timestamptz,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT customer_statement_links_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT customer_statement_links_expiry CHECK (expires_at > created_at)
);
CREATE INDEX customer_statement_links_customer_idx
  ON customer_statement_links (organization_id, customer_id, created_at DESC);

-- A link can only be revoked or counted; its target, token and expiry never change.
CREATE FUNCTION sales_guard_statement_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'statement links are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.customer_id, NEW.token_hash, NEW.expires_at, NEW.created_at,
      NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.organization_id, OLD.customer_id, OLD.token_hash, OLD.expires_at,
      OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'statement link % is immutable apart from revocation and views', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'statement link % is already revoked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_statement_links_guard BEFORE UPDATE OR DELETE ON customer_statement_links
  FOR EACH ROW EXECUTE FUNCTION sales_guard_statement_link();

-- The one place a request WITHOUT a session reaches a tenant row for statements: a token hash
-- resolves to the organization and customer it opens, if the link is live, and counts the view.
-- `count_view` is false for the payment actions of an already open page.
CREATE FUNCTION app_open_statement_link(hash text, now_at timestamptz, count_view boolean)
  RETURNS TABLE (organization_id uuid, customer_id uuid, link_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link customer_statement_links%ROWTYPE;
BEGIN
  SELECT * INTO link FROM customer_statement_links l
   WHERE l.token_hash = hash AND l.revoked_at IS NULL AND l.expires_at > now_at;
  IF NOT FOUND THEN RETURN; END IF;
  IF count_view THEN
    UPDATE customer_statement_links SET view_count = view_count + 1, last_viewed_at = now_at
     WHERE id = link.id;
  END IF;
  organization_id := link.organization_id;
  customer_id := link.customer_id;
  link_id := link.id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION app_open_statement_link(text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_open_statement_link(text, timestamptz, boolean) TO intuit_app;

ALTER TABLE customer_statement_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_statement_links_tenant ON customer_statement_links FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON customer_statement_links FROM PUBLIC;
CREATE TRIGGER customer_statement_links_no_truncate BEFORE TRUNCATE ON customer_statement_links
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
GRANT SELECT, INSERT, UPDATE ON customer_statement_links TO intuit_app;
