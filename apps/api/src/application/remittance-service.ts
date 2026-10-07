import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import type { PdfRenderer } from '../infrastructure/pdf/pdf-renderer.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { findLatestJobForRecord, PermanentJobError } from '../modules/jobs/index.js';
import { getOrganizationProfile } from '../modules/organizations/index.js';
import { getPartyDetail } from '../modules/parties/index.js';
import {
  attachRemittancePdf,
  completeRemittanceEmail,
  freezeRemittanceSnapshot,
  getPayment,
  getRemittanceEmail,
  insertRemittanceEmail,
  listPurchasesAllocations,
  listRemittanceBills,
  listRemittanceEmails,
  setRemittanceEmailJob,
  unreversedAllocations,
  VendorPaymentPermissions,
  type Payment,
} from '../modules/purchases/index.js';
import { getVendor } from '../modules/vendors/index.js';
import {
  requirePermission,
  resolveActingUserContext,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { FileService } from './file-service.js';
import type { JobContext, JobService } from './job-service.js';
import { systemOrigin } from './job-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Vendor remittance advice: PDF and email (Phase 4B-7; ADR 0004 P4-46; decisions D1–D17).
 *
 * OUTPUT ONLY. Nothing here creates or changes a journal, an accounting event, an allocation, a
 * payment amount or a balance; the only writes are the payment's two set-once output columns, the
 * generated file and the email requests (migration 0039).
 *
 * - One advice per recorded payment (D2). A batch payment has its own, like any other.
 * - The content is frozen on the FIRST request (D4) from the payment and its own recorded
 *   allocations; later prepayment applications, refunds, base amounts, FX and bank details are not
 *   part of it (D3, D17). The PDF is generated on demand (D5) by a job, stored under legal hold and
 *   linked once; it is never regenerated or modified.
 * - A voided payment gets no new advice and no email (D6); an existing PDF stays downloadable.
 * - Permissions (D7): `vendor_payments.view` to see or download, `vendor_payments.create` to
 *   generate or email; no re-authentication. Jobs re-check the requester's permission when they run.
 * - Each explicit email request is a new audited row (D13); the PDF survives a failed send.
 */

export const REMITTANCE_PDF_JOB = 'purchases.remittance_pdf';
export const REMITTANCE_EMAIL_JOB = 'purchases.remittance_email';
const RESOURCE = 'purchases_payment';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PdfPayload {
  paymentId: string;
  userId: string;
}

interface EmailPayload {
  emailId: string;
  paymentId: string;
  userId: string;
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

const address = (
  a: {
    line1: string;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
  } | null,
) =>
  a
    ? {
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        countryCode: a.countryCode,
      }
    : null;

/**
 * The frozen remittance content (D3, D14): the payer's profile, the vendor, the bills this
 * payment itself settled, and any advance — the part of the amount not allocated when it was
 * recorded. Built only from immutable data (the recorded payment and its own allocation rows).
 */
export async function buildRemittanceSnapshot(
  tx: Transaction,
  organizationId: string,
  payment: Payment,
): Promise<Record<string, unknown>> {
  const places = minorUnits(payment.currencyCode);
  const fixed = (value: { toFixed(places: number): string }) => value.toFixed(places);
  const own = unreversedAllocations(
    await listPurchasesAllocations(tx, organizationId, { paymentId: payment.id }),
  ).filter((a) => a.mode === 'payment');
  const paidByBill = new Map<string, ReturnType<typeof decimal>>();
  for (const a of own) {
    paidByBill.set(a.billId, (paidByBill.get(a.billId) ?? decimal(0)).plus(decimal(a.amount)));
  }
  const bills = await listRemittanceBills(tx, organizationId, [...paidByBill.keys()]);
  const lines = bills
    .map((b) => ({
      billNumber: b.number ?? '',
      vendorReference: b.vendorReference,
      billDate: b.billDate,
      billTotal: fixed(decimal(b.total)),
      amountPaid: fixed(paidByBill.get(b.id)!),
    }))
    .sort(
      (a, b) => a.billDate.localeCompare(b.billDate) || a.billNumber.localeCompare(b.billNumber),
    );
  const applied = [...paidByBill.values()].reduce((sum, v) => sum.plus(v), decimal(0));
  const amount = decimal(payment.amount);
  const advance = amount.minus(applied);
  if (advance.isNegative()) {
    throw new ConflictError('CONFLICT', 'The payment allocations exceed its amount.');
  }

  const vendor = await getVendor(tx, organizationId, payment.vendorId);
  const party = vendor ? await getPartyDetail(tx, organizationId, vendor.partyId) : undefined;
  const organization = await getOrganizationProfile(tx, organizationId);
  const profile = organization?.profile;
  const sellerAddress =
    organization?.addresses.find((a) => a.kind === 'business') ??
    organization?.addresses.find((a) => a.kind === 'registered') ??
    null;
  const billing =
    party?.addresses.find((a) => a.kind === 'billing' && a.isDefault) ??
    party?.addresses.find((a) => a.kind === 'billing') ??
    null;
  return {
    version: 1,
    documentType: 'remittance_advice',
    number: payment.number,
    paymentDate: payment.paymentDate,
    currencyCode: payment.currencyCode,
    amount: fixed(amount),
    reference: payment.reference,
    seller: profile
      ? {
          legalName: profile.legalName,
          tradingName: profile.tradingName,
          tin: profile.tin,
          gstRegistrationNumber: profile.gstRegistrationNumber,
          email: profile.email,
          phone: profile.phone,
          logoFileId: profile.logoFileId ?? null,
          address: address(sellerAddress),
        }
      : null,
    vendor: party
      ? {
          displayName: party.party.displayName,
          companyName: party.party.companyName,
          email: party.party.email,
          address: address(billing),
        }
      : null,
    lines,
    totals: { applied: fixed(applied), advance: fixed(advance), total: fixed(amount) },
  };
}

export class RemittanceService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly files: FileService,
    private readonly jobs: JobService,
    private readonly renderer: PdfRenderer,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async payment(
    tx: Transaction,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ) {
    const payment = await getPayment(tx, organizationId, id, options);
    if (!payment) throw new NotFoundError('Payment not found.');
    return payment;
  }

  /** The advice needs a recorded payment: voided, draft and pending payments get none (D6). */
  private requireRecorded(payment: Payment) {
    if (payment.status !== 'RECORDED') {
      throw invalidState(
        payment.status === 'VOID'
          ? 'A voided payment gets no new remittance advice.'
          : 'A remittance advice is available once the payment is recorded.',
      );
    }
  }

  /** Freezes the snapshot on the first request (D4). Returns true when this call froze it. */
  private async ensureSnapshot(tx: Transaction, organizationId: string, payment: Payment) {
    if (payment.renderSnapshot) return false;
    const snapshot = await buildRemittanceSnapshot(tx, organizationId, payment);
    return freezeRemittanceSnapshot(tx, organizationId, payment.id, snapshot);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** none | pending | ready | failed, with a short-lived download link when ready (D7). */
  status(principal: Principal, paymentId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.View },
      async (tx, ctx) => {
        const payment = await this.payment(tx, ctx.organizationId, paymentId);
        if (payment.remittancePdfFileId) {
          return {
            status: 'ready' as const,
            fileId: payment.remittancePdfFileId,
            jobId: null as string | null,
          };
        }
        if (!payment.renderSnapshot) {
          return { status: 'none' as const, fileId: null, jobId: null as string | null };
        }
        const job = await findLatestJobForRecord(
          tx,
          ctx.organizationId,
          REMITTANCE_PDF_JOB,
          'paymentId',
          paymentId,
        );
        const failed = job?.status === 'failed' || job?.status === 'dead';
        return {
          status: failed ? ('failed' as const) : ('pending' as const),
          fileId: null,
          jobId: job?.id ?? null,
        };
      },
    ).then(async (result) =>
      result.fileId
        ? { ...result, download: await this.files.downloadUrl(principal, result.fileId) }
        : result,
    );
  }

  emails(principal: Principal, paymentId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.View },
      async (tx, ctx) => {
        await this.payment(tx, ctx.organizationId, paymentId);
        return (await listRemittanceEmails(tx, ctx.organizationId, paymentId)).map((e) => ({
          id: e.id,
          recipient: e.recipient,
          subject: e.subject,
          status: e.status,
          requestedAt: e.requestedAt.toISOString(),
          sentAt: e.sentAt?.toISOString() ?? null,
        }));
      },
    );
  }

  // -------------------------------------------------------------------------
  // Generate (on demand, D5)
  // -------------------------------------------------------------------------

  /**
   * Freezes the snapshot if this is the first request, then queues the PDF job. Idempotent: a
   * payment that already has its PDF returns it; a job still running is not duplicated; a job that
   * failed is retried under the next deterministic key.
   */
  request(principal: Principal, paymentId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        // The row lock serializes concurrent requests for one payment.
        const payment = await this.payment(tx, ctx.organizationId, paymentId, { forUpdate: true });
        this.requireRecorded(payment);
        if (payment.remittancePdfFileId) {
          return { status: 'ready' as const, jobId: null as string | null };
        }
        const froze = await this.ensureSnapshot(tx, ctx.organizationId, payment);
        const latest = await findLatestJobForRecord(
          tx,
          ctx.organizationId,
          REMITTANCE_PDF_JOB,
          'paymentId',
          paymentId,
        );
        if (latest && latest.status !== 'failed' && latest.status !== 'dead') {
          return { status: 'pending' as const, jobId: latest.id };
        }
        const { job } = await this.jobs.enqueue(tx, {
          organizationId: ctx.organizationId,
          type: REMITTANCE_PDF_JOB,
          jobKey: nextJobKey(paymentId, latest?.jobKey ?? null),
          payload: { paymentId, userId: ctx.userId },
          requiredPermission: VendorPaymentPermissions.Create,
          createdByUserId: ctx.userId,
        });
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'vendor_payment.remittance_requested',
          resourceType: RESOURCE,
          resourceId: paymentId,
          metadata: { number: payment.number, jobId: job.id, snapshotFrozen: froze },
          origin,
        });
        return { status: 'pending' as const, jobId: job.id };
      },
    );
  }

  /** The acting user must still hold the create permission when a job runs (D7). */
  private async authorize(job: JobContext, userId: string): Promise<AuthorizationContext> {
    try {
      const ctx = await job.run((tx) => resolveActingUserContext(tx, userId, job.organizationId));
      requirePermission(ctx, VendorPaymentPermissions.Create);
      return ctx;
    } catch (error) {
      throw new PermanentJobError(
        error instanceof Error ? error.message : 'The requesting user may no longer do this.',
      );
    }
  }

  async runPdf(job: JobContext) {
    const payload = job.job.payload as unknown as PdfPayload;
    await this.authorize(job, payload.userId);
    const fileId = await this.generatePdf(job, payload);
    return fileId ? { fileId } : { skipped: true };
  }

  /**
   * Renders the frozen snapshot and stores the PDF unless the payment already has one. Retry-safe:
   * a repeated run finds the PDF linked and does nothing; the snapshot is never rewritten.
   */
  private async generatePdf(job: JobContext, payload: PdfPayload): Promise<string | null> {
    const prepared = await job.run(async (tx) => {
      const payment = await this.payment(tx, job.organizationId, payload.paymentId);
      if (payment.remittancePdfFileId) return null;
      if (payment.status !== 'RECORDED') {
        throw new PermanentJobError('The payment is no longer recorded.');
      }
      if (!payment.renderSnapshot) {
        throw new PermanentJobError('The remittance advice has no frozen content.');
      }
      return { snapshot: payment.renderSnapshot, number: payment.number! };
    });
    if (!prepared) return null;
    const logo = await this.logo(job, prepared.snapshot);
    const bytes = await this.renderer.render(prepared.snapshot, { logo });
    const temporary = path.join(tmpdir(), `intuit2-remittance-${randomUUID()}.pdf`);
    await writeFile(temporary, bytes);
    try {
      return await job.run(async (tx) => {
        const current = await this.payment(tx, job.organizationId, payload.paymentId, {
          forUpdate: true,
        });
        if (current.remittancePdfFileId) return null;
        if (current.status !== 'RECORDED') {
          throw new PermanentJobError('The payment is no longer recorded.');
        }
        const ctx = await resolveActingUserContext(tx, payload.userId, job.organizationId);
        const file = await this.files.storeGeneratedInTransaction(tx, ctx, {
          linkType: 'vendor_payment',
          linkId: payload.paymentId,
          fileName: `${prepared.number}-remittance.pdf`,
          sourcePath: temporary,
          legalHold: true,
        });
        const attached = await attachRemittancePdf(
          tx,
          job.organizationId,
          payload.paymentId,
          file.id,
        );
        if (!attached) throw new ConflictError('CONFLICT', 'The payment already has its advice.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: job.organizationId,
          actorUserId: ctx.userId,
          action: 'vendor_payment.remittance_generated',
          resourceType: RESOURCE,
          resourceId: payload.paymentId,
          metadata: {
            fileId: file.id,
            renderer: this.renderer.name,
            size: file.sizeBytes,
            sha256: file.sha256,
          },
          origin: systemOrigin(job.job.id),
        });
        return file.id;
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** The payer's logo from the frozen snapshot (PNG or JPEG only); a missing logo is no error. */
  private async logo(
    job: JobContext,
    snapshot: Record<string, unknown>,
  ): Promise<Buffer | undefined> {
    const fileId = (snapshot.seller as { logoFileId?: string | null } | null)?.logoFileId;
    if (!fileId) return undefined;
    try {
      return await job.run(async (tx) => {
        const { file, stream } = await this.files.openStreamInTransaction(
          tx,
          job.organizationId,
          fileId,
        );
        if (file.detectedType !== 'png' && file.detectedType !== 'jpeg') return undefined;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      });
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Email (D8, D13, D16)
  // -------------------------------------------------------------------------

  /**
   * Queues one email of the advice. The address defaults to the vendor's email and may be typed
   * instead (a vendor without one never blocks the advice, D16). Every explicit request is a new
   * audited row (D13); the PDF is rendered by the job if it is still missing.
   */
  requestEmail(
    principal: Principal,
    paymentId: string,
    input: { to?: string | undefined; subject?: string | undefined; message?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const payment = await this.payment(tx, ctx.organizationId, paymentId, { forUpdate: true });
        this.requireRecorded(payment);
        const vendor = await getVendor(tx, ctx.organizationId, payment.vendorId);
        const party = vendor
          ? await getPartyDetail(tx, ctx.organizationId, vendor.partyId)
          : undefined;
        const to = (input.to ?? party?.party.email ?? '').trim();
        if (!EMAIL.test(to) || to.length > 254) {
          throw new ValidationError([
            { path: 'to', message: 'Enter the email address to send to.' },
          ]);
        }
        const froze = await this.ensureSnapshot(tx, ctx.organizationId, payment);
        const now = this.now;
        const email = await insertRemittanceEmail(tx, {
          organizationId: ctx.organizationId,
          paymentId,
          recipient: to,
          subject: input.subject?.trim() || `Remittance advice ${payment.number}`,
          message: input.message?.trim() ?? '',
          requestedByUserId: ctx.userId,
          requestedAt: now,
        });
        const { job } = await this.jobs.enqueue(tx, {
          organizationId: ctx.organizationId,
          type: REMITTANCE_EMAIL_JOB,
          jobKey: email.id,
          payload: { emailId: email.id, paymentId, userId: ctx.userId },
          requiredPermission: VendorPaymentPermissions.Create,
          createdByUserId: ctx.userId,
        });
        await setRemittanceEmailJob(tx, ctx.organizationId, email.id, job.id);
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'vendor_payment.remittance_email_requested',
          resourceType: RESOURCE,
          resourceId: paymentId,
          // The address is personal data: it lives on the email row and is not repeated here.
          metadata: { emailId: email.id, jobId: job.id, snapshotFrozen: froze },
          origin,
        });
        return { id: email.id, status: email.status, jobId: job.id };
      },
    );
  }

  /** Marks a request failed when it can never be sent (permission withdrawn, payment voided). */
  private async failEmail(job: JobContext, emailId: string, reason: string): Promise<never> {
    await job.run((tx) =>
      completeRemittanceEmail(tx, job.organizationId, emailId, {
        status: 'failed',
        sentAt: null,
        fileId: null,
      }),
    );
    throw new PermanentJobError(reason);
  }

  /** The email job: renders a missing PDF, then sends it; a retry never repeats accounting. */
  async runEmail(job: JobContext) {
    const payload = job.job.payload as unknown as EmailPayload;
    try {
      await this.authorize(job, payload.userId);
    } catch (error) {
      return this.failEmail(job, payload.emailId, (error as Error).message);
    }
    const prepared = await job.run(async (tx) => {
      const email = await getRemittanceEmail(tx, job.organizationId, payload.emailId, {
        forUpdate: true,
      });
      if (!email || email.status !== 'queued') return null;
      const payment = await this.payment(tx, job.organizationId, email.paymentId);
      return { email, status: payment.status, fileId: payment.remittancePdfFileId };
    });
    if (!prepared) return { skipped: true };
    const { email } = prepared;
    // D6: a payment voided after the request is never advised to the vendor.
    if (prepared.status !== 'RECORDED') {
      return this.failEmail(job, email.id, 'The payment is no longer recorded.');
    }
    let fileId = prepared.fileId;
    if (!fileId) {
      await this.generatePdf(job, { paymentId: email.paymentId, userId: payload.userId });
      fileId = await job.run(async (tx) => {
        const payment = await this.payment(tx, job.organizationId, email.paymentId);
        if (!payment.remittancePdfFileId) {
          throw new ConflictError('CONFLICT', 'The remittance PDF could not be produced.');
        }
        return payment.remittancePdfFileId;
      });
    }
    const number = await job.run(async (tx) => {
      const payment = await this.payment(tx, job.organizationId, email.paymentId);
      return payment.number!;
    });
    // The PDF is already stored and linked: a failed send leaves it available and the runner retries.
    await this.deps.emailProvider.send({
      to: email.recipient,
      subject: email.subject,
      text:
        (email.message ? `${email.message}\n\n` : '') +
        `Please find remittance advice ${number} attached.`,
      template: 'purchases.remittance_advice',
      attachments: [
        { fileId, fileName: `${number}-remittance.pdf`, contentType: 'application/pdf' },
      ],
    });
    await job.run(async (tx) => {
      await completeRemittanceEmail(tx, job.organizationId, email.id, {
        status: 'sent',
        sentAt: this.now,
        fileId,
      });
      await recordAuditEvent(tx, {
        occurredAt: this.now,
        organizationId: job.organizationId,
        actorUserId: payload.userId,
        action: 'vendor_payment.remittance_emailed',
        resourceType: RESOURCE,
        resourceId: email.paymentId,
        metadata: { emailId: email.id, fileId },
        origin: systemOrigin(job.job.id),
      });
    });
    return { sent: true };
  }
}

/**
 * The deterministic PDF job key: `remittance:<payment>` for the first job, then `…:2`, `…:3` for
 * each retry after a failed one.
 */
export function nextJobKey(paymentId: string, previous: string | null): string {
  const base = `remittance:${paymentId}`;
  if (!previous) return base;
  const n = previous === base ? 1 : Number(previous.slice(base.length + 1)) || 1;
  return `${base}:${n + 1}`;
}
