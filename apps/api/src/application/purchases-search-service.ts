import { decimal, minorUnits } from '../domain/money.js';
import { ValidationError } from '../domain/errors.js';
import { getParty, listParties, partyIdsMatching } from '../modules/parties/index.js';
import {
  BillPermissions,
  listBills,
  listPayments,
  listVendorCredits,
  VendorCreditPermissions,
  VendorPaymentPermissions,
} from '../modules/purchases/index.js';
import {
  getVendor,
  listVendorsByParty,
  VendorPermissions,
  vendorIdsOfParties,
  vendorPartyIds,
} from '../modules/vendors/index.js';
import type { Transaction } from '../database/client.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Purchases search (Phase 4B-8; ADR 0004 4B-8, mirrors Sales search D15/Decision 47): one query
 * across vendors, bills, vendor credits and debit notes, and vendor payments, each section shown
 * only to users who may view it. Matching uses the same indexes and case-insensitive "contains"
 * as the list screens (document number, supplier reference, payment reference, vendor name,
 * reference, e-mail or TIN). Read-only; never writes.
 */
export class PurchasesSearchService {
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
      const names = new Map<string, string | null>();
      const nameOf = async (tx2: Transaction, id: string) => {
        if (!names.has(id)) {
          const vendor = await getVendor(tx2, org, id);
          const party = vendor ? await getParty(tx2, org, vendor.partyId) : undefined;
          names.set(id, party?.displayName ?? null);
        }
        return names.get(id) ?? null;
      };
      const money = (value: string | null, currency: string) =>
        value === null ? null : decimal(value).toFixed(minorUnits(currency));
      const vendorIdsIn = vendorIdsOfParties(org, partyIdsMatching(org, q));

      if (can(VendorPermissions.View)) {
        const page = await listParties(tx, {
          organizationId: org,
          status: 'ACTIVE',
          role: null,
          search: q,
          limit,
          after: null,
          partyIdsIn: vendorPartyIds(org, 'ACTIVE'),
        });
        const rows = await listVendorsByParty(
          tx,
          org,
          page.items.map((i) => i.party.id),
        );
        const byParty = new Map(rows.map((v) => [v.partyId, v]));
        result.vendors = page.items.map(({ party }) => ({
          id: byParty.get(party.id)!.id,
          displayName: party.displayName,
          reference: party.reference,
          email: party.email,
          currencyCode: byParty.get(party.id)!.currencyCode,
        }));
      }
      if (can(BillPermissions.View)) {
        const page = await listBills(tx, {
          organizationId: org,
          statuses: null,
          vendorId: null,
          search: q,
          vendorIdsIn,
          from: null,
          to: null,
          limit,
          after: null,
        });
        result.bills = [];
        for (const b of page.items) {
          result.bills.push({
            id: b.id,
            number: b.number,
            vendorReference: b.vendorReference,
            status: b.status,
            billDate: b.billDate,
            vendorName: await nameOf(tx, b.vendorId),
            currencyCode: b.currencyCode,
            total: money(b.total, b.currencyCode),
            amountDue: money(b.amountDue, b.currencyCode),
          });
        }
      }
      if (can(VendorCreditPermissions.View)) {
        const page = await listVendorCredits(tx, {
          organizationId: org,
          statuses: null,
          origin: null,
          vendorId: null,
          billId: null,
          search: q,
          vendorIdsIn,
          limit,
          after: null,
        });
        result.vendorCredits = [];
        for (const c of page.items) {
          result.vendorCredits.push({
            id: c.id,
            number: c.number,
            origin: c.origin,
            status: c.status,
            creditDate: c.creditDate,
            vendorName: await nameOf(tx, c.vendorId),
            currencyCode: c.currencyCode,
            total: money(c.total, c.currencyCode),
          });
        }
      }
      if (can(VendorPaymentPermissions.View)) {
        const page = await listPayments(tx, {
          organizationId: org,
          statuses: null,
          vendorId: null,
          withUnallocated: false,
          search: q,
          vendorIdsIn,
          limit,
          after: null,
        });
        result.payments = [];
        for (const p of page.items) {
          result.payments.push({
            id: p.id,
            number: p.number,
            status: p.status,
            paymentDate: p.paymentDate,
            vendorName: await nameOf(tx, p.vendorId),
            currencyCode: p.currencyCode,
            amount: money(p.amount, p.currencyCode),
          });
        }
      }
      return { q, ...result };
    });
  }
}
