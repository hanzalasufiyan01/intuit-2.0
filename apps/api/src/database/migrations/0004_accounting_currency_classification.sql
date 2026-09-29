-- Intuit 2.0 — Phase 3A, S1: account currency and classification.
--
-- Decisions 1, 2, 53, 54, 70 and C3 (ADR 0003):
--   * accounting_currencies: controlled ISO 4217 reference data (global, read-only to the app).
--   * accounting_accounts.currency_code: every account has a currency; existing accounts are
--     backfilled to their organization's base currency. Immutable once the account has any
--     non-draft journal line (Decision 70).
--   * accounting_accounts.subtype: the Decision 53 catalog; NULL means unclassified. Existing
--     accounts stay unclassified (Decision 54). Each subtype belongs to one account nature.
--   * accounting_accounts.is_monetary: Bank, Cash, Accounts Receivable, Accounts Payable and
--     Credit Card are monetary; Other Current Liability and Long-Term Liability accounts are
--     monetary only when marked explicitly; every other subtype is non-monetary.
--   * accounting_accounts.is_control_account: control accounts (C3) are rejected in manual journals.
--   * accounting_coa_template_accounts.subtype: templates classify the accounts they create.

-- ---------------------------------------------------------------------------
-- Currency reference data
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_currencies (
  code        char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
  is_active   boolean NOT NULL DEFAULT true
);

INSERT INTO accounting_currencies (code, minor_units) VALUES
  ('AED', 2), ('AFN', 2), ('ALL', 2), ('AMD', 2), ('ANG', 2), ('AOA', 2), ('ARS', 2), ('AUD', 2),
  ('AWG', 2), ('AZN', 2), ('BAM', 2), ('BBD', 2), ('BDT', 2), ('BGN', 2), ('BHD', 3), ('BIF', 0),
  ('BMD', 2), ('BND', 2), ('BOB', 2), ('BRL', 2), ('BSD', 2), ('BTN', 2), ('BWP', 2), ('BYN', 2),
  ('BZD', 2), ('CAD', 2), ('CDF', 2), ('CHF', 2), ('CLF', 4), ('CLP', 0), ('CNY', 2), ('COP', 2),
  ('CRC', 2), ('CUP', 2), ('CVE', 2), ('CZK', 2), ('DJF', 0), ('DKK', 2), ('DOP', 2), ('DZD', 2),
  ('EGP', 2), ('ERN', 2), ('ETB', 2), ('EUR', 2), ('FJD', 2), ('FKP', 2), ('GBP', 2), ('GEL', 2),
  ('GHS', 2), ('GIP', 2), ('GMD', 2), ('GNF', 0), ('GTQ', 2), ('GYD', 2), ('HKD', 2), ('HNL', 2),
  ('HTG', 2), ('HUF', 2), ('IDR', 2), ('ILS', 2), ('INR', 2), ('IQD', 3), ('IRR', 2), ('ISK', 0),
  ('JMD', 2), ('JOD', 3), ('JPY', 0), ('KES', 2), ('KGS', 2), ('KHR', 2), ('KMF', 0), ('KPW', 2),
  ('KRW', 0), ('KWD', 3), ('KYD', 2), ('KZT', 2), ('LAK', 2), ('LBP', 2), ('LKR', 2), ('LRD', 2),
  ('LSL', 2), ('LYD', 3), ('MAD', 2), ('MDL', 2), ('MGA', 2), ('MKD', 2), ('MMK', 2), ('MNT', 2),
  ('MOP', 2), ('MRU', 2), ('MUR', 2), ('MVR', 2), ('MWK', 2), ('MXN', 2), ('MYR', 2), ('MZN', 2),
  ('NAD', 2), ('NGN', 2), ('NIO', 2), ('NOK', 2), ('NPR', 2), ('NZD', 2), ('OMR', 3), ('PAB', 2),
  ('PEN', 2), ('PGK', 2), ('PHP', 2), ('PKR', 2), ('PLN', 2), ('PYG', 0), ('QAR', 2), ('RON', 2),
  ('RSD', 2), ('RUB', 2), ('RWF', 0), ('SAR', 2), ('SBD', 2), ('SCR', 2), ('SDG', 2), ('SEK', 2),
  ('SGD', 2), ('SHP', 2), ('SLE', 2), ('SOS', 2), ('SRD', 2), ('SSP', 2), ('STN', 2), ('SVC', 2),
  ('SYP', 2), ('SZL', 2), ('THB', 2), ('TJS', 2), ('TMT', 2), ('TND', 3), ('TOP', 2), ('TRY', 2),
  ('TTD', 2), ('TWD', 2), ('TZS', 2), ('UAH', 2), ('UGX', 0), ('USD', 2), ('UYI', 0), ('UYU', 2),
  ('UYW', 4), ('UZS', 2), ('VES', 2), ('VND', 0), ('VUV', 0), ('WST', 2), ('XAF', 0), ('XCD', 2),
  ('XOF', 0), ('XPF', 0), ('YER', 2), ('ZAR', 2), ('ZMW', 2), ('ZWL', 2);

