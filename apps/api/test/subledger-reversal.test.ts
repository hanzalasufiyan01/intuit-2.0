import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '../src/application/authorization.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import type { Subledger } from '../src/modules/accounting/index.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, MINUTE, type TestContext } from './helpers.js';

/**
 * Phase 4A-2 (ADR 0004 P4-09): generalized subledger journal reversal. A journal a subledger module
 * (Sales, Purchases) created, and any reversal of it, is reversed only through that module's own
 * path, `reverseSubledgerJournalInTransaction(module, …)`; generic reversal refuses it. Purchases
 * flows do not exist yet, so Purchases-owned journals are posted here through the real
 * accounting-event pipeline with a test handler (source `purchases/<type>/<id>`).
 */

let ctx: TestContext;
let owner: pg.Client;
const origin = { requestId: 'subledger-reversal-test', ipAddress: null, userAgent: 'vitest' };
const EVENT = 'test.p4a2.document_posted';

const SALES_REFUSAL =
  'Sales journals are reversed from their invoice or receipt in Sales (void), not manually.';
const PURCHASES_REFUSAL =
  'Purchases journals are reversed from their bill, vendor credit, payment or refund in Purchases (void), not manually.';

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
  ctx.services.journals.registerEventHandler(
    EVENT,
    (event) => {
      const p = event.payload as {
        module: string;
        type: string;
        id: string;
        debit: string;
        credit: string;
        amount: string;
        date: string;
      };
      return {
        entryDate: p.date,
        description: `${p.module} ${p.type}`,
        reference: p.id.slice(0, 8),
        currency: 'MVR',
        exchangeRate: null,
        lines: [line(p.debit, 'debit', p.amount), line(p.credit, 'credit', p.amount)],
        sourceRef: { module: p.module, type: p.type, id: p.id },
      };
    },
    { domainApproval: true },
  );
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

async function actingContext(org: AccountingOrg): Promise<AuthorizationContext> {
  const principal = await ctx.services.auth.authenticate(org.owner.sessionToken!, origin);
  return {
    userId: principal!.user.id,
    sessionId: principal!.session.id,
    organizationId: org.organizationId,
    membershipId: 'test',
    isOwner: true,
    roleIds: [],
    permissions: new Set(),
  };
}

/** A journal posted by `module` through the accounting-event pipeline. */
async function subledgerJournal(
  org: AccountingOrg,
  module: string,
  options: { type?: string; date?: string; amount?: string } = {},
) {
  const received = await inTransaction(
    ctx.database.db,
    { organizationId: org.organizationId },
    (tx) =>
      ctx.services.journals.receiveEventInTransaction(tx, {
        organizationId: org.organizationId,
        sourceModule: module,
        eventType: EVENT,
        eventKey: randomUUID(),
        payload: {
          module,
          type: options.type ?? 'bill',
          id: randomUUID(),
          debit: org.accounts['5300']!,
          credit: org.accounts['2120']!,
          amount: options.amount ?? '250.00',
          date: options.date ?? '2026-03-10',
        },
        occurredAt: new Date(),
        origin,
      }),
  );
  return received.journalId as string;
}

/** The subledger path, called the way a module's void calls it, in one transaction. */
async function subledgerReverse(
  org: AccountingOrg,
  module: Subledger,
  journalId: string,
  input: { reason: string; reversalDate?: string } = { reason: 'Voided' },
) {
  const actx = await actingContext(org);
  return inTransaction(
    ctx.database.db,
    { userId: actx.userId, organizationId: org.organizationId },
    (tx) =>
      ctx.services.journals.reverseSubledgerJournalInTransaction(
        tx,
        actx,
        module,
        journalId,
        input,
        origin,
      ),
  );
}

