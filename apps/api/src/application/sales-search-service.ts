import { decimal, minorUnits } from '../domain/money.js';
import { ValidationError } from '../domain/errors.js';
import { customerPartyIds, listCustomersByParty } from '../modules/customers/index.js';
import { CustomerPermissions } from '../modules/customers/index.js';
import { listParties } from '../modules/parties/index.js';
import {
  listCreditNotes,
  listInvoices,
  listItems,
  listReceipts,
  SalesPermissions,
} from '../modules/sales/index.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import { customerName, customersMatching } from './sales-documents.js';

/**
 * Sales search (Phase 3B step 19; D15, Decision 47): one query across customers, invoices,
 * credit notes, receipts and items, each section shown only to users who may view it. Matching
 * uses the existing indexes plus case-insensitive "contains" (ILIKE, and the S4 trigram index on
 * parties); further trigram indexes are added only on measured need.
 */
export class SalesSearchService {
  constructor(private readonly deps: AppDependencies) {}

  search(principal: Principal, input: { q: string; limit: number }) {
    const q = input.q.trim();
    if (q.length < 2) {
      throw new ValidationError([{ path: 'q', message: 'Enter at least 2 characters.' }]);
    }
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      const org = ctx.organizationId;
      const can = (permission: string) => hasPermission(ctx, permission);
      const limit = input.limit;
      const result: Record<string, unknown[]> = {};

      if (can(CustomerPermissions.View)) {
        const page = await listParties(tx, {
          organizationId: org,
          status: 'ACTIVE',
          role: null,
          search: q,
          limit,
          after: null,
          partyIdsIn: customerPartyIds(org, 'ACTIVE'),
        });
        const rows = await listCustomersByParty(
          tx,
          org,
          page.items.map((i) => i.party.id),
        );
        const byParty = new Map(rows.map((c) => [c.partyId, c]));
        result.customers = page.items.map(({ party }) => ({
          id: byParty.get(party.id)!.id,
          displayName: party.displayName,
          reference: party.reference,
          email: party.email,
          currencyCode: byParty.get(party.id)!.currencyCode,
        }));
      }

      const customerIdsIn = customersMatching(org, q);
      const names = new Map<string, string | null>();
      const nameOf = async (id: string) => {
        if (!names.has(id)) names.set(id, await customerName(tx, org, id));
        return names.get(id) ?? null;
      };
      const money = (value: string | null, currency: string) =>
        value === null ? null : decimal(value).toFixed(minorUnits(currency));

      if (can(SalesPermissions.InvoicesView)) {
        const page = await listInvoices(tx, {
          organizationId: org,
          statuses: null,
          customerId: null,
          search: q,
          customerIdsIn,
          from: null,
          to: null,
          openOnly: false,
          limit,
          after: null,
        });
        result.invoices = [];
        for (const i of page.items) {
          result.invoices.push({
            id: i.id,
            number: i.number,
            status: i.status,
            invoiceDate: i.invoiceDate,
            customerName: await nameOf(i.customerId),
            currencyCode: i.currencyCode,
            total: money(i.total, i.currencyCode),
            amountDue: money(i.amountDue, i.currencyCode),
          });
        }
      }
      if (can(SalesPermissions.CreditNotesView)) {
        const page = await listCreditNotes(tx, {
          organizationId: org,
          status: null,
          customerId: null,
          invoiceId: null,
          search: q,
          customerIdsIn,
          withCredit: false,
          limit,
          after: null,
        });
        result.creditNotes = [];
        for (const n of page.items) {
          result.creditNotes.push({
            id: n.id,
            number: n.number,
            status: n.status,
            creditDate: n.creditDate,
            customerName: await nameOf(n.customerId),
            currencyCode: n.currencyCode,
            total: money(n.total, n.currencyCode),
          });
        }
      }
      if (can(SalesPermissions.ReceiptsView)) {
        const page = await listReceipts(tx, {
          organizationId: org,
          status: null,
          customerId: null,
          search: q,
          customerIdsIn,
          withCredit: false,
          limit,
          after: null,
        });
        result.receipts = [];
        for (const r of page.items) {
          result.receipts.push({
            id: r.id,
            number: r.number,
            status: r.status,
            receiptDate: r.receiptDate,
            customerName: await nameOf(r.customerId),
            currencyCode: r.currencyCode,
            amount: money(r.amount, r.currencyCode),
          });
        }
      }
      if (can(SalesPermissions.InvoicesView) || can(SalesPermissions.ItemsManage)) {
        const page = await listItems(tx, {
          organizationId: org,
          status: 'ACTIVE',
          search: q,
          limit,
          after: null,
        });
        result.items = page.items.map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
          itemType: i.itemType,
        }));
      }
      return { q, ...result };
    });
  }
}