ALTER TABLE accounting_settings ADD CONSTRAINT accounting_settings_base_currency_fkey
  FOREIGN KEY (base_currency) REFERENCES accounting_currencies (code);

-- ---------------------------------------------------------------------------
-- Account currency
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_accounts ADD COLUMN currency_code char(3);
UPDATE accounting_accounts a SET currency_code = s.base_currency
  FROM accounting_settings s WHERE s.organization_id = a.organization_id;
ALTER TABLE accounting_accounts ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE accounting_accounts ADD CONSTRAINT accounting_accounts_currency_fkey
  FOREIGN KEY (currency_code) REFERENCES accounting_currencies (code);

-- Decision 70: the currency is immutable once any non-draft line references the account.
CREATE FUNCTION accounting_guard_account_currency() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j
        ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = OLD.organization_id
       AND l.account_id = OLD.id
       AND j.status <> 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'the currency of account % is immutable once it has non-draft journal lines', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_accounts_currency_guard
  BEFORE UPDATE OF currency_code ON accounting_accounts
  FOR EACH ROW WHEN (OLD.currency_code IS DISTINCT FROM NEW.currency_code)
  EXECUTE FUNCTION accounting_guard_account_currency();

-- ---------------------------------------------------------------------------
-- Classification (Decision 53 catalog) and control accounts (C3)
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_accounts
  ADD COLUMN subtype text,
  ADD COLUMN is_monetary boolean NOT NULL DEFAULT false,
  ADD COLUMN is_control_account boolean NOT NULL DEFAULT false;

ALTER TABLE accounting_accounts ADD CONSTRAINT accounting_accounts_subtype_nature CHECK (
  subtype IS NULL
  OR (account_type = 'ASSET' AND subtype IN ('BANK', 'CASH', 'ACCOUNTS_RECEIVABLE',
        'OTHER_CURRENT_ASSET', 'FIXED_ASSET', 'OTHER_ASSET'))
  OR (account_type = 'LIABILITY' AND subtype IN ('ACCOUNTS_PAYABLE', 'CREDIT_CARD',
        'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'))
  OR (account_type = 'EQUITY' AND subtype = 'EQUITY')
  OR (account_type = 'REVENUE' AND subtype IN ('OPERATING_REVENUE', 'OTHER_INCOME'))
  OR (account_type = 'EXPENSE' AND subtype IN ('COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'))
);

ALTER TABLE accounting_accounts ADD CONSTRAINT accounting_accounts_monetary CHECK (
  CASE
    WHEN subtype IN ('BANK', 'CASH', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'CREDIT_CARD') THEN is_monetary
    WHEN subtype IN ('OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY') THEN true
    ELSE NOT is_monetary
  END
);

-- ---------------------------------------------------------------------------
-- Template classification
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_coa_template_accounts ADD COLUMN subtype text;
ALTER TABLE accounting_coa_template_accounts ADD CONSTRAINT accounting_coa_template_accounts_subtype_nature CHECK (
  subtype IS NULL
  OR (account_type = 'ASSET' AND subtype IN ('BANK', 'CASH', 'ACCOUNTS_RECEIVABLE',
        'OTHER_CURRENT_ASSET', 'FIXED_ASSET', 'OTHER_ASSET'))
  OR (account_type = 'LIABILITY' AND subtype IN ('ACCOUNTS_PAYABLE', 'CREDIT_CARD',
        'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'))
  OR (account_type = 'EQUITY' AND subtype = 'EQUITY')
  OR (account_type = 'REVENUE' AND subtype IN ('OPERATING_REVENUE', 'OTHER_INCOME'))
  OR (account_type = 'EXPENSE' AND subtype IN ('COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'))
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON accounting_currencies FROM PUBLIC;
GRANT SELECT ON accounting_currencies TO intuit_app;