async function journalRow(id: string) {
  const { rows } = await owner.query(
    `SELECT status, source, source_module, source_type, source_id FROM accounting_journal_entries WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function lines(id: string) {
  const { rows } = await owner.query(
    `SELECT line_number, line_kind, account_id, debit::text, credit::text, base_debit::text, base_credit::text
       FROM accounting_journal_lines WHERE journal_id = $1 ORDER BY line_number`,
    [id],
  );
  return rows as {
    line_number: number;
    line_kind: string;
    account_id: string;
    debit: string | null;
    credit: string | null;
    base_debit: string | null;
    base_credit: string | null;
  }[];
}

const mirrored = (original: Awaited<ReturnType<typeof lines>>) =>
  original.map((l) => ({
    line_kind: l.line_kind,
    account_id: l.account_id,
    debit: l.credit,
    credit: l.debit,
    base_debit: l.base_credit,
    base_credit: l.base_debit,
  }));
const withoutNumbers = (rows: Awaited<ReturnType<typeof lines>>) =>
  rows.map(({ line_number: _n, ...rest }) => rest);

describe('generic reversal refuses subledger-owned journals (P4-09)', () => {
  it('refuses Sales- and Purchases-owned journals with their own message, leaving them POSTED', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const [module, message] of [
      ['sales', SALES_REFUSAL],
      ['purchases', PURCHASES_REFUSAL],
    ] as const) {
      const id = await subledgerJournal(org, module);
      const before = await lines(id);
      const res = await org.owner.post(`/accounting/journals/${id}/reverse`, {
        reason: 'Try a manual reversal',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'SYSTEM_JOURNAL', message });
      expect(await journalRow(id)).toMatchObject({ status: 'POSTED', source_module: module });
      expect(await lines(id)).toEqual(before);
    }
  });

  it('keeps generic reversal for ordinary manual journals', async () => {
    const org = await setUpAccountingOrg(ctx);
    const manual = await postJournal(org);
    const res = await org.owner.post(`/accounting/journals/${manual.id}/reverse`, {
      reason: 'Entered twice',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await journalRow(manual.id)).toMatchObject({ status: 'REVERSED', source: 'manual' });
  });
});

describe('the subledger reversal path (reverseSubledgerJournalInTransaction)', () => {
  for (const module of ['sales', 'purchases'] as const) {
    it(`reverses a ${module} journal: new mirrored journal, original immutable, linked and audited`, async () => {
      const org = await setUpAccountingOrg(ctx);
      const id = await subledgerJournal(org, module);
      const before = await lines(id);
      const result = await subledgerReverse(org, module, id, { reason: 'Document voided' });

      // The original keeps its lines and source; only its status moves to REVERSED.
      expect(await journalRow(id)).toMatchObject({
        status: 'REVERSED',
        source: 'event',
        source_module: module,
        source_type: 'bill',
      });
      expect(await lines(id)).toEqual(before);
      // The reversal is a new posted journal mirroring the original line by line.
      expect(await journalRow(result.id)).toMatchObject({ status: 'POSTED', source: 'reversal' });
      expect(withoutNumbers(await lines(result.id))).toEqual(mirrored(before));
      const link = await owner.query(
        `SELECT original_journal_id, reason FROM accounting_journal_reversals WHERE reversal_journal_id = $1`,
        [result.id],
      );
      expect(link.rows).toEqual([{ original_journal_id: id, reason: 'Document voided' }]);
      const audit = await owner.query(
        `SELECT metadata->>'reason' AS reason, metadata->>'reversalJournalId' AS reversal
           FROM audit_events WHERE organization_id = $1 AND action = 'journal.reversed' AND resource_id = $2`,
        [org.organizationId, id],
      );
      expect(audit.rows).toEqual([{ reason: 'Document voided', reversal: result.id }]);

      // The reversal is owned through its original: generic reversal refuses it too.
      const again = await org.owner.post(`/accounting/journals/${result.id}/reverse`, {
        reason: 'Undo the void',
      });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toBe(module === 'sales' ? SALES_REFUSAL : PURCHASES_REFUSAL);
    });
  }

  it('rejects a module mismatch, and journals no subledger owns', async () => {
    const org = await setUpAccountingOrg(ctx);
    const sales = await subledgerJournal(org, 'sales');
    const purchases = await subledgerJournal(org, 'purchases');
    const manual = (await postJournal(org)).id as string;
    const other = await subledgerJournal(org, 'payroll');
    const refused = (module: Subledger, id: string) =>
      expect(subledgerReverse(org, module, id)).rejects.toMatchObject({
        code: 'SYSTEM_JOURNAL',
        message: `Only ${module === 'sales' ? 'Sales' : 'Purchases'} journals are reversed here.`,
      });
    await refused('sales', purchases);
    await refused('purchases', sales);
    await refused('purchases', manual);
    await refused('sales', other);
    for (const id of [sales, purchases, manual, other]) {
      expect((await journalRow(id)).status).toBe('POSTED');
    }
    // A module that is not a registered subledger keeps the generic engine.
    const generic = await org.owner.post(`/accounting/journals/${other}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(generic.status, JSON.stringify(generic.body)).toBe(200);
  });

  it('mirrors a Purchases realized-FX system journal on its own path; generic reversal refuses it (Decision 80)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const usdBank = (
      await org.owner.post('/accounting/accounts', {
        code: '1128',
        name: 'USD bank',
        type: 'ASSET',
        subtype: 'BANK',
        currencyCode: 'USD',
      })
    ).body.data.id as string;
    const fx = await inTransaction(ctx.database.db, { organizationId: org.organizationId }, (tx) =>
      ctx.services.journals.postSystemJournal(
        tx,
        {
          organizationId: org.organizationId,
          userId: null,
          source: { module: 'purchases', type: 'realized_fx', id: randomUUID() },
          entryDate: '2026-03-15',
          description: 'Vendor payment',
          reference: 'PAY-1',
          currency: 'USD',
          exchangeRate: '15.50',
          lines: [
            {
              accountId: org.accounts['2120']!,
              description: '',
              kind: 'normal',
              debit: '100.00',
              credit: null,
              baseDebit: '1542.00',
              baseCredit: null,
            },
            {
              accountId: usdBank,
              description: '',
              kind: 'normal',
              debit: null,
              credit: '100.00',
              baseDebit: null,
              baseCredit: '1550.00',
            },
            {
              accountId: org.accounts['4950']!,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: '8.00',
              baseCredit: null,
            },
          ],
        },
        origin,
      ),
    );
    const generic = await org.owner.post(`/accounting/journals/${fx.id}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(generic.status).toBe(409);
    expect(generic.body.error.message).toBe(PURCHASES_REFUSAL);

    const before = await lines(fx.id);
    const result = await subledgerReverse(org, 'purchases', fx.id, { reason: 'Payment voided' });
    expect(await journalRow(fx.id)).toMatchObject({
      status: 'REVERSED',
      source_type: 'realized_fx',
    });
    expect(await lines(fx.id)).toEqual(before);
    // The mirror is a realized-FX system journal of the same module and document.
    const mirror = await journalRow(result.id);
    expect(mirror).toMatchObject({
      status: 'POSTED',
      source: 'system',
      source_module: 'purchases',
      source_type: 'realized_fx',
      source_id: (await journalRow(fx.id)).source_id,
    });
    expect(withoutNumbers(await lines(result.id))).toEqual(mirrored(before));
  });

  it('keeps FX/revaluation system journals of non-subledger modules out of generic reversal', async () => {
    const org = await setUpAccountingOrg(ctx);
    const fx = await inTransaction(ctx.database.db, { organizationId: org.organizationId }, (tx) =>
      ctx.services.journals.postSystemJournal(
        tx,
        {
          organizationId: org.organizationId,
          userId: null,
          source: { module: 'accounting', type: 'revaluation', id: randomUUID() },
          entryDate: '2026-03-31',
          description: 'Revaluation',
          reference: 'REV',
          currency: 'MVR',
          exchangeRate: null,
          lines: [
            {
              accountId: org.accounts['1120']!,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: '5.00',
              baseCredit: null,
            },
            {
              accountId: org.accounts['4960']!,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: null,
              baseCredit: '5.00',
            },
          ],
        },
        origin,
      ),
    );
    const res = await org.owner.post(`/accounting/journals/${fx.id}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'SYSTEM_JOURNAL',
      message:
        'FX and revaluation journals are reversed by their originating process, not manually.',
    });
    expect((await journalRow(fx.id)).status).toBe('POSTED');
  });

  it('reverses a subledger opening-balance journal only on its own path (P4-35 readiness)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const opening = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId },
      (tx) =>
        ctx.services.journals.postSystemJournal(
          tx,
          {
            organizationId: org.organizationId,
            userId: null,
            source: { module: 'purchases', type: 'opening_balance', id: randomUUID() },
            entryDate: '2026-01-31',
            description: 'Opening bill',
            reference: 'OB-1',
            currency: 'MVR',
            exchangeRate: null,
            lines: [
              {
                accountId: org.accounts['3900']!,
                description: '',
                kind: 'normal',
                debit: '75.00',
                credit: null,
                baseDebit: null,
                baseCredit: null,
              },
              {
                accountId: org.accounts['2120']!,
                description: '',
                kind: 'normal',
                debit: null,
                credit: '75.00',
                baseDebit: null,
                baseCredit: null,
              },
            ],
          },
          origin,
        ),
    );
    const generic = await org.owner.post(`/accounting/journals/${opening.id}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(generic.status).toBe(409);
    expect(generic.body.error.message).toBe(PURCHASES_REFUSAL);
    const result = await subledgerReverse(org, 'purchases', opening.id, {
      reason: 'Opening bill voided',
    });
    expect((await journalRow(opening.id)).status).toBe('REVERSED');
    expect((await journalRow(result.id)).source).toBe('reversal');
  });

  it('requires an open period for the reversal date', async () => {
    const org = await setUpAccountingOrg(ctx);
    const id = await subledgerJournal(org, 'purchases', { date: '2026-02-10' });
    const february = org.periods.find((p) => p.startDate === '2026-02-01')!;
    const closed = await org.owner.post(`/accounting/periods/${february.id}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await expect(subledgerReverse(org, 'purchases', id)).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
      message: "The original journal's period is closed; choose a reversal date in an open period.",
    });
    expect((await journalRow(id)).status).toBe('POSTED');
    const result = await subledgerReverse(org, 'purchases', id, {
      reason: 'Voided later',
      reversalDate: '2026-03-05',
    });
    expect((await journalRow(id)).status).toBe('REVERSED');
    const posted = await owner.query(
      `SELECT entry_date::text FROM accounting_journal_entries WHERE id = $1`,
      [result.id],
    );
    expect(posted.rows[0].entry_date).toBe('2026-03-05');
  });

  it('keeps tenants isolated: another organization cannot reverse the journal on either path', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const id = await subledgerJournal(a, 'purchases');
    await expect(subledgerReverse(b, 'purchases', id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const generic = await b.owner.post(`/accounting/journals/${id}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(generic.status).toBe(404);
    expect((await journalRow(id)).status).toBe('POSTED');
  });
});

describe('authorization on the generic path is unchanged', () => {
  it('needs accounting.journals.reverse', async () => {
    const org = await setUpAccountingOrg(ctx);
    const manual = await postJournal(org);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const res = await member.client.post(`/accounting/journals/${manual.id}/reverse`, {
      reason: 'Testing a reversal',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect((await journalRow(manual.id)).status).toBe('POSTED');
  });

  // Last in the file: it moves the shared test clock past the re-authentication window.
  it('needs a recent re-authentication (sensitive action), before any ownership check', async () => {
    const org = await setUpAccountingOrg(ctx);
    const manual = await postJournal(org);
    const owned = await subledgerJournal(org, 'purchases');
    ctx.clock.advance(ctx.config.session.reauthWindowMs + MINUTE);
    for (const id of [manual.id as string, owned]) {
      const res = await org.owner.post(`/accounting/journals/${id}/reverse`, {
        reason: 'Testing a reversal',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
      expect((await journalRow(id)).status).toBe('POSTED');
    }
  });
});
