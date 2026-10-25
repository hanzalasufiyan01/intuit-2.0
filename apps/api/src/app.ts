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
import { publicApi } from './api/public/index.js';
import { ApiIntegrationService } from './application/api-integration-service.js';
import {
  WEBHOOK_DELIVER_JOB,
  WebhookDeliveryService,
  type ObjectRenderer,
} from './application/webhook-delivery-service.js';
import { WebhookEndpointService } from './application/webhook-endpoint-service.js';
import {
  HttpsWebhookTransport,
  WebhookSecretCipher,
  type WebhookTransport,
} from './modules/webhooks/index.js';
import { toBill, toCustomer, toInvoice, toVendor } from './api/public/dto-v1.js';
import { PublicEventPublisher } from './application/public-event-publisher.js';
import { PublicApiReadService } from './application/public-api-read-service.js';
import { PostgresRateLimiter, type RateLimiter } from './application/rate-limiter.js';
import { IntegrationAuthService } from './application/integration-auth-service.js';
import { ExpenseClaimService } from './application/expense-claim-service.js';
import { FixedAssetService } from './application/fixed-asset-service.js';
import { InventoryCountService } from './application/inventory-count-service.js';
import { InventoryReportService } from './application/inventory-report-service.js';
import { ClinicService } from './application/clinic-service.js';
import { ClinicConsentService } from './application/clinic-consent-service.js';
import { AssistantService } from './application/assistant/assistant-service.js';
import { createAssistantProvider } from './application/assistant/provider.js';
import type { AssistantProvider } from './application/assistant/types.js';
import { TutorialProgressService } from './application/tutorial-progress-service.js';
import { ModuleService } from './application/module-service.js';
import { PayrollExtraService } from './application/payroll-extra-service.js';
import { PayrollService } from './application/payroll-service.js';
import { InvoiceShareService } from './application/invoice-share-service.js';
import { PaymentReminderService } from './application/payment-reminder-service.js';
import { ProjectService } from './application/project-service.js';
import { QuoteService } from './application/quote-service.js';
import { RecurringInvoiceService } from './application/recurring-invoice-service.js';
import { SalesOrderService } from './application/sales-order-service.js';
import { InventoryService } from './application/inventory-service.js';
import { TaxLiabilityService } from './application/tax-liability-service.js';
import { PurchaseOrderService } from './application/purchase-order-service.js';
import { InvoiceService } from './application/invoice-service.js';
import { BillService } from './application/bill-service.js';
import { BankingPostingService } from './application/banking-posting-service.js';
import { BankingService } from './application/banking-service.js';
import { ExpenseService } from './application/expense-service.js';
import { VendorCreditService } from './application/vendor-credit-service.js';
import { VendorPaymentService } from './application/vendor-payment-service.js';
import { CustomerRefundService } from './application/customer-refund-service.js';
import { VendorRefundService } from './application/vendor-refund-service.js';
import { PaymentBatchService } from './application/payment-batch-service.js';
import { createSourceDocumentRegistry } from './application/source-documents.js';
import {
  PURCHASES_EMAIL_JOB,
  PURCHASES_PDF_JOB,
  PurchasesOutputService,
} from './application/purchases-output-service.js';
import {
  REMITTANCE_EMAIL_JOB,
  REMITTANCE_PDF_JOB,
  RemittanceService,
} from './application/remittance-service.js';
import { ReceiptService } from './application/receipt-service.js';
import { PaymentGatewayService } from './application/payment-gateway-service.js';
import { CustomerStatementService } from './application/customer-statement-service.js';
import { CashBasisReportService } from './application/cash-basis-report-service.js';
import { ExpenseClaimReportService } from './application/expense-claim-report-service.js';
import { InventoryBundleService } from './application/inventory-bundle-service.js';
import { WarehouseService } from './application/warehouse-service.js';
import { InventoryLotService } from './application/inventory-lot-service.js';
import { InventoryLandedCostService } from './application/inventory-landed-cost-service.js';
import { InventoryUnitService } from './application/inventory-unit-service.js';
import { BranchScopeService } from './application/branch-scope-service.js';
import { ClassificationService } from './application/classification-service.js';
import { DeliveryService, ReservationService } from './application/delivery-service.js';
import { ExpensePolicyService } from './application/expense-policy-service.js';
import { PettyCashService } from './application/petty-cash-service.js';
import { OrganizationGroupService } from './application/organization-group-service.js';
import { MockPaymentProvider } from './infrastructure/payments/mock-provider.js';
import { CreditNoteService } from './application/credit-note-service.js';
import { ArReportService } from './application/ar-report-service.js';
import { ApReportService } from './application/ap-report-service.js';
import { PurchasesSearchService } from './application/purchases-search-service.js';
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
import { LocalStorageProvider, NoopScanner, S3StorageProvider } from './modules/files/index.js';
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
import { OwnershipTransferService } from './application/ownership-transfer-service.js';
import { Metrics } from './infrastructure/metrics.js';
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
  /** The outbound webhook transport; tests inject a fake one. Default: pinned-address HTTPS. */
  webhookTransport?: WebhookTransport;
  /** The help assistant's provider; tests inject a fake one. Default: chosen from configuration. */
  assistantProvider?: AssistantProvider;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: {
    auth: AuthService;
    organizations: OrganizationService;
    invitations: InvitationService;
    ownershipTransfers: OwnershipTransferService;
    metrics: Metrics;
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
    expenses: ExpenseService;
    banking: BankingService;
    bankingPosting: BankingPostingService;
    inventory: InventoryService;
    inventoryReports: InventoryReportService;
    inventoryCounts: InventoryCountService;
    modules: ModuleService;
    assistant: AssistantService;
    tutorialProgress: TutorialProgressService;
    payroll: PayrollService;
    payrollExtra: PayrollExtraService;
    projects: ProjectService;
    clinic: ClinicService;
    clinicConsent: ClinicConsentService;
    quotes: QuoteService;
    reminders: PaymentReminderService;
    payments: PaymentGatewayService;
    statements: CustomerStatementService;
    cashBasis: CashBasisReportService;
    claimReports: ExpenseClaimReportService;
    inventoryBundles: InventoryBundleService;
    warehouses: WarehouseService;
    inventoryLots: InventoryLotService;
    landedCosts: InventoryLandedCostService;
    inventoryUnits: InventoryUnitService;
    branchScopes: BranchScopeService;
    classification: ClassificationService;
    deliveries: DeliveryService;
    reservations: ReservationService;
    expensePolicies: ExpensePolicyService;
    pettyCash: PettyCashService;
    organizationGroups: OrganizationGroupService;
    /** The simulated provider; present only while PAYMENTS_MOCK_ENABLED (never moves money). */
    mockPayments?: MockPaymentProvider;
    salesOrders: SalesOrderService;
    shareLinks: InvoiceShareService;
    rateLimiter: RateLimiter;
    recurring: RecurringInvoiceService;
    taxLiability: TaxLiabilityService;
    fixedAssets: FixedAssetService;
    expenseClaims: ExpenseClaimService;
    apiIntegrations: ApiIntegrationService;
    integrationAuth: IntegrationAuthService;
    webhooks: WebhookEndpointService;
    webhookDelivery: WebhookDeliveryService;
    purchaseOrders: PurchaseOrderService;
    vendorCredits: VendorCreditService;
    vendorPayments: VendorPaymentService;
    vendorRefunds: VendorRefundService;
    customerRefunds: CustomerRefundService;
    paymentBatches: PaymentBatchService;
    purchasesOutput: PurchasesOutputService;
    remittance: RemittanceService;
    receipts: ReceiptService;
    creditNotes: CreditNoteService;
    salesOutput: SalesOutputService;
    arReports: ArReportService;
    apReports: ApReportService;
    salesSearch: SalesSearchService;
    purchasesSearch: PurchasesSearchService;
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
  // P4-10 (4B-2 A5): journals link to the Sales and Purchases documents that posted them.
  const journals = new JournalService(deps, approvals, createSourceDocumentRegistry());
  const dimensions = new DimensionService(deps);
  const reports = new ReportService(deps);
  const parties = new PartyService(deps);
  // S5-02 / S5-07: local provider and no-op scanner until production adapters are approved.
  // S6 adds the import_batch and export attachment targets (S5-04).
  const files = new FileService(
    deps,
    config.storage.s3
      ? new S3StorageProvider(config.storage.s3)
      : new LocalStorageProvider(config.storage.localRoot),
    new NoopScanner(),
    new Map([...attachmentTargets, ...dataExchangeTargets]),
  );
  const jobs = new JobService(deps);
  // Phase 3B (Decision 23): reusable request idempotency for Sales create/issue and receipts.
  const idempotency = new IdempotencyService(deps);
  // Public API events (ADR 0011 step 5): additive transactional-outbox emission; no delivery.
  const publicEvents = new PublicEventPublisher(deps);
  const receipts = new ReceiptService(deps, journals, idempotency, publicEvents);
  // Customer refunds from unallocated receipts and unapplied credit notes (mirrors vendor refunds).
  const customerRefunds = new CustomerRefundService(deps, journals, idempotency, publicEvents);
  const salesOutput = new SalesOutputService(deps, files, jobs, new PdfkitRenderer());
  // S8: opening balances are an accounting process posting through the system-journal path.
  const openingBalances = new OpeningBalanceService(deps, approvals, journals, files);
  // Phase 3B Sales services used by the S6 import/export domains (step 18).
  const customers = new CustomerService(deps, parties, publicEvents);
  // Phase 4A-3: vendors on the shared Party master (ADR 0004 P4-03).
  const vendors = new VendorService(deps, parties, publicEvents);
  const items = new ItemService(deps, publicEvents);
  // Inventory (ADR 0006): additive to Sales and Purchases through hooks inside their transactions.
  const inventory = new InventoryService(deps, journals, idempotency);
  const inventoryReports = new InventoryReportService(deps);
  // Physical stock counts post their differences through the adjustment flow (FP-29 A5).
  const inventoryCounts = new InventoryCountService(deps, inventory);
  const modules = new ModuleService(deps);
  // Payroll (FP-25): off until enabled per organization; posts through accounting events.
  const payroll = new PayrollService(deps, journals, idempotency, new PdfkitRenderer());
  const payrollExtra = new PayrollExtraService(deps, journals);
  // Fixed assets (ADR 0008): register, depreciation, disposal and transfers.
  const fixedAssets = new FixedAssetService(deps, journals, idempotency);
  const invoices = new InvoiceService(
    deps,
    approvals,
    journals,
    idempotency,
    salesOutput,
    inventory,
    publicEvents,
  );
  // Projects (FP-26): time, billing into draft invoices, project profit through dimensions.
  const projects = new ProjectService(deps, invoices);
  // Sales quotes and recurring invoice schedules (FP-28): both produce DRAFT invoices only.
  const quotes = new QuoteService(deps, invoices, idempotency);
  // Clinic extension (FP-27, ADR 0013): administrative and billing data only.
  const clinic = new ClinicService(deps, invoices);
  const clinicConsent = new ClinicConsentService(deps);
  const recurring = new RecurringInvoiceService(deps, invoices);
  // Payment reminders, sales orders and read-only invoice share links (FP-28).
  const reminders = new PaymentReminderService(deps);
  const salesOrders = new SalesOrderService(deps, invoices, idempotency);
  const shareLinks = new InvoiceShareService(deps);
  // Online payments (migration 0075): a provider-neutral gateway. Only the simulated provider
  // exists; no real provider is configured.
  const mockPayments = deps.config.payments.mockEnabled
    ? new MockPaymentProvider(deps.config.payments.mockWebhookSecret, deps.config.webOrigin)
    : undefined;
  const payments = new PaymentGatewayService(
    deps,
    receipts,
    idempotency,
    mockPayments ? { mock: mockPayments } : {},
  );
  // Customer portal v1: read-only statement links (no customer accounts yet).
  const statements = new CustomerStatementService(deps, payments);
  const cashBasis = new CashBasisReportService(deps);
  const claimReports = new ExpenseClaimReportService(deps);
  const inventoryBundles = new InventoryBundleService(deps);
  const warehouses = new WarehouseService(deps, idempotency);
  const inventoryLots = new InventoryLotService(deps);
  const inventoryUnits = new InventoryUnitService(deps);
  const branchScopes = new BranchScopeService(deps);
  const classification = new ClassificationService(deps);
  const deliveries = new DeliveryService(deps);
  const reservations = new ReservationService(deps);
  const expensePolicies = new ExpensePolicyService(deps);
  const pettyCash = new PettyCashService(deps, journals);
  const organizationGroups = new OrganizationGroupService(deps);
  const landedCosts = new InventoryLandedCostService(deps, journals, idempotency, inventory);
  // Phase 4A-5: bills (ADR 0004 P4-15 to P4-22).
  // Purchase orders, goods receiving and three-way matching (ADR 0007): additive to bills.
  const purchaseOrders = new PurchaseOrderService(deps, approvals, idempotency);
  const bills = new BillService(
    deps,
    approvals,
    journals,
    idempotency,
    inventory,
    purchaseOrders,
    publicEvents,
  );
  // Phase 4B-9: direct expenses (ADR 0004 P4-44).
  const expenses = new ExpenseService(deps, approvals, journals, idempotency, inventory);
  // Banking: statements, matching, entries, transfers and reconciliation.
  const banking = new BankingService(deps, idempotency);
  const bankingPosting = new BankingPostingService(deps, journals, idempotency);
  // Employee expense claims (ADR 0009): posted as a bill from the employee as a vendor.
  const expenseClaims = new ExpenseClaimService(
    deps,
    approvals,
    idempotency,
    bills,
    vendors,
    publicEvents,
  );
  // Public API foundations (ADR 0011): organization-owned integrations and their authentication.
  const apiIntegrations = new ApiIntegrationService(deps);
  const integrationAuth = new IntegrationAuthService(deps);
  // Public API (read-only in step 3): its own queries, DTOs and PostgreSQL rate limiter.
  const publicReads = new PublicApiReadService();
  const rateLimiter = new PostgresRateLimiter(deps.db, deps.clock);
  // Webhooks (ADR 0011 step 6): management by people, fan-out and signed delivery over the
  // existing outbox and job queue. The secret cipher exists only when a key ring is configured.
  const webhookCipher = config.webhooks.keyRing
    ? new WebhookSecretCipher(config.webhooks.keyRing)
    : null;
  const webhookTransport =
    options.webhookTransport ??
    new HttpsWebhookTransport({ allowedPorts: config.webhooks.allowedPorts });
  const renderWebhookObject: ObjectRenderer = async (tx, organizationId, type, id) => {
    // `full` payloads carry the same public DTOs as the read API, built under the organization.
    if (type === 'customer') {
      const row = await publicReads.getCustomer(tx, organizationId, id);
      return row ? toCustomer(row) : null;
    }
    if (type === 'vendor') {
      const row = await publicReads.getVendor(tx, organizationId, id);
      return row ? toVendor(row) : null;
    }
    if (type === 'invoice') {
      const found = await publicReads.getInvoice(tx, organizationId, id);
      return found ? toInvoice(found.row, found.lines) : null;
    }
    if (type === 'bill') {
      const found = await publicReads.getBill(tx, organizationId, id);
      return found ? toBill(found.row, found.lines) : null;
    }
    return null;
  };
  const webhookDelivery = new WebhookDeliveryService(
    deps,
    jobs,
    webhookTransport,
    webhookCipher,
    renderWebhookObject,
  );
  const webhookEndpoints = new WebhookEndpointService(
    deps,
    webhookTransport,
    webhookCipher,
    webhookDelivery,
  );
  // Phase 4B-1: vendor credits and debit notes, with debit-note PDFs and email (P4-23, P4-46).
  const purchasesOutput = new PurchasesOutputService(deps, files, jobs, new PdfkitRenderer());
  // Phase 4B-7: vendor remittance advice PDF and email (P4-46), output only.
  const remittance = new RemittanceService(deps, files, jobs, new PdfkitRenderer());
  const vendorCredits = new VendorCreditService(
    deps,
    approvals,
    journals,
    idempotency,
    purchasesOutput,
    inventory,
    publicEvents,
  );
  // Phase 4B-2: vendor payments, prepayments, AP credit application and realized FX (P4-25 to P4-33).
  const vendorPayments = new VendorPaymentService(
    deps,
    approvals,
    journals,
    idempotency,
    publicEvents,
  );
  // Phase 4B-3: vendor refunds from prepayments and unapplied vendor credits (P4-30).
  const vendorRefunds = new VendorRefundService(deps, journals, idempotency, publicEvents);
  // Phase 4B-4: batch Pay bills over the payment pipeline (P4-32, P4-50).
  const paymentBatches = new PaymentBatchService(deps, vendorPayments, idempotency);
  const arReports = new ArReportService(deps);
  // Phase 4B-5: AP aging, vendor statements and the AP reconciliation (P4-49).
  const apReports = new ApReportService(deps);
  const taxLiability = new TaxLiabilityService(arReports, apReports);
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
    apReports,
    vendors,
    bills,
    vendorCredits,
  };
  // S9: revaluation support (engine only; no routes until Phase 4). Later modules register
  // their read-only document exposure providers here.
  // Phase 3B E5: open foreign-currency AR is reported to S9 through a read-only provider.
  const exposures = new RevaluationExposureRegistry();
  exposures.register(arReports);
  // Phase 4B-5 (PD6): open foreign-currency AP through the read-only `purchases.payables` provider.
  exposures.register(apReports);
  const revaluations = new RevaluationService(deps, journals, exposures, approvals);
  const services = {
    auth,
    organizations: new OrganizationService(deps),
    invitations: new InvitationService(deps, auth),
    ownershipTransfers: new OwnershipTransferService(deps),
    metrics: new Metrics(),
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
    expenses,
    banking,
    bankingPosting,
    inventory,
    inventoryReports,
    inventoryCounts,
    modules,
    // Help centre: tutorial progress and the help assistant (reads figures only through the
    // report services above, under the member's own permissions).
    tutorialProgress: new TutorialProgressService(deps),
    assistant: new AssistantService(deps, {
      provider: options.assistantProvider ?? createAssistantProvider(config.assistant),
      rateLimiter,
      sources: { reports, arReports, apReports },
    }),
    payroll,
    payrollExtra,
    projects,
    clinic,
    quotes,
    recurring,
    reminders,
    payments,
    statements,
    cashBasis,
    claimReports,
    inventoryBundles,
    warehouses,
    inventoryLots,
    landedCosts,
    inventoryUnits,
    branchScopes,
    classification,
    deliveries,
    reservations,
    expensePolicies,
    pettyCash,
    clinicConsent,
    organizationGroups,
    ...(mockPayments ? { mockPayments } : {}),
    salesOrders,
    shareLinks,
    rateLimiter,
    taxLiability,
    fixedAssets,
    expenseClaims,
    apiIntegrations,
    integrationAuth,
    webhooks: webhookEndpoints,
    webhookDelivery,
    purchaseOrders,
    vendorCredits,
    vendorPayments,
    vendorRefunds,
    customerRefunds,
    paymentBatches,
    // Phase 4B-5: AP aging, statements and reconciliation.
    apReports,
    purchasesOutput,
    remittance,
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
      publicEvents,
    ),
    // Phase 3B steps 14-15: PDFs (PDFKit, approved D14; docs/pdf-evaluation.md) and email.
    salesOutput,
    // Phase 3B step 16: aging, statements, AR reconciliation.
    arReports,
    // Phase 3B step 19: Sales search (D15).
    salesSearch: new SalesSearchService(deps),
    purchasesSearch: new PurchasesSearchService(deps),
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
    [PURCHASES_PDF_JOB, (job) => services.purchasesOutput.runPdf(job)],
    [PURCHASES_EMAIL_JOB, (job) => services.purchasesOutput.runEmail(job)],
    [REMITTANCE_PDF_JOB, (job) => services.remittance.runPdf(job)],
    [REMITTANCE_EMAIL_JOB, (job) => services.remittance.runEmail(job)],
  ]);
  handlers.set(WEBHOOK_DELIVER_JOB, (job) => services.webhookDelivery.handleJob(job));
  const worker = new JobWorker(deps, handlers);

  // JSON only. Dropping the default text/plain parser also means every write needs a
  // CORS-preflighted content type, which cross-site forms cannot send.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  // Request counts and latency by route pattern (never the concrete URL) for GET /api/v1/metrics.
  app.addHook('onRequest', async () => {
    services.metrics.requestStarted();
  });
  app.addHook('onResponse', async (request, reply) => {
    services.metrics.requestFinished(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
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

  // The Public API: bearer-token only, its own error contract; it shares nothing with /api/v1.
  await app.register(
    publicApi({
      config,
      integrationAuth,
      reads: publicReads,
      limiter: rateLimiter,
      writes: { idempotency, customers, items, invoices },
    }),
    { prefix: '/public/v1' },
  );

  return { app, services, worker, routes };
}
