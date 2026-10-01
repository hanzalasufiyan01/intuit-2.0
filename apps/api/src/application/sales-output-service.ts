import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import type { PdfRenderer } from '../infrastructure/pdf/pdf-renderer.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  attachDocumentPdf,
  completeDocumentEmail,
  getCreditNote,
  getDocumentEmail,
  getInvoice,
  insertDocumentEmail,
  listDocumentEmails,
  SalesPermissions,
  setDocumentEmailJob,
  type OutputDocumentType,
} from '../modules/sales/index.js';
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
 * Issued-document PDFs and document email (Phase 3B steps 14–15; Decisions 21, 29, 43; E4; §Z,
 * §AA). Issue freezes a render snapshot and enqueues `sales.document_pdf`; the job renders the
 * PDF from that snapshot alone through the `PdfRenderer` provider and stores it under legal hold,
 * linked once to the document. Email is sent by the `sales.document_email` job through the email
 * provider with the PDF attached by file id. Failed jobs retry and then fail visibly; the issued
 * document is never affected.
 */

export const DOCUMENT_PDF_JOB = 'sales.document_pdf';
export const DOCUMENT_EMAIL_JOB = 'sales.document_email';

const PERMISSIONS = {
  invoice: { view: SalesPermissions.InvoicesView, send: SalesPermissions.InvoicesIssue },
  credit_note: { view: SalesPermissions.CreditNotesView, send: SalesPermissions.CreditNotesIssue },
} as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PdfTarget {
  documentType: OutputDocumentType;
  documentId: string;
  userId: string;
}

