/**
 * The assistant's help catalogue: what Intuit 2.0 actually does, in the words of its own screens.
 *
 * It is the only source of product guidance. The built-in (documentation) mode answers from it
 * directly, and a live model is given the matching topics as reference material. Every statement
 * here must describe a feature that exists; menu names and buttons are the exact labels shown in
 * the application. A topic about something that does not exist is written as such ("not
 * implemented"), never as a promise. Nothing in this file is financial data.
 */

export interface HelpTopic {
  id: string;
  title: string;
  /** Lower-case words and short phrases a question may contain. */
  keywords: readonly string[];
  /** One or two sentences: what it is and what it is for. */
  summary: string;
  /** Numbered steps, in the order a person follows them in the application. */
  steps?: readonly string[];
  /** Extra guidance: rules the application enforces, limits and common questions. */
  notes?: readonly string[];
  /** Where the feature lives in the application (a web path), if it has a page. */
  route?: string;
  /** The tutorial that walks through it (the web catalogue's identifier). */
  tutorialId?: string;
}

/** A question that asks how to do something (as opposed to asking for a figure or a definition). */
export const HOW_TO_CUE =
  /\b(how (do|can|should|to|would)|steps?|set ?up|add|create|new|record|enter|archive|edit|change|fix|correct|void|issue|post)\b/i;

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    keywords: [
      'start',
      'begin',
      'first',
      'setup',
      'set up',
      'new',
      'onboarding',
      'welcome',
      'overview',
    ],
    summary:
      'Intuit 2.0 keeps one general ledger for the whole organization. Set up accounting first, then your customers, vendors and items, then record documents.',
    steps: [
      'Open Accounting > Setup and choose the chart of accounts, the base currency and the fiscal year.',
      'Review Company profile (Organization > Company profile) and Sales > Settings and Purchases > Settings, where the control accounts are chosen.',
      'Add customers (Sales > Customers) and vendors (Purchases > Vendors).',
      'Create and issue your first invoice from Sales > Invoices, or enter a bill from Purchases > Bills.',
      'Look at Accounting > Trial Balance and Accounting > Profit & Loss to see the effect.',
    ],
    notes: [
      'Menu entries you cannot see are not available to your role or are an optional module that is switched off.',
    ],
    route: '/',
    tutorialId: 'welcome',
  },
  {
    id: 'dashboard',
    title: 'The Overview page',
    keywords: ['overview', 'dashboard', 'home', 'landing'],
    summary:
      'Overview is the first page after sign-in. It shows who is signed in, whether you are an owner or a member of the active organization, and your organizations.',
    notes: ['Verified financial figures are in the reports, not on this page.'],
    route: '/',
    tutorialId: 'dashboard',
  },
  {
    id: 'business-settings',
    title: 'Business and financial settings',
    keywords: [
      'settings',
      'company',
      'profile',
      'currency',
      'fiscal',
      'year',
      'chart of accounts',
      'base currency',
      'period',
      'control account',
    ],
    summary:
      'Company details live in Organization > Company profile. Accounting > Setup fixes the chart of accounts, the base currency and the fiscal year; periods can be closed under Accounting > Periods.',
    steps: [
      'Open Organization > Company profile to review the company details.',
      'Open Accounting > Setup to choose the chart of accounts template, the base currency and the first fiscal year.',
      'Open Sales > Settings and Purchases > Settings to choose the control accounts and defaults.',
      'Use Accounting > Fiscal Years and Accounting > Periods to see and close accounting periods.',
    ],
    notes: [
      'A posted journal cannot be edited. A closed period cannot receive new postings until it is reopened by someone permitted.',
      'Changing settings needs the matching permission and may ask you to confirm your password.',
    ],
    route: '/accounting/setup',
    tutorialId: 'business-settings',
  },
  {
    id: 'customers-vendors',
    title: 'Customers and vendors',
    keywords: [
      'customer',
      'customers',
      'client',
      'vendor',
      'vendors',
      'supplier',
      'suppliers',
      'contact',
      'contacts',
      'party',
    ],
    summary:
      'Customers are managed under Sales > Customers and vendors under Purchases > Vendors. Each keeps its own currency, payment terms and tax defaults.',
    steps: [
      'To add a customer open Sales > Customers and choose New customer.',
      'To add a vendor open Purchases > Vendors and choose New vendor.',
      'Fill in the name, currency and terms and save. The record can then be chosen on invoices or bills.',
    ],
    notes: [
      'A customer or vendor you no longer use can be archived instead of removed, so past documents keep their history.',
    ],
    route: '/sales/customers',
    tutorialId: 'customers-suppliers',
  },
  {
    id: 'invoices',
    title: 'Invoices',
    keywords: [
      'invoice',
      'invoices',
      'bill a customer',
      'sell',
      'sales',
      'issue',
      'void',
      'draft',
      'receivable',
    ],
    summary:
      'An invoice is a request for payment from a customer. It stays a draft until it is issued; issuing posts it to the ledger and it can no longer be edited.',
    steps: [
      'Open Sales > Invoices and choose New invoice.',
      'Choose the customer, the dates, and add lines with items or descriptions, quantities, prices and tax.',
      'Save the draft and check the totals.',
      'Choose Issue (then Confirm and issue) to post it. If an approval policy applies, choose Submit for approval instead.',
    ],
    notes: [
      'Issued invoices are immutable. To correct one, Void it (when it has no payments or credits) or create a credit note.',
      'Receivables in the ledger always equal the sum of open invoices, receipts and credit notes.',
    ],
    route: '/sales/invoices',
    tutorialId: 'invoices',
  },
  {
    id: 'receipts',
    title: 'Customer receipts',
    keywords: [
      'receipt',
      'receipts',
      'payment received',
      'customer payment',
      'collect',
      'allocate',
      'allocation',
    ],
    summary:
      'A receipt records money received from a customer and allocates it to open invoices. Any amount not allocated stays as customer credit.',
    steps: [
      'Open Sales > Receipts and choose Record receipt.',
      'Choose the customer, the date, the bank or cash account and the amount.',
      'Allocate the amount to the open invoices; any remainder is kept as customer credit.',
      'Save. The invoices show as paid or partly paid.',
    ],
    notes: [
      'A receipt that has been refunded must have the refunds voided before it can be voided.',
    ],
    route: '/sales/receipts',
    tutorialId: 'invoices',
  },
  {
    id: 'credit-notes',
    title: 'Credit notes',
    keywords: ['credit note', 'credit notes', 'credit', 'return', 'correct invoice', 'refund'],
    summary:
      'A credit note reduces what a customer owes, usually to correct an issued invoice. It can be applied to invoices or refunded.',
    steps: [
      'Open Sales > Credit notes and create one, or choose Create credit note from an issued invoice.',
      'Issue it, then apply it to an invoice, or refund it to the customer from Sales > Refunds.',
    ],
    route: '/sales/credit-notes',
  },
  {
    id: 'bills-expenses',
    title: 'Bills, expenses and payments',
    keywords: [
      'bill',
      'bills',
      'expense',
      'expenses',
      'pay',
      'payment',
      'payments',
      'vendor payment',
      'payable',
      'purchase',
      'spend',
    ],
    summary:
      'A bill records what you owe a vendor; an expense records a cost paid directly. Vendor payments settle bills, and Pay bills pays several at once.',
    steps: [
      'To record a bill open Purchases > Bills and choose New bill; choose the vendor, add the lines, save and post it.',
      'To record a direct cost open Purchases > Expenses and choose New expense.',
      'To pay a bill open Purchases > Payments and choose New payment, or use Purchases > Pay bills for several bills.',
    ],
    notes: [
      'Posted bills and expenses are immutable; corrections use vendor credits, voids or reversals.',
      'An administrator can define expense policies that warn about, or block, certain expenses when they are posted.',
    ],
    route: '/purchases/bills',
    tutorialId: 'expenses-payments',
  },
  {
    id: 'reports',
    title: 'Accounting reports',
    keywords: [
      'report',
      'reports',
      'trial balance',
      'profit',
      'loss',
      'p&l',
      'balance sheet',
      'cash flow',
      'ledger',
      'statement',
      'aging',
      'ageing',
    ],
    summary:
      'Reports read the posted ledger. Accounting has the Trial Balance, Profit & Loss, Balance Sheet, Cash Flow and Changes in Equity; Sales > Reports and Purchases > Reports show receivables and payables aging.',
    steps: [
      'Open Accounting and choose a report, for example Trial Balance or Profit & Loss.',
      'Choose the period or dates and run the report.',
      'Use the figures to drill into the General Ledger, and export when you need a file.',
    ],
    notes: [
      'The Trial Balance totals debits and credits and must balance. A draft journal is not in any report.',
      'Reports need the matching view permission.',
    ],
    route: '/accounting/reports/trial-balance',
    tutorialId: 'reports',
  },
  {
    id: 'banking',
    title: 'Banking and reconciliation',
    keywords: [
      'bank',
      'banking',
      'reconcile',
      'reconciliation',
      'statement import',
      'match',
      'transfer',
      'ofx',
      'csv',
      'petty cash',
    ],
    summary:
      'Banking holds bank accounts, statement import (CSV or OFX), matching statement lines to ledger entries, bank entries, transfers and reconciliation.',
    steps: [
      'Open Banking and choose a bank account.',
      'Import a statement file (CSV with a column mapping, or OFX).',
      'Match each statement line to a posted entry, or categorize it into a bank entry, then reconcile.',
    ],
    notes: ['Statements are imported from files; live bank feeds are not implemented.'],
    route: '/banking',
    tutorialId: 'banking',
  },
  {
    id: 'inventory',
    title: 'Inventory',
    keywords: [
      'inventory',
      'stock',
      'item',
      'items',
      'warehouse',
      'count',
      'adjustment',
      'cost of goods',
    ],
    summary:
      'Inventory tracks stock of tracked items at weighted-average cost, with adjustments, stock counts, warehouses and landed costs. Stock moves are created by bills and invoices.',
    steps: [
      'Open Inventory to see the items tracked in stock and their quantities and values.',
      'Stock comes in when a bill with the item is posted and goes out when an invoice with the item is issued.',
      'Use Inventory for adjustments, stock counts and warehouses.',
    ],
    route: '/inventory',
    tutorialId: 'inventory-appointments',
  },
  {
    id: 'appointments',
    title: 'Appointments (clinic)',
    keywords: [
      'appointment',
      'appointments',
      'clinic',
      'patient',
      'patients',
      'booking',
      'practitioner',
    ],
    summary:
      'The clinic extension books appointments for patients with practitioners and services, and can create an invoice from a completed appointment. It is an optional module.',
    steps: [
      'An administrator enables Clinic under Organization > Modules.',
      'Set up services and practitioners in Clinic, add patients, then book appointments.',
    ],
    notes: [
      'Clinic holds administrative and billing data only; there are no clinical note fields.',
    ],
    route: '/clinic',
    tutorialId: 'inventory-appointments',
  },
  {
    id: 'roles-security',
    title: 'Roles, permissions and security',
    keywords: [
      'role',
      'roles',
      'permission',
      'permissions',
      'member',
      'members',
      'invite',
      'security',
      'mfa',
      'two-step',
      'password',
      'audit',
      'access',
    ],
    summary:
      'Members get roles, and roles hold permissions. The server checks permissions on every request. Two-step verification protects owners and privileged roles, and the audit log records sensitive actions.',
    steps: [
      'Open Members to invite people and assign roles.',
      'Open Roles to see what each role may do; custom roles can be created.',
      'Open Security (Security & audit) to see the organization security policy, and Audit log to review activity.',
      'Open Account security to manage your own two-step verification and devices.',
    ],
    notes: [
      'Hiding a menu entry is a convenience; the permission is always enforced on the server.',
    ],
    route: '/roles',
    tutorialId: 'roles-security',
  },
  {
    id: 'concept-double-entry',
    title: 'Double-entry bookkeeping',
    keywords: [
      'double entry',
      'double-entry',
      'debit',
      'credit',
      'debits',
      'credits',
      'journal',
      'balance',
    ],
    summary:
      'Every transaction is recorded twice, once as a debit and once as a credit, with equal totals. That is why the Trial Balance always balances: total debits equal total credits.',
    notes: [
      'Assets and expenses increase with debits; liabilities, equity and revenue increase with credits.',
      'Journals are drafts until posted. A posted journal is never edited; a reversal posts the opposite entry.',
    ],
  },
  {
    id: 'concept-receivable-payable',
    title: 'Receivables and payables',
    keywords: [
      'receivable',
      'receivables',
      'payable',
      'payables',
      'ar',
      'ap',
      'accounts receivable',
      'accounts payable',
      'owed',
    ],
    summary:
      'Accounts receivable is money customers owe you; accounts payable is money you owe vendors. Each has a control account in the ledger that always agrees with the open documents behind it.',
    route: '/sales/reports',
  },
  {
    id: 'concept-immutability',
    title: 'Posted records and corrections',
    keywords: [
      'edit',
      'delete',
      'undo',
      'mistake',
      'correct',
      'correction',
      'reverse',
      'reversal',
      'void',
      'immutable',
      'posted',
    ],
    summary:
      'Posted documents and journals are permanent. A mistake is corrected by voiding or reversing it, or by a credit note or adjustment, so the history stays complete.',
    notes: ['Drafts can be edited or deleted freely.'],
  },
  {
    id: 'not-available',
    title: 'What is not available',
    keywords: [
      'tax return',
      'mira',
      'gst',
      'vat filing',
      'file tax',
      'statutory',
      'pension',
      'bank feed',
      'ocr',
      'scan',
    ],
    summary:
      'Some things are not implemented yet: filing tax returns with a tax authority, statutory payroll rules, live bank feeds and receipt scanning. The assistant cannot do them, and nothing in the application does them automatically.',
    notes: ['Tax codes and tax reports exist; filing is outside the application.'],
  },
] as const;

