import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import type { PdfRenderer } from '../infrastructure/pdf/pdf-renderer.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  attachVendorCreditPdf,
  completePurchasesDocumentEmail,
  getPurchasesDocumentEmail,
  getVendorCredit,
  insertPurchasesDocumentEmail,
  listPurchasesDocumentEmails,
  setPurchasesDocumentEmailJob,
  VendorCreditPermissions,
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
 * Debit-note PDFs and email (ADR 0004 P4-23, P4-46). The same pattern as Sales documents
 * (Decisions 21, 29, 43; E4): Post freezes a render snapshot and enqueues
 * `purchases.document_pdf`; the job renders the PDF from that snapshot alone through the shared
 * `PdfRenderer` provider and stores it under legal hold, linked once to the debit note. Email is
 * sent by `purchases.document_email` through the email provider with the PDF attached. The
 * production email vendor stays deferred (U18). Supplier credit notes are received documents:
 * their evidence is an attachment, not a generated PDF.
 */

export const PURCHASES_PDF_JOB = 'purchases.document_pdf';
export const PURCHASES_EMAIL_JOB = 'purchases.document_email';
const RESOURCE = 'purchases_vendor_credit';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PdfTarget {
  documentId: string;
  userId: string;
}

export class PurchasesOutputService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly files: FileService,
    private readonly jobs: JobService,
    private readonly renderer: PdfRenderer,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async debitNote(
    tx: Transaction,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ) {
    const doc = await getVendorCredit(tx, organizationId, id, options);
    if (!doc || doc.origin !== 'debit_note') throw new NotFoundError('Debit note not found.');
    return doc;
  }

  /** Enqueued by Post in its own transaction (idempotent per debit note). */
  async enqueuePdfInTransaction(tx: Transaction, ctx: AuthorizationContext, id: string) {
    await this.jobs.enqueue(tx, {
      organizationId: ctx.organizationId,
      type: PURCHASES_PDF_JOB,
      jobKey: `debit_note:${id}`,
      payload: { documentId: id, userId: ctx.userId },
      requiredPermission: VendorCreditPermissions.View,
      createdByUserId: ctx.userId,
    });
  }

  async runPdf(job: JobContext) {
    const payload = job.job.payload as unknown as PdfTarget;
    const fileId = await this.generatePdf(job, payload);
    return fileId ? { fileId } : { skipped: true };
  }

  /** Renders and stores the PDF unless the debit note already has one. */
  private async generatePdf(job: JobContext, payload: PdfTarget): Promise<string | null> {
    const snapshot = await job.run(async (tx) => {
      const doc = await this.debitNote(tx, job.organizationId, payload.documentId);
      return doc.pdfFileId || !doc.renderSnapshot
        ? null
        : { snapshot: doc.renderSnapshot, number: doc.number! };
    });
    if (!snapshot) return null;
    const logo = await this.logo(job, snapshot.snapshot);
    const bytes = await this.renderer.render(snapshot.snapshot, { logo });
    const temporary = path.join(tmpdir(), `intuit2-pdf-${randomUUID()}.pdf`);
    await writeFile(temporary, bytes);
    try {
      return await job.run(async (tx) => {
        const current = await this.debitNote(tx, job.organizationId, payload.documentId, {
          forUpdate: true,
        });
        if (current.pdfFileId) return null;
        const ctx = await resolveActingUserContext(tx, payload.userId, job.organizationId);
        const file = await this.files.storeGeneratedInTransaction(tx, ctx, {
          linkType: 'vendor_credit',
          linkId: payload.documentId,
          fileName: `${snapshot.number}.pdf`,
          sourcePath: temporary,
          legalHold: true,
        });
        const attached = await attachVendorCreditPdf(
          tx,
          job.organizationId,
          payload.documentId,
          file.id,
        );
        if (!attached) throw new ConflictError('CONFLICT', 'The debit note already has its PDF.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: job.organizationId,
          actorUserId: ctx.userId,
          action: 'debit_note.pdf_generated',
          resourceType: RESOURCE,
          resourceId: payload.documentId,
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

  /** The logo referenced by the snapshot (PNG or JPEG only); a missing logo is not an error. */
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

  /** A short-lived download link for the debit note's PDF (or its pending state). */
  pdf(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.View },
      async (tx, ctx) => {
        const doc = await this.debitNote(tx, ctx.organizationId, id);
        if (doc.status !== 'POSTED' && doc.status !== 'VOID') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'A PDF is produced when the debit note is posted.',
          );
        }
        return {
          status: doc.pdfFileId ? ('ready' as const) : ('pending' as const),
          fileId: doc.pdfFileId ?? null,
        };
      },
    ).then(async (result) =>
      result.fileId
        ? { ...result, download: await this.files.downloadUrl(principal, result.fileId) }
        : result,
    );
  }

  emails(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.View },
      async (tx, ctx) => {
        await this.debitNote(tx, ctx.organizationId, id);
        return (await listPurchasesDocumentEmails(tx, ctx.organizationId, id)).map((e) => ({
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

  /**
   * Queues an email of a posted debit note to the vendor (the address defaults to the vendor's
   * email). Sending is the poster's action: `vendor_credits.post`.
   */
  requestEmail(
    principal: Principal,
    id: string,
    input: { to?: string | undefined; subject?: string | undefined; message?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.Post },
      async (tx, ctx) => {
        requirePermission(ctx, VendorCreditPermissions.View);
        const doc = await this.debitNote(tx, ctx.organizationId, id);
        if (doc.status !== 'POSTED') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Only posted debit notes can be emailed.',
          );
        }
        const vendor = await getVendor(tx, ctx.organizationId, doc.vendorId);
        const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
        const to = (input.to ?? party?.email ?? '').trim();
        if (!EMAIL.test(to)) {
          throw new ValidationError([
            { path: 'to', message: 'Enter the email address to send to.' },
          ]);
        }
        const now = this.now;
        const email = await insertPurchasesDocumentEmail(tx, {
          organizationId: ctx.organizationId,
          documentType: 'debit_note',
          documentId: id,
          recipient: to,
          subject: input.subject?.trim() || `Debit note ${doc.number}`,
          message: input.message?.trim() ?? '',
          requestedByUserId: ctx.userId,
          requestedAt: now,
        });
        const { job } = await this.jobs.enqueue(tx, {
          organizationId: ctx.organizationId,
          type: PURCHASES_EMAIL_JOB,
          jobKey: email.id,
          payload: { emailId: email.id, userId: ctx.userId },
          requiredPermission: VendorCreditPermissions.Post,
          createdByUserId: ctx.userId,
        });
        await setPurchasesDocumentEmailJob(tx, ctx.organizationId, email.id, job.id);
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'debit_note.email_requested',
          resourceType: RESOURCE,
          resourceId: id,
          // The address is personal data: recorded on the email row, by reference here.
          metadata: { emailId: email.id, jobId: job.id },
          origin,
        });
        return { id: email.id, status: email.status, jobId: job.id };
      },
    );
  }

  /** The email job: renders a missing PDF, then sends it through the provider. */
  async runEmail(job: JobContext) {
    const payload = job.job.payload as { emailId: string; userId: string };
    const prepared = await job.run(async (tx) => {
      const email = await getPurchasesDocumentEmail(tx, job.organizationId, payload.emailId, {
        forUpdate: true,
      });
      if (!email || email.status !== 'queued') return null;
      const doc = await this.debitNote(tx, job.organizationId, email.documentId);
      return { email, fileId: doc.pdfFileId, number: doc.number! };
    });
    if (!prepared) return { skipped: true };
    if (!prepared.fileId) {
      await this.generatePdf(job, {
        documentId: prepared.email.documentId,
        userId: payload.userId,
      });
      prepared.fileId = await job.run(async (tx) => {
        const doc = await this.debitNote(tx, job.organizationId, prepared.email.documentId);
        if (!doc.pdfFileId) throw new AppError('CONFLICT', 409, 'The PDF could not be produced.');
        return doc.pdfFileId;
      });
    }
    const { email } = prepared;
    await this.deps.emailProvider.send({
      to: email.recipient,
      subject: email.subject,
      text:
        (email.message ? `${email.message}\n\n` : '') +
        `Please find debit note ${prepared.number} attached.`,
      template: 'purchases.debit_note',
      attachments: [
        {
          fileId: prepared.fileId,
          fileName: `${prepared.number}.pdf`,
          contentType: 'application/pdf',
        },
      ],
    });
    await job.run(async (tx) => {
      await completePurchasesDocumentEmail(tx, job.organizationId, email.id, {
        status: 'sent',
        sentAt: this.now,
        fileId: prepared.fileId,
      });
      await recordAuditEvent(tx, {
        occurredAt: this.now,
        organizationId: job.organizationId,
        actorUserId: payload.userId,
        action: 'debit_note.emailed',
        resourceType: RESOURCE,
        resourceId: email.documentId,
        metadata: { emailId: email.id, fileId: prepared.fileId },
        origin: systemOrigin(job.job.id),
      });
    });
    return { sent: true };
  }
}
