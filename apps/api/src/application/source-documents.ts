import { sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { getBankEntry, getBankTransfer } from '../modules/banking/index.js';
import { getAsset, getDisposal, getRun } from '../modules/fixed-assets/index.js';
import { getAdjustment } from '../modules/inventory/index.js';
import {
  getBill,
  getExpense,
  getPayment,
  getRefund,
  getVendorCredit,
  listPurchasesAllocations,
} from '../modules/purchases/index.js';
import {
  getCreditNote,
  getCustomerRefund,
  getInvoice,
  getReceipt,
} from '../modules/sales/index.js';

/**
 * Source-document registry (ADR 0004 P4-10, minimal per 4B-2 decision A5). Journals already carry
 * an immutable source reference (`source_module`, `source_type`, `source_id`, Decision 4 / R3). The
 * registry turns a reference into the document that created the journal, so the journal view can
 * link to it (report → account → journal → source document). It adds no table: resolvers read the
 * owning modules through their public contracts inside the caller's organization-scoped
 * transaction (RLS and the organization filter), so a reference never resolves across tenants.
 */

export interface SourceRefInput {
  module: string;
  type: string;
  id: string;
}

export interface SourceDocument {
  module: string;
  /** The document kind, e.g. `bill`, `vendor_credit`, `payment`, `invoice`. */
  documentType: string;
  id: string;
  number: string | null;
  label: string;
  /** The web route of the document. */
  path: string;
}

export type SourceDocumentResolver = (
  tx: Transaction,
  organizationId: string,
  id: string,
) => Promise<SourceDocument | null>;

export class SourceDocumentRegistry {
  private readonly resolvers = new Map<string, SourceDocumentResolver>();

  register(module: string, type: string, resolver: SourceDocumentResolver): void {
    const key = `${module}.${type}`;
    if (this.resolvers.has(key)) {
      throw new Error(`A source-document resolver for ${key} is already registered.`);
    }
    this.resolvers.set(key, resolver);
  }

  async resolve(
    tx: Transaction,
    organizationId: string,
    ref: SourceRefInput | null,
  ): Promise<SourceDocument | null> {
    if (!ref) return null;
    const resolver = this.resolvers.get(`${ref.module}.${ref.type}`);
    return resolver ? resolver(tx, organizationId, ref.id) : null;
  }
}

const doc = (
  module: string,
  documentType: string,
  id: string,
  number: string | null,
  noun: string,
  path: string,
): SourceDocument => ({
  module,
  documentType,
  id,
  number,
  label: number ? `${noun} ${number}` : `${noun} (draft)`,
  path,
});

/** Purchases: bills, vendor credits, payments and credit applications (with their realized FX). */
async function purchasesPayment(tx: Transaction, organizationId: string, id: string) {
  const payment = await getPayment(tx, organizationId, id);
  return payment
    ? doc('purchases', 'payment', id, payment.number, 'Payment', `/purchases/payments/${id}`)
    : null;
}

/** Phase 4B-3: a vendor refund (VR-). */
async function purchasesRefund(tx: Transaction, organizationId: string, id: string) {
  const refund = await getRefund(tx, organizationId, id);
  return refund
    ? doc('purchases', 'refund', id, refund.number, 'Refund', `/purchases/refunds/${id}`)
    : null;
}

/** A credit application resolves to the document whose credit was applied. */
async function purchasesApplication(tx: Transaction, organizationId: string, id: string) {
  const [row] = await listPurchasesAllocations(tx, organizationId, { applicationId: id });
  if (!row) return null;
  const source = row.paymentId
    ? await purchasesPayment(tx, organizationId, row.paymentId)
    : await purchasesVendorCredit(tx, organizationId, row.vendorCreditId!);
  return source
    ? {
        ...source,
        documentType: 'credit_application',
        label: `Credit applied from ${source.label}`,
      }
    : null;
}

async function purchasesVendorCredit(tx: Transaction, organizationId: string, id: string) {
  const credit = await getVendorCredit(tx, organizationId, id);
  if (!credit) return null;
  return doc(
    'purchases',
    'vendor_credit',
    id,
    credit.number,
    credit.origin === 'debit_note' ? 'Debit note' : 'Vendor credit',
    `/purchases/vendor-credits/${id}`,
  );
}

/** The registry with the subledger documents that post journals today (Sales and Purchases). */
export function createSourceDocumentRegistry(): SourceDocumentRegistry {
  const registry = new SourceDocumentRegistry();
  registry.register('purchases', 'bill', async (tx, organizationId, id) => {
    const bill = await getBill(tx, organizationId, id);
    return bill
      ? doc('purchases', 'bill', id, bill.number, 'Bill', `/purchases/bills/${id}`)
      : null;
  });
  // Phase 4B-9: a direct expense (EXP-).
  registry.register('purchases', 'expense', async (tx, organizationId, id) => {
    const expense = await getExpense(tx, organizationId, id);
    return expense
      ? doc('purchases', 'expense', id, expense.number, 'Expense', `/purchases/expenses/${id}`)
      : null;
  });
  registry.register('purchases', 'vendor_credit', purchasesVendorCredit);
  // Phase 4B (opening AP, P4-35): an opening bill or an opening vendor credit.
  registry.register('purchases', 'opening_balance', async (tx, organizationId, id) => {
    const bill = await getBill(tx, organizationId, id);
    if (bill) {
      return doc('purchases', 'bill', id, bill.number, 'Opening bill', `/purchases/bills/${id}`);
    }
    const credit = await getVendorCredit(tx, organizationId, id);
    return credit
      ? doc(
          'purchases',
          'vendor_credit',
          id,
          credit.number,
          'Opening vendor credit',
          `/purchases/vendor-credits/${id}`,
        )
      : null;
  });
  registry.register('purchases', 'payment', purchasesPayment);
  registry.register('purchases', 'credit_application', purchasesApplication);
  registry.register('purchases', 'refund', purchasesRefund);
  // A realized-FX journal is the payment's or the application's own journal (E1, C1).
  registry.register(
    'purchases',
    'realized_fx',
    async (tx, organizationId, id) =>
      (await purchasesPayment(tx, organizationId, id)) ??
      (await purchasesApplication(tx, organizationId, id)) ??
      (await purchasesRefund(tx, organizationId, id)),
  );
  // Banking: a categorized statement transaction (BE-) and a transfer between bank accounts (TR-).
  registry.register('banking', 'entry', async (tx, organizationId, id) => {
    const entry = await getBankEntry(tx, organizationId, id);
    return entry
      ? doc('banking', 'entry', id, entry.number, 'Bank entry', `/banking/entries/${id}`)
      : null;
  });
  registry.register('banking', 'transfer', async (tx, organizationId, id) => {
    const transfer = await getBankTransfer(tx, organizationId, id);
    return transfer
      ? doc('banking', 'transfer', id, transfer.number, 'Bank transfer', `/banking/transfers/${id}`)
      : null;
  });
  // Inventory: a stock adjustment (ADJ-), and the cost of goods sold of an invoice (shown as the invoice).
  registry.register('inventory', 'adjustment', async (tx, organizationId, id) => {
    const adjustment = await getAdjustment(tx, organizationId, id);
    return adjustment
      ? doc(
          'inventory',
          'adjustment',
          id,
          adjustment.number,
          'Stock adjustment',
          `/inventory/adjustments/${id}`,
        )
      : null;
  });
  registry.register('inventory', 'sale', async (tx, organizationId, id) => {
    const invoice = await getInvoice(tx, organizationId, id);
    return invoice
      ? doc(
          'sales',
          'invoice',
          id,
          invoice.number,
          'Cost of goods sold, invoice',
          `/sales/invoices/${id}`,
        )
      : null;
  });
  // Fixed assets: an asset (FA-), a depreciation run (DEP-), a disposal and a category transfer
  // (the last two are shown as the asset they concern).
  registry.register('fixed_assets', 'asset', async (tx, organizationId, id) => {
    const asset = await getAsset(tx, organizationId, id);
    return asset
      ? doc('fixed_assets', 'asset', id, asset.number, 'Fixed asset', `/assets/${id}`)
      : null;
  });
  registry.register('fixed_assets', 'depreciation_run', async (tx, organizationId, id) => {
    const run = await getRun(tx, organizationId, id);
    return run
      ? doc(
          'fixed_assets',
          'depreciation_run',
          id,
          run.number,
          'Depreciation run',
          `/assets/runs/${id}`,
        )
      : null;
  });
  registry.register('fixed_assets', 'disposal', async (tx, organizationId, id) => {
    const disposal = await getDisposal(tx, organizationId, id);
    const asset = disposal ? await getAsset(tx, organizationId, disposal.assetId) : undefined;
    return asset
      ? doc(
          'fixed_assets',
          'disposal',
          id,
          asset.number,
          'Disposal of fixed asset',
          `/assets/${asset.id}`,
        )
      : null;
  });
  registry.register('fixed_assets', 'transfer', async (tx, organizationId, id) => {
    const { rows } = await tx.execute<{ asset_id: string; number: string }>(sql`
      SELECT t.asset_id, a.number FROM fixed_asset_transfers t
        JOIN fixed_assets a ON a.id = t.asset_id AND a.organization_id = t.organization_id
       WHERE t.organization_id = ${organizationId} AND t.id = ${id}`);
    const row = rows[0];
    return row
      ? doc(
          'fixed_assets',
          'transfer',
          id,
          row.number,
          'Transfer of fixed asset',
          `/assets/${row.asset_id}`,
        )
      : null;
  });
  registry.register('sales', 'invoice', async (tx, organizationId, id) => {
    const invoice = await getInvoice(tx, organizationId, id);
    return invoice
      ? doc('sales', 'invoice', id, invoice.number, 'Invoice', `/sales/invoices/${id}`)
      : null;
  });
  // AR opening invoices post an `opening_balance` system journal referencing the invoice (D5).
  registry.register('sales', 'opening_balance', async (tx, organizationId, id) => {
    const invoice = await getInvoice(tx, organizationId, id);
    return invoice
      ? doc('sales', 'invoice', id, invoice.number, 'Invoice', `/sales/invoices/${id}`)
      : null;
  });
  registry.register('sales', 'credit_note', async (tx, organizationId, id) => {
    const note = await getCreditNote(tx, organizationId, id);
    return note
      ? doc('sales', 'credit_note', id, note.number, 'Credit note', `/sales/credit-notes/${id}`)
      : null;
  });
  const salesReceipt = async (tx: Transaction, organizationId: string, id: string) => {
    const receipt = await getReceipt(tx, organizationId, id);
    return receipt
      ? doc('sales', 'receipt', id, receipt.number, 'Receipt', `/sales/receipts/${id}`)
      : null;
  };
  registry.register('sales', 'receipt', salesReceipt);
  const salesRefund = async (tx: Transaction, organizationId: string, id: string) => {
    const refund = await getCustomerRefund(tx, organizationId, id);
    return refund
      ? doc('sales', 'refund', id, refund.number, 'Refund', `/sales/refunds/${id}`)
      : null;
  };
  registry.register('sales', 'refund', salesRefund);
  // Sales credit applications are not stored as documents (Phase 3B); only a receipt's own
  // realized-FX journal resolves.
  // A refund's realized-FX journal is the refund's own.
  registry.register(
    'sales',
    'realized_fx',
    async (tx, organizationId, id) =>
      (await salesReceipt(tx, organizationId, id)) ?? (await salesRefund(tx, organizationId, id)),
  );
  return registry;
}
