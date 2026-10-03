import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './api/http/errors.js';
import { registerSessionSecurity } from './api/http/session.js';
import { apiV1 } from './api/v1/index.js';
import { AccountingService } from './application/accounting-service.js';
import { DimensionService } from './application/dimension-service.js';
import { ReportService } from './application/report-service.js';
import { OrganizationProfileService } from './application/organization-profile-service.js';
import { PartyService } from './application/party-service.js';
import { TaxService } from './application/tax-service.js';
import { CustomerService } from './application/customer-service.js';
import { VendorService } from './application/vendor-service.js';
import { PurchasesSettingsService } from './application/purchases-settings-service.js';
import { ItemService } from './application/item-service.js';
import { InvoiceService } from './application/invoice-service.js';
import { BillService } from './application/bill-service.js';
import { ReceiptService } from './application/receipt-service.js';
import { CreditNoteService } from './application/credit-note-service.js';
import { ArReportService } from './application/ar-report-service.js';
import { SalesSearchService } from './application/sales-search-service.js';
import {
  DOCUMENT_EMAIL_JOB,
  DOCUMENT_PDF_JOB,
  SalesOutputService,
} from './application/sales-output-service.js';
import { PdfkitRenderer } from './infrastructure/pdf/pdf-renderer.js';
import { SalesSettingsService } from './application/sales-settings-service.js';
import { FileService } from './application/file-service.js';
import {
  FILES_PURGE_JOB,
  JobService,
  JobWorker,
  type JobHandler,
} from './application/job-service.js';
import { LocalStorageProvider, NoopScanner } from './modules/files/index.js';
import { attachmentTargets } from './application/attachment-targets.js';
import {
  DATA_EXCHANGE_CLEANUP_JOB,
  DataExchangeCleanup,
} from './application/data-exchange/cleanup-service.js';
import { EXPORT_GENERATE_JOB, ExportService } from './application/data-exchange/export-service.js';
import { dataExchangeTargets } from './application/data-exchange/file-targets.js';
import {
  IMPORT_COMMIT_JOB,
  IMPORT_VALIDATE_JOB,
  ImportService,
} from './application/data-exchange/import-service.js';
import { ApprovalService } from './application/approval-service.js';
import { AuthService } from './application/auth-service.js';
import type { AppDependencies } from './application/dependencies.js';
import { InvitationService } from './application/invitation-service.js';
import { IdempotencyService } from './application/idempotency-service.js';
import { JournalService } from './application/journal-service.js';
import { MfaService } from './application/mfa-service.js';
import { MfaVerifier } from './application/mfa-verifier.js';
import { OpeningBalanceService } from './application/opening-balance-service.js';
import { OrganizationSecurityService } from './application/organization-security-service.js';
import { OrganizationService } from './application/organization-service.js';
import { RevaluationExposureRegistry } from './application/revaluation-exposures.js';
import { RevaluationService } from './application/revaluation-service.js';
import { RoleService } from './application/role-service.js';
import { loggerOptions, type LogDestination } from './infrastructure/logging/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export interface BuildAppOptions {
  deps: Omit<AppDependencies, 'logger'>;
  /** Optional log destination (tests capture logs to assert no secrets are written). */
  logStream?: LogDestination;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: {
    auth: AuthService;
    organizations: OrganizationService;
    invitations: InvitationService;
    roles: RoleService;
    approvals: ApprovalService;
    accounting: AccountingService;
    journals: JournalService;
    dimensions: DimensionService;
    reports: ReportService;
    organizationProfile: OrganizationProfileService;
    parties: PartyService;
    files: FileService;
    jobs: JobService;
    imports: ImportService;
    exports: ExportService;
    dataExchangeCleanup: DataExchangeCleanup;
    mfa: MfaService;
    organizationSecurity: OrganizationSecurityService;
    openingBalances: OpeningBalanceService;
    revaluations: RevaluationService;
    idempotency: IdempotencyService;
    tax: TaxService;
    salesSettings: SalesSettingsService;
    customers: CustomerService;
    vendors: VendorService;
    purchasesSettings: PurchasesSettingsService;
    items: ItemService;
    invoices: InvoiceService;
    bills: BillService;
    receipts: ReceiptService;
    creditNotes: CreditNoteService;
    salesOutput: SalesOutputService;
    arReports: ArReportService;
    salesSearch: SalesSearchService;
  };
  /** Every registered route (method + URL), e.g. for the MFA default-deny test (S7-44). */
  routes: { method: string; url: string }[];
  /** The background worker with every registered handler (started by server.ts, S5-17). */
  worker: JobWorker;
}

