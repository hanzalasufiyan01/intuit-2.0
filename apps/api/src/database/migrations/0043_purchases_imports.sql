-- 0043_purchases_imports — Phase 4B (purchase imports): ADR 0004 P4-47, P4-48.
--
-- The import/export framework (S6) records each batch, mapping and export with its domain; the
-- domain lists are CHECK constraints. This migration extends them with the Purchases import
-- domains (vendors, AP opening bills as drafts, AP opening vendor credits as drafts) and the
-- direct-expense export. No table, permission or accounting object is created or changed;
-- imports create drafts only, through the owning services, in the batch transaction.

ALTER TABLE import_batches DROP CONSTRAINT import_batches_domain_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances', 'customers', 'sales_items', 'opening_invoices',
  'vendors', 'opening_bills', 'opening_vendor_credits'));
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_domain_check;
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances', 'customers', 'sales_items', 'opening_invoices',
  'vendors', 'opening_bills', 'opening_vendor_credits'));

ALTER TABLE exports DROP CONSTRAINT exports_domain_check;
ALTER TABLE exports ADD CONSTRAINT exports_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors', 'opening_balances',
  'customers', 'sales_items', 'invoices', 'receipts', 'ar_aging',
  'vendors', 'bills', 'vendor_credits', 'vendor_payments', 'ap_aging', 'purchases_by_vendor',
  'payment_register', 'expenses'));
