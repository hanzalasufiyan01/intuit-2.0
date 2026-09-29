import type pg from 'pg';
import type { AccountSubtype, AccountType, Designation } from './schema.js';

export interface CoaTemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  /** Decision 53 classification applied to the created account (headers stay unclassified). */
  subtype?: AccountSubtype;
  /** Decision 64 designation applied when an organization is set up from the template. */
  designation?: Designation;
}

export interface CoaTemplateDefinition {
  key: string;
  name: string;
  description: string;
  accounts: readonly CoaTemplateAccount[];
}

/**
 * Approved (decision B7): one shared starting structure is used for the Maldives, India,
 * UAE and UK templates until country-specific charts are supplied. Custom starts empty.
 * Parent (header) accounts are grouping/reporting nodes; only leaf accounts receive postings.
 */
const sharedStructure: readonly CoaTemplateAccount[] = [
  { code: '1000', name: 'Assets', type: 'ASSET' },
  { code: '1100', name: 'Current Assets', type: 'ASSET', parentCode: '1000' },
  { code: '1110', name: 'Cash on Hand', type: 'ASSET', parentCode: '1100', subtype: 'CASH' },
  { code: '1120', name: 'Bank Accounts', type: 'ASSET', parentCode: '1100', subtype: 'BANK' },
  {
    code: '1130',
    name: 'Accounts Receivable',
    type: 'ASSET',
    parentCode: '1100',
    subtype: 'ACCOUNTS_RECEIVABLE',
  },
  {
    code: '1140',
    name: 'Inventory',
    type: 'ASSET',
    parentCode: '1100',
    subtype: 'OTHER_CURRENT_ASSET',
  },
  {
    code: '1150',
    name: 'Prepaid Expenses',
    type: 'ASSET',
    parentCode: '1100',
    subtype: 'OTHER_CURRENT_ASSET',
  },
  { code: '1500', name: 'Non-Current Assets', type: 'ASSET', parentCode: '1000' },
  {
    code: '1510',
    name: 'Property, Plant and Equipment',
    type: 'ASSET',
    parentCode: '1500',
    subtype: 'FIXED_ASSET',
  },
  {
    code: '1520',
    name: 'Accumulated Depreciation',
    type: 'ASSET',
    parentCode: '1500',
    subtype: 'FIXED_ASSET',
  },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY' },
  { code: '2100', name: 'Current Liabilities', type: 'LIABILITY', parentCode: '2000' },
  {
    code: '2110',
    name: 'Accounts Payable',
    type: 'LIABILITY',
    parentCode: '2100',
    subtype: 'ACCOUNTS_PAYABLE',
  },
  {
    code: '2120',
    name: 'Accrued Liabilities',
    type: 'LIABILITY',
    parentCode: '2100',
    subtype: 'OTHER_CURRENT_LIABILITY',
  },
  {
    code: '2130',
    name: 'Tax Payable',
    type: 'LIABILITY',
    parentCode: '2100',
    subtype: 'OTHER_CURRENT_LIABILITY',
  },
  { code: '2500', name: 'Non-Current Liabilities', type: 'LIABILITY', parentCode: '2000' },
  {
    code: '2510',
    name: 'Long-Term Loans',
    type: 'LIABILITY',
    parentCode: '2500',
    subtype: 'LONG_TERM_LIABILITY',
  },
  { code: '3000', name: 'Equity', type: 'EQUITY' },
  { code: '3100', name: "Owner's Capital", type: 'EQUITY', parentCode: '3000', subtype: 'EQUITY' },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'EQUITY',
    parentCode: '3000',
    subtype: 'EQUITY',
    designation: 'RETAINED_EARNINGS',
  },
  {
    code: '3900',
    name: 'Opening Balance Equity',
    type: 'EQUITY',
    parentCode: '3000',
    subtype: 'EQUITY',
    designation: 'OPENING_BALANCE_EQUITY',
  },
  { code: '4000', name: 'Revenue', type: 'REVENUE' },
  {
    code: '4100',
    name: 'Sales Revenue',
    type: 'REVENUE',
    parentCode: '4000',
    subtype: 'OPERATING_REVENUE',
  },
  {
    code: '4200',
    name: 'Service Revenue',
    type: 'REVENUE',
    parentCode: '4000',
    subtype: 'OPERATING_REVENUE',
  },
  {
    code: '4900',
    name: 'Other Income',
    type: 'REVENUE',
    parentCode: '4000',
    subtype: 'OTHER_INCOME',
  },
  {
    code: '4950',
    name: 'Realized FX Gain/Loss',
    type: 'REVENUE',
    parentCode: '4000',
    subtype: 'OTHER_INCOME',
    designation: 'REALIZED_FX_GAIN_LOSS',
  },
  {
    code: '4960',
    name: 'Unrealized FX Gain/Loss',
    type: 'REVENUE',
    parentCode: '4000',
    subtype: 'OTHER_INCOME',
    designation: 'UNREALIZED_FX_GAIN_LOSS',
  },
  { code: '5000', name: 'Expenses', type: 'EXPENSE' },
  {
    code: '5100',
    name: 'Cost of Goods Sold',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'COST_OF_SALES',
  },
  {
    code: '5200',
    name: 'Salaries and Wages',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'OPERATING_EXPENSE',
  },
  { code: '5300', name: 'Rent', type: 'EXPENSE', parentCode: '5000', subtype: 'OPERATING_EXPENSE' },
  {
    code: '5400',
    name: 'Utilities',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '5500',
    name: 'Depreciation Expense',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '5900',
    name: 'Other Expenses',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'OTHER_EXPENSE',
  },
  {
    code: '5950',
    name: 'Rounding Differences',
    type: 'EXPENSE',
    parentCode: '5000',
    subtype: 'OTHER_EXPENSE',
    designation: 'ROUNDING_DIFFERENCE',
  },
];

