import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AccountingService } from '../../application/accounting-service.js';
import type { ApprovalService } from '../../application/approval-service.js';
import type { AuthService } from '../../application/auth-service.js';
import type { DimensionService } from '../../application/dimension-service.js';
import type { ReportService } from '../../application/report-service.js';
import type { OrganizationProfileService } from '../../application/organization-profile-service.js';
import type { PartyService } from '../../application/party-service.js';
import type { FileService } from '../../application/file-service.js';
import type { JobService } from '../../application/job-service.js';
import type { ExportService } from '../../application/data-exchange/export-service.js';
import type { ImportService } from '../../application/data-exchange/import-service.js';
import type { AppDependencies } from '../../application/dependencies.js';
import type { InvitationService } from '../../application/invitation-service.js';
import type { JournalService } from '../../application/journal-service.js';
import type { MfaService } from '../../application/mfa-service.js';
import type { OpeningBalanceService } from '../../application/opening-balance-service.js';
import type { OrganizationSecurityService } from '../../application/organization-security-service.js';
import type { OrganizationService } from '../../application/organization-service.js';
import type { RoleService } from '../../application/role-service.js';
import type { TaxService } from '../../application/tax-service.js';
import type { CustomerService } from '../../application/customer-service.js';
import type { VendorService } from '../../application/vendor-service.js';
import type { PurchasesSettingsService } from '../../application/purchases-settings-service.js';
import type { ItemService } from '../../application/item-service.js';
import type { InvoiceService } from '../../application/invoice-service.js';
import type { BillService } from '../../application/bill-service.js';
import type { VendorCreditService } from '../../application/vendor-credit-service.js';
import type { PurchasesOutputService } from '../../application/purchases-output-service.js';
import type { ReceiptService } from '../../application/receipt-service.js';
import type { CreditNoteService } from '../../application/credit-note-service.js';
import type { SalesOutputService } from '../../application/sales-output-service.js';
import type { ArReportService } from '../../application/ar-report-service.js';
import type { SalesSearchService } from '../../application/sales-search-service.js';
import type { SalesSettingsService } from '../../application/sales-settings-service.js';
import { registerAccountingRoutes } from './accounting.routes.js';
import { registerApprovalRoutes } from './approvals.routes.js';
import { registerAuthRoutes } from './auth.routes.js';
import { registerInvitationRoutes } from './invitations.routes.js';
import { registerMfaRoutes } from './mfa.routes.js';
import { registerOrganizationRoutes } from './organizations.routes.js';
import { registerReportRoutes } from './reports.routes.js';
import { registerPartyRoutes } from './parties.routes.js';
import { registerFileRoutes } from './files.routes.js';
import { registerJobRoutes } from './jobs.routes.js';
import { registerDataExchangeRoutes } from './data-exchange.routes.js';
import { registerTaxRoutes } from './tax.routes.js';
import { registerCustomerRoutes } from './customers.routes.js';
import { registerVendorRoutes } from './vendors.routes.js';
import { registerPurchasesRoutes } from './purchases.routes.js';
import { registerSalesRoutes } from './sales.routes.js';
import { registerInvoiceRoutes } from './invoices.routes.js';
import { registerBillRoutes } from './bills.routes.js';
import { registerVendorCreditRoutes } from './vendor-credits.routes.js';
import { registerReceiptRoutes } from './receipts.routes.js';
import { registerCreditNoteRoutes } from './credit-notes.routes.js';
import { registerSalesOutputRoutes } from './sales-output.routes.js';
import { registerSalesReportRoutes } from './sales-reports.routes.js';

export interface ApiV1Services {
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
  mfa: MfaService;
  organizationSecurity: OrganizationSecurityService;
  openingBalances: OpeningBalanceService;
  tax: TaxService;
  salesSettings: SalesSettingsService;
  customers: CustomerService;
  vendors: VendorService;
  purchasesSettings: PurchasesSettingsService;
  items: ItemService;
  invoices: InvoiceService;
  bills: BillService;
  vendorCredits: VendorCreditService;
  purchasesOutput: PurchasesOutputService;
  receipts: ReceiptService;
  creditNotes: CreditNoteService;
  salesOutput: SalesOutputService;
  arReports: ArReportService;
  salesSearch: SalesSearchService;
}

/** Version 1 of the REST API, mounted at /api/v1. */
export function apiV1(deps: AppDependencies, services: ApiV1Services) {
  return async (app: FastifyInstance) => {
    app.get('/health', async (_request, reply) => {
      try {
        await deps.db.execute(sql`SELECT 1`);
        return { data: { status: 'ok', database: 'ok' } };
      } catch {
        return reply.status(503).send({ data: { status: 'degraded', database: 'unavailable' } });
      }
    });
    registerAuthRoutes(app, { auth: services.auth, config: deps.config });
    registerMfaRoutes(app, { auth: services.auth, mfa: services.mfa, config: deps.config });
    registerOrganizationRoutes(app, services);
    registerInvitationRoutes(app, {
      invitations: services.invitations,
      auth: services.auth,
      config: deps.config,
    });
    registerApprovalRoutes(app, services);
    registerAccountingRoutes(app, services);
    registerReportRoutes(app, services);
    registerPartyRoutes(app, services);
    registerFileRoutes(app, services);
    registerJobRoutes(app, services);
    registerDataExchangeRoutes(app, services);
    registerTaxRoutes(app, services);
    registerSalesRoutes(app, services);
    registerCustomerRoutes(app, services);
    registerVendorRoutes(app, services);
    registerPurchasesRoutes(app, services);
    registerBillRoutes(app, services);
    registerVendorCreditRoutes(app, services);
    registerInvoiceRoutes(app, services);
    registerReceiptRoutes(app, services);
    registerCreditNoteRoutes(app, services);
    registerSalesOutputRoutes(app, services);
    registerSalesReportRoutes(app, services);
  };
}