/** Composition root for the HTTP application. */
export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options.deps;
  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    // Reuse a well-formed incoming request id (e.g. from a proxy), otherwise mint one.
    genReqId: (request) => {
      const incoming = request.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const deps: AppDependencies = { ...options.deps, logger: app.log };
  const verifier = new MfaVerifier(deps);
  const auth = new AuthService(deps, verifier);
  const approvals = new ApprovalService(deps);
  const accounting = new AccountingService(deps, approvals);
  const journals = new JournalService(deps, approvals);
  const dimensions = new DimensionService(deps);
  const reports = new ReportService(deps);
  const parties = new PartyService(deps);
  // S5-02 / S5-07: local provider and no-op scanner until production adapters are approved.
  // S6 adds the import_batch and export attachment targets (S5-04).
  const files = new FileService(
    deps,
    new LocalStorageProvider(config.storage.localRoot),
    new NoopScanner(),
    new Map([...attachmentTargets, ...dataExchangeTargets]),
  );
  const jobs = new JobService(deps);
  // Phase 3B (Decision 23): reusable request idempotency for Sales create/issue and receipts.
  const idempotency = new IdempotencyService(deps);
  const receipts = new ReceiptService(deps, journals, idempotency);
  const salesOutput = new SalesOutputService(deps, files, jobs, new PdfkitRenderer());
  // S8: opening balances are an accounting process posting through the system-journal path.
  const openingBalances = new OpeningBalanceService(deps, approvals, journals, files);
  // Phase 3B Sales services used by the S6 import/export domains (step 18).
  const customers = new CustomerService(deps, parties);
  // Phase 4A-3: vendors on the shared Party master (ADR 0004 P4-03).
  const vendors = new VendorService(deps, parties);
  const items = new ItemService(deps);
  const invoices = new InvoiceService(deps, approvals, journals, idempotency, salesOutput);
  // Phase 4A-5: bills (ADR 0004 P4-15 to P4-22).
  const bills = new BillService(deps, approvals, journals, idempotency);
  const arReports = new ArReportService(deps);
  const domainServices = {
    accounting,
    journals,
    parties,
    dimensions,
    reports,
    openingBalances,
    customers,
    items,
    invoices,
    arReports,
  };
  // S9: revaluation support (engine only; no routes until Phase 4). Later modules register
  // their read-only document exposure providers here.
  // Phase 3B E5: open foreign-currency AR is reported to S9 through a read-only provider.
  const exposures = new RevaluationExposureRegistry();
  exposures.register(arReports);
  const revaluations = new RevaluationService(deps, journals, exposures);
  const services = {
    auth,
    organizations: new OrganizationService(deps),
    invitations: new InvitationService(deps, auth),
    roles: new RoleService(deps),
    approvals,
    accounting,
    journals,
    dimensions,
    reports,
    organizationProfile: new OrganizationProfileService(deps),
    parties,
    files,
    jobs,
    imports: new ImportService(deps, domainServices, files, jobs),
    exports: new ExportService(deps, domainServices, files, jobs),
    dataExchangeCleanup: new DataExchangeCleanup(deps, files, jobs),
    mfa: new MfaService(deps, auth, verifier),
    organizationSecurity: new OrganizationSecurityService(deps, auth),
    openingBalances,
    revaluations,
    idempotency,
    // Phase 3B step 2: tax codes (Decisions 15, 33, 60).
    tax: new TaxService(deps),
    // Phase 3B steps 3-5: Sales settings and numbering, customers, items.
    salesSettings: new SalesSettingsService(deps, accounting),
    customers,
    // Phase 4A-3: vendors (ADR 0004 P4-03).
    vendors,
    // Phase 4A-4: Purchases settings, numbering and the AP control account (P4-07, P4-08, P4-51).
    purchasesSettings: new PurchasesSettingsService(deps, accounting),
    bills,
    items,
    // Phase 3B steps 6-7: invoice drafts, conditional approval and atomic issue (D1).
    invoices,
    // Phase 3B steps 8-11: receipts, allocations, customer credit, realized FX, void.
    receipts,
    // Phase 3B step 12: credit notes (Decision 41).
    creditNotes: new CreditNoteService(
      deps,
      approvals,
      journals,
      receipts,
      idempotency,
      salesOutput,
    ),
    // Phase 3B steps 14-15: PDFs (PDFKit, approved D14; docs/pdf-evaluation.md) and email.
    salesOutput,
    // Phase 3B step 16: aging, statements, AR reconciliation.
    arReports,
    // Phase 3B step 19: Sales search (D15).
    salesSearch: new SalesSearchService(deps),
  };
  const handlers = new Map<string, JobHandler>([
    [FILES_PURGE_JOB, (job) => services.files.purge(job)],
    // S6-10: import/export work runs under the requesting user's current permissions (L-6).
    [IMPORT_VALIDATE_JOB, (job) => services.imports.runValidation(job)],
    [IMPORT_COMMIT_JOB, (job) => services.imports.runCommit(job)],
    [EXPORT_GENERATE_JOB, (job) => services.exports.runGenerate(job)],
    [DATA_EXCHANGE_CLEANUP_JOB, (job) => services.dataExchangeCleanup.run(job)],
    [DOCUMENT_PDF_JOB, (job) => services.salesOutput.runPdf(job)],
    [DOCUMENT_EMAIL_JOB, (job) => services.salesOutput.runEmail(job)],
  ]);
  const worker = new JobWorker(deps, handlers);

  // JSON only. Dropping the default text/plain parser also means every write needs a
  // CORS-preflighted content type, which cross-site forms cannot send.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    // Routes may tighten this (file delivery sends `private, no-store`, S5-09).
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    return payload;
  });

  await app.register(
    async (api) => {
      registerSessionSecurity(api, { config, auth });
      await api.register(apiV1(deps, services));
    },
    { prefix: '/api/v1' },
  );

  return { app, services, worker, routes };
}