export const coaTemplateDefinitions: readonly CoaTemplateDefinition[] = [
  {
    key: 'maldives',
    name: 'Maldives',
    description: 'Starting chart for the Maldives',
    accounts: sharedStructure,
  },
  {
    key: 'india',
    name: 'India',
    description: 'Starting chart for India',
    accounts: sharedStructure,
  },
  {
    key: 'uae',
    name: 'UAE',
    description: 'Starting chart for the United Arab Emirates',
    accounts: sharedStructure,
  },
  {
    key: 'uk',
    name: 'UK',
    description: 'Starting chart for the United Kingdom',
    accounts: sharedStructure,
  },
  {
    key: 'custom',
    name: 'Custom',
    description: 'Start with an empty chart and build your own',
    accounts: [],
  },
];

/** Seeds COA template reference data (migration role, caller-managed transaction). Idempotent. */
export async function syncCoaTemplates(
  client: pg.ClientBase,
  templates: readonly CoaTemplateDefinition[] = coaTemplateDefinitions,
): Promise<number> {
  for (const [index, template] of templates.entries()) {
    const codes = new Set(template.accounts.map((a) => a.code));
    for (const account of template.accounts) {
      if (account.parentCode && !codes.has(account.parentCode)) {
        throw new Error(`Template ${template.key}: unknown parent ${account.parentCode}`);
      }
    }
    await client.query(
      `INSERT INTO accounting_coa_templates (key, name, description, sort_order) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order`,
      [template.key, template.name, template.description, index],
    );
    // Templates only seed new organizations; replacing them never touches existing charts.
    await client.query('DELETE FROM accounting_coa_template_accounts WHERE template_key = $1', [
      template.key,
    ]);
    // Parents first (the list is ordered so every parent precedes its children).
    for (const [order, account] of template.accounts.entries()) {
      await client.query(
        `INSERT INTO accounting_coa_template_accounts
           (template_key, code, name, account_type, parent_code, subtype, designation, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          template.key,
          account.code,
          account.name,
          account.type,
          account.parentCode ?? null,
          account.subtype ?? null,
          account.designation ?? null,
          order,
        ],
      );
    }
  }
  return templates.length;
}