export interface PageContext {
  id: string;
  /** What the person is looking at, in words the assistant may repeat. */
  label: string;
  topicId: string;
}

/** Known page prefixes, longest first. A path outside this table gives no page context. */
const PAGES: readonly (PageContext & { prefix: string })[] = [
  { prefix: '/sales/invoices', id: 'invoices', label: 'the Invoices page', topicId: 'invoices' },
  { prefix: '/sales/receipts', id: 'receipts', label: 'the Receipts page', topicId: 'receipts' },
  {
    prefix: '/sales/credit-notes',
    id: 'credit-notes',
    label: 'the Credit notes page',
    topicId: 'credit-notes',
  },
  {
    prefix: '/sales/customers',
    id: 'customers',
    label: 'the Customers page',
    topicId: 'customers-vendors',
  },
  {
    prefix: '/sales/reports',
    id: 'sales-reports',
    label: 'the Sales reports page',
    topicId: 'reports',
  },
  {
    prefix: '/sales/settings',
    id: 'sales-settings',
    label: 'the Sales settings page',
    topicId: 'business-settings',
  },
  { prefix: '/sales', id: 'sales', label: 'the Sales area', topicId: 'invoices' },
  {
    prefix: '/purchases/vendors',
    id: 'vendors',
    label: 'the Vendors page',
    topicId: 'customers-vendors',
  },
  {
    prefix: '/purchases/reports',
    id: 'purchases-reports',
    label: 'the Purchases reports page',
    topicId: 'reports',
  },
  { prefix: '/purchases', id: 'purchases', label: 'the Purchases area', topicId: 'bills-expenses' },
  {
    prefix: '/accounting/reports',
    id: 'accounting-reports',
    label: 'an accounting report',
    topicId: 'reports',
  },
  {
    prefix: '/accounting/setup',
    id: 'accounting-setup',
    label: 'the Accounting setup page',
    topicId: 'business-settings',
  },
  {
    prefix: '/accounting',
    id: 'accounting',
    label: 'the Accounting area',
    topicId: 'concept-double-entry',
  },
  { prefix: '/banking', id: 'banking', label: 'the Banking area', topicId: 'banking' },
  { prefix: '/inventory', id: 'inventory', label: 'the Inventory area', topicId: 'inventory' },
  { prefix: '/clinic', id: 'clinic', label: 'the Clinic area', topicId: 'appointments' },
  { prefix: '/members', id: 'members', label: 'the Members page', topicId: 'roles-security' },
  { prefix: '/roles', id: 'roles', label: 'the Roles page', topicId: 'roles-security' },
  { prefix: '/audit', id: 'audit', label: 'the Audit log', topicId: 'roles-security' },
  { prefix: '/settings', id: 'settings', label: 'a settings page', topicId: 'business-settings' },
  { prefix: '/help', id: 'help', label: 'the Help centre', topicId: 'getting-started' },
];

