import type { Transaction } from '../database/client.js';

/**
 * Document exposure providers (S9). Later modules (Sales/AR in Phase 3B, Purchases/AP, Banking,
 * Payroll) register a provider that reports their open foreign-currency documents at a date.
 * Providers are read-only: they never post. Accounting validates what they report and posts the
 * adjustments to each document's control account in its own revaluation journals.
 *
 * S9 registers no provider; accounting supplies the GL account exposures itself.
 */

export interface DocumentExposure {
  documentModule: string;
  documentType: string;
  documentId: string;
  /** The account that carries the document (typically a base-currency control account). */
  controlAccountId: string;
  /** The document's transaction currency (never the base currency). */
  currency: string;
  /** Open amount in the document currency, debit-positive (a receivable is positive). */
  foreignBalance: string;
  /** Historical base carrying amount of the open amount, debit-positive. */
  carryingBase: string;
}

export interface RevaluationExposureProvider {
  /** Unique key, e.g. `sales.invoices`. */
  key: string;
  listExposures(
    tx: Transaction,
    input: { organizationId: string; revaluationDate: string; baseCurrency: string },
  ): Promise<DocumentExposure[]>;
}

export class RevaluationExposureRegistry {
  private readonly providers = new Map<string, RevaluationExposureProvider>();

  register(provider: RevaluationExposureProvider): void {
    if (this.providers.has(provider.key)) {
      throw new Error(`Revaluation exposure provider ${provider.key} is already registered.`);
    }
    this.providers.set(provider.key, provider);
  }

  list(): RevaluationExposureProvider[] {
    return [...this.providers.values()];
  }
}
