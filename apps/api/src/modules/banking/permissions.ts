import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Banking permissions. Viewing the register and the statement transactions needs
 * `banking.transactions.view`; importing, matching and categorizing are separate so a bookkeeper can
 * be allowed to import without posting. Voiding a transfer or an entry needs a recent password
 * confirmation; reconciling is its own permission because it closes the statement.
 */
export const BankingPermissions = {
  AccountsManage: 'banking.accounts.manage',
  TransactionsView: 'banking.transactions.view',
  TransactionsImport: 'banking.transactions.import',
  TransactionsMatch: 'banking.transactions.match',
  TransactionsCategorize: 'banking.transactions.categorize',
  TransfersCreate: 'banking.transfers.create',
  TransfersVoid: 'banking.transfers.void',
  Reconcile: 'banking.reconcile',
  RulesManage: 'banking.rules.manage',
} as const;

export const bankingViewPermissions = [BankingPermissions.TransactionsView] as const;

export const bankingPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: BankingPermissions.AccountsManage,
    module: 'banking',
    description: 'Create, edit and archive bank accounts',
  },
  {
    key: BankingPermissions.TransactionsView,
    module: 'banking',
    description: 'View bank accounts, statement transactions, transfers and reconciliations',
  },
  {
    key: BankingPermissions.TransactionsImport,
    module: 'banking',
    description: 'Import bank statements (CSV and OFX)',
  },
  {
    key: BankingPermissions.TransactionsMatch,
    module: 'banking',
    description: 'Match, unmatch and exclude statement transactions',
  },
  {
    key: BankingPermissions.TransactionsCategorize,
    module: 'banking',
    description: 'Categorize statement transactions, posting bank entries',
  },
  {
    key: BankingPermissions.TransfersCreate,
    module: 'banking',
    description: 'Record transfers between bank accounts',
  },
  {
    key: BankingPermissions.TransfersVoid,
    module: 'banking',
    description: 'Void bank entries and transfers',
  },
  {
    key: BankingPermissions.Reconcile,
    module: 'banking',
    description: 'Complete and reopen bank reconciliations',
  },
  {
    key: BankingPermissions.RulesManage,
    module: 'banking',
    description: 'Manage bank categorization rules',
  },
];