export class SalesOutputService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly files: FileService,
    private readonly jobs: JobService,
    private readonly renderer: PdfRenderer,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async document(
    tx: Transaction,
    organizationId: string,
    type: OutputDocumentType,
    id: string,
    options: { forUpdate?: boolean } = {},
  ) {
    const doc =
      type === 'invoice'
        ? await getInvoice(tx, organizationId, id, options)
        : await getCreditNote(tx, organizationId, id, options);
    if (!doc)
      throw new NotFoundError(type === 'invoice' ? 'Invoice not found.' : 'Credit note not found.');
    return doc;
  }

  /** Enqueued by Issue in its own transaction (idempotent per document). */
  async enqueuePdfInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    type: OutputDocumentType,
    id: string,
  ) {
    await this.jobs.enqueue(tx, {
      organizationId: ctx.organizationId,
      type: DOCUMENT_PDF_JOB,
      jobKey: `${type}:${id}`,
      payload: { documentType: type, documentId: id, userId: ctx.userId },
      requiredPermission: PERMISSIONS[type].view,
      createdByUserId: ctx.userId,
    });
  }

  /** The PDF job: render from the snapshot, store under legal hold, link once. */
  async runPdf(job: JobContext) {
    const payload = job.job.payload as unknown as PdfTarget;
    const fileId = await this.generatePdf(job, payload);
    return fileId ? { fileId } : { skipped: true };
  }

  /**
   * Renders and stores a document's PDF unless it already has one; returns the new file id, or
   * null when there was nothing to do. Shared by the PDF job and the email job, so an email
   * never waits for the PDF job.
   */
  private async generatePdf(job: JobContext, payload: PdfTarget): Promise<string | null> {
    const snapshot = await job.run(async (tx) => {
      const doc = await this.document(
        tx,
        job.organizationId,
        payload.documentType,
        payload.documentId,
      );
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
        // A concurrent job (the email job renders a missing PDF too) may have attached it.
        const current = await this.document(
          tx,
          job.organizationId,
          payload.documentType,
          payload.documentId,
          { forUpdate: true },
        );
        if (current.pdfFileId) return null;
        const ctx = await resolveActingUserContext(tx, payload.userId, job.organizationId);
        const file = await this.files.storeGeneratedInTransaction(tx, ctx, {
          linkType: payload.documentType,
          linkId: payload.documentId,
          fileName: `${snapshot.number}.pdf`,
          sourcePath: temporary,
          legalHold: true,
        });
        const attached = await attachDocumentPdf(
          tx,
          job.organizationId,
          payload.documentType,
          payload.documentId,
          file.id,
        );
        if (!attached) throw new ConflictError('CONFLICT', 'The document already has its PDF.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: job.organizationId,
          actorUserId: ctx.userId,
          action: `${payload.documentType}.pdf_generated`,
          resourceType: payload.documentType === 'invoice' ? 'sales_invoice' : 'sales_credit_note',
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

  /** A short-lived download link for the issued PDF (or its pending state). */
  pdf(principal: Principal, type: OutputDocumentType, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PERMISSIONS[type].view },
      async (tx, ctx) => {
        const doc = await this.document(tx, ctx.organizationId, type, id);
        if (doc.status !== 'ISSUED' && doc.status !== 'VOID') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'A PDF is produced when the document is issued.',
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

  // ---------------------------------------------------------------------------
  // Email (step 15, E4)
  // ---------------------------------------------------------------------------

  emails(principal: Principal, type: OutputDocumentType, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PERMISSIONS[type].view },
      async (tx, ctx) => {
        await this.document(tx, ctx.organizationId, type, id);
        return (await listDocumentEmails(tx, ctx.organizationId, type, id)).map((e) => ({
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
   * Queues an email of an issued document to the customer (the address defaults to the
   * customer's email). Sending is the issuer's action: `invoices.issue` / `credit_notes.issue`.
   */
  requestEmail(
    principal: Principal,
    type: OutputDocumentType,
    id: string,
    input: { to?: string | undefined; subject?: string | undefined; message?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PERMISSIONS[type].send },
      async (tx, ctx) => {
        requirePermission(ctx, PERMISSIONS[type].view);
        const doc = await this.document(tx, ctx.organizationId, type, id);
        if (doc.status !== 'ISSUED') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Only issued documents can be emailed.',
          );
        }
        const customer = await getCustomer(tx, ctx.organizationId, doc.customerId);
        const party = customer
          ? await getParty(tx, ctx.organizationId, customer.partyId)
          : undefined;
        const to = (input.to ?? party?.email ?? '').trim();
        if (!EMAIL.test(to)) {
          throw new ValidationError([
            { path: 'to', message: 'Enter the email address to send to.' },
          ]);
        }
        const label = type === 'invoice' ? 'Invoice' : 'Credit note';
        const now = this.now;
        const email = await insertDocumentEmail(tx, {
          organizationId: ctx.organizationId,
          documentType: type,
          documentId: id,
          recipient: to,
          subject: input.subject?.trim() || `${label} ${doc.number}`,
          message: input.message?.trim() ?? '',
          requestedByUserId: ctx.userId,
          requestedAt: now,
        });
        const { job } = await this.jobs.enqueue(tx, {
          organizationId: ctx.organizationId,
          type: DOCUMENT_EMAIL_JOB,
          jobKey: email.id,
          payload: { emailId: email.id, userId: ctx.userId },
          requiredPermission: PERMISSIONS[type].send,
          createdByUserId: ctx.userId,
        });
        await setDocumentEmailJob(tx, ctx.organizationId, email.id, job.id);
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: `${type}.email_requested`,
          resourceType: type === 'invoice' ? 'sales_invoice' : 'sales_credit_note',
          resourceId: id,
          // The address is personal data: recorded on the email row, by reference here.
          metadata: { emailId: email.id, jobId: job.id },
          origin,
        });
        return { id: email.id, status: email.status, jobId: job.id };
      },
    );
  }

  /** The email job: waits for the PDF (retrying), then sends it through the provider. */
  async runEmail(job: JobContext) {
    const payload = job.job.payload as { emailId: string; userId: string };
    const prepared = await job.run(async (tx) => {
      const email = await getDocumentEmail(tx, job.organizationId, payload.emailId, {
        forUpdate: true,
      });
      if (!email || email.status !== 'queued') return null;
      const doc = await this.document(tx, job.organizationId, email.documentType, email.documentId);
      return { email, fileId: doc.pdfFileId, number: doc.number! };
    });
    if (!prepared) return { skipped: true };
    if (!prepared.fileId) {
      // The PDF job has not run yet: render it now (it is attached once either way).
      await this.generatePdf(job, {
        documentType: prepared.email.documentType,
        documentId: prepared.email.documentId,
        userId: payload.userId,
      });
      prepared.fileId = await job.run(async (tx) => {
        const doc = await this.document(
          tx,
          job.organizationId,
          prepared.email.documentType,
          prepared.email.documentId,
        );
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
        `Please find ${email.documentType === 'invoice' ? 'invoice' : 'credit note'} ${prepared.number} attached.`,
      template: `sales.${email.documentType}`,
      attachments: [
        {
          fileId: prepared.fileId,
          fileName: `${prepared.number}.pdf`,
          contentType: 'application/pdf',
        },
      ],
    });
    await job.run(async (tx) => {
      await completeDocumentEmail(tx, job.organizationId, email.id, {
        status: 'sent',
        sentAt: this.now,
        fileId: prepared.fileId,
      });
      await recordAuditEvent(tx, {
        occurredAt: this.now,
        organizationId: job.organizationId,
        actorUserId: payload.userId,
        action: `${email.documentType}.emailed`,
        resourceType: email.documentType === 'invoice' ? 'sales_invoice' : 'sales_credit_note',
        resourceId: email.documentId,
        metadata: { emailId: email.id, fileId: prepared.fileId },
        origin: systemOrigin(job.job.id),
      });
    });
    return { sent: true };
  }
}