/**
 * Maps a location to a known page, or null. The raw path is never kept: it can hold record
 * identifiers, so only the table entry (a fixed label) is used afterwards.
 */
export function resolvePage(path: string | undefined | null): PageContext | null {
  if (!path) return null;
  const clean = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || '/';
  if (clean === '/') {
    return { id: 'overview', label: 'the Overview page', topicId: 'dashboard' };
  }
  for (const page of PAGES) {
    if (clean === page.prefix || clean.startsWith(`${page.prefix}/`)) {
      return { id: page.id, label: page.label, topicId: page.topicId };
    }
  }
  return null;
}

export function topicById(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((t) => t.id === id);
}

const TOKEN = /[a-z0-9&]+/g;

function normalize(text: string): string {
  return ` ${(text.toLowerCase().match(TOKEN) ?? []).join(' ')} `;
}

/**
 * The topics that best match a question (and, as a weaker hint, the page the person is on).
 * Scoring is deterministic: a keyword phrase found in the question counts by its length in words,
 * a title word counts one. Returns at most `limit` topics, best first; none when nothing matches.
 */
export function matchTopics(question: string, page: PageContext | null, limit = 3): HelpTopic[] {
  const text = normalize(question);
  const scored = HELP_TOPICS.map((topic) => {
    let score = 0;
    for (const keyword of topic.keywords) {
      const k = normalize(keyword);
      if (text.includes(k)) score += 2 + k.trim().split(' ').length;
    }
    for (const word of normalize(topic.title).trim().split(' ')) {
      if (word.length > 3 && text.includes(` ${word} `)) score += 1;
    }
    if (page && page.topicId === topic.id) score += score > 0 ? 1 : 0;
    return { topic, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));
  return scored.slice(0, limit).map((s) => s.topic);
}

/** Topics that help read a figure (where it comes from and what it means). */
const FIGURE_TOPIC_IDS = new Set(['reports', 'concept-receivable-payable']);

/**
 * The topics for a question. When the question asks for the person's own figures, only the topics
 * that explain figures are kept, so words like "customers" or "vendors" in "how much do customers
 * owe us?" do not pull in how-to-add-a-customer help. A question that also asks how to do something
 * keeps every matching topic.
 */
export function selectTopics(
  question: string,
  page: PageContext | null,
  asksForFigures: boolean,
): HelpTopic[] {
  const matched = matchTopics(question, page);
  if (!asksForFigures || HOW_TO_CUE.test(question)) return matched;
  const relevant = matched.filter((t) => FIGURE_TOPIC_IDS.has(t.id));
  return relevant.length > 0 ? relevant : [topicById('reports')!];
}

/** Suggested first questions, shown by the assistant panel and valid for the whole product. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  'How do I create and issue an invoice?',
  'What is the difference between a bill and an expense?',
  'How do I record a customer payment?',
  'What does the Trial Balance show?',
  'How do I correct a posted invoice?',
  'What can each role do?',
];
