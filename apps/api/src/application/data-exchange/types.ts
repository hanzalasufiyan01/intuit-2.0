import type { z } from 'zod';
import type { Transaction } from '../../database/client.js';
import type { EventOrigin } from '../../modules/audit/index.js';
import type {
  ExportDomainKey,
  ImportDomainKey,
  ImportOptions,
  RowMessage,
} from '../../modules/data-exchange/index.js';
import type { AccountingService } from '../accounting-service.js';
import type { ArReportService } from '../ar-report-service.js';
import type { CustomerService } from '../customer-service.js';
import type { InvoiceService } from '../invoice-service.js';
import type { ItemService } from '../item-service.js';
import type { AuthorizationContext } from '../authorization.js';
import type { DimensionService } from '../dimension-service.js';
import type { JournalService } from '../journal-service.js';
import type { OpeningBalanceService } from '../opening-balance-service.js';
import type { PartyService } from '../party-service.js';
import type { ReportService } from '../report-service.js';

/**
 * Import/export domain registry (S6-01). Each domain declares its fields and permission,
 * validates rows without writing anything, and commits through the owning module's
 * in-transaction service operations (S6-08, L-7). The data-exchange module itself never writes
 * other modules' tables.
 */

export interface DomainServices {
  accounting: AccountingService;
  journals: JournalService;
  parties: PartyService;
  dimensions: DimensionService;
  reports: ReportService;
  openingBalances: OpeningBalanceService;
  // Phase 3B (step 18): Sales imports and exports.
  customers: CustomerService;
  items: ItemService;
  invoices: InvoiceService;
  arReports: ArReportService;
}

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
  description: string;
  example: string;
  /** Header spellings recognized by the mapping suggestion (S6-42). */
  synonyms: string[];
}

export interface ImportEnv {
  tx: Transaction;
  ctx: AuthorizationContext;
  options: ImportOptions;
  services: DomainServices;
}

/** A staged row after the mapping: field key -> trimmed cell (null when blank or unmapped). */
export interface MappedRow {
  rowNumber: number;
  values: Record<string, string | null>;
}

export interface RowOutcome {
  rowNumber: number;
  normalized: Record<string, unknown> | null;
  messages: RowMessage[];
  /** Rows sharing a group key are one record (a journal) and are included or excluded together. */
  groupKey: string | null;
}

export interface CommitRow {
  rowNumber: number;
  normalized: Record<string, unknown>;
  groupKey: string | null;
}

export interface ImportDomain {
  key: ImportDomainKey;
  label: string;
  /** Decision 65: the target's create permission (parties.update for contact persons). */
  permission: string;
  groupsRows: boolean;
  fields(env: Omit<ImportEnv, 'options'>): Promise<ImportField[]>;
  /** Validates every row against current data. Never writes. */
  validate(env: ImportEnv, rows: readonly MappedRow[]): Promise<RowOutcome[]>;
  /** Creates the records inside the batch transaction; returns the record per row. */
  commit(
    env: ImportEnv,
    rows: readonly CommitRow[],
    context: { batchId: string; origin: EventOrigin },
  ): Promise<{ rowNumber: number; recordId: string }[]>;
}

/** A cell of an export, as passed to the CSV writer. */
export type ExportCell = string | null | { number: string | null } | { date: string | null };

export interface ExportEnv {
  tx: Transaction;
  ctx: AuthorizationContext;
  services: DomainServices;
  now: Date;
  /** Appends one record to the file; enforces the size cap (S6-28). */
  write(cells: readonly ExportCell[]): Promise<void>;
}

export interface ExportDomain<P = Record<string, unknown>> {
  key: ExportDomainKey;
  label: string;
  /** Strict schema of the export's parameters (the same filters as the matching screen). */
  params: z.ZodType<P>;
  /** Decision 65: the view permission the export requires (re-checked on every access). */
  permission(params: P, env: { tx: Transaction; ctx: AuthorizationContext }): Promise<string>;
  /** Whether the export needs a REPEATABLE READ snapshot (statements). */
  snapshot: boolean;
  fileName(params: P, now: Date): string;
  /** Writes the header and every row; returns the number of data rows. */
  generate(env: ExportEnv, params: P): Promise<number>;
}
