import {
  ConflictError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getAccount, isBankOrCash, listAccounts } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  DEFAULT_NUMBERING,
  getSalesSettings,
  insertSalesSettings,
  listNumberSequences,
  numberingView as sharedNumberingView,
  planNumbering,
  salesDocumentTypes,
  SalesPermissions,
  updateNumberSequence,
  updateSalesSettings,
  type NumberingFields,
  type SalesDocumentType,
  type SalesNumberSequence,
  type SalesSettings,
  type SalesSettingsFields,
} from '../modules/sales/index.js';
import { getTaxCode, type TaxTreatment } from '../modules/tax/index.js';
import type { AccountingService } from './accounting-service.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/** Who may read the Sales settings: their manager and the people preparing Sales documents. */
const SETTINGS_VIEW_PERMISSIONS = [
  SalesPermissions.SettingsManage,
  SalesPermissions.InvoicesView,
  SalesPermissions.InvoicesCreate,
  SalesPermissions.CreditNotesCreate,
  SalesPermissions.ReceiptsCreate,
] as const;

export interface SalesSettingsInput extends SalesSettingsFields {
  /** 0 for the first save; otherwise the version read. */
  version: number;
  numbering?: { [K in SalesDocumentType]?: NumberingFields | undefined } | undefined;
}

const FIELD_KEYS = [
  'arAccountId',
  'defaultRevenueAccountId',
  'defaultDepositAccountId',
  'defaultTaxCodeId',
  'defaultTaxTreatment',
  'defaultPaymentTermsDays',
] as const satisfies readonly (keyof SalesSettingsFields)[];

const DEFAULT_FIELDS: SalesSettingsFields = {
  arAccountId: null,
  defaultRevenueAccountId: null,
  defaultDepositAccountId: null,
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive' satisfies TaxTreatment,
  defaultPaymentTermsDays: 30,
};

function numberingView(
  sequences: readonly Pick<SalesNumberSequence, 'documentType' | keyof NumberingFields>[],
) {
  return sharedNumberingView(salesDocumentTypes, sequences, DEFAULT_NUMBERING);
}

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'The Sales settings were changed by someone else. Reload them and apply your changes again.',
  );

/**
 * Sales settings and document numbering (D3, D7, Decisions 11, 14, 42; Phase 3B D12, E3).
 * Changes need `sales.settings.manage` (an MFA-required key, Decision 57a) and a recent password
 * confirmation. The AR control account is marked through accounting (E3) and is fixed once the
 * first Sales document is issued.
 */
export class SalesSettingsService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly accounting: AccountingService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async view(tx: Transaction, organizationId: string, settings: SalesSettings | undefined) {
    const sequences = settings ? await listNumberSequences(tx, organizationId) : [];
    const fields: SalesSettingsFields = settings ?? DEFAULT_FIELDS;
    return {
      configured: settings !== undefined,
      version: settings?.version ?? 0,
      ...Object.fromEntries(FIELD_KEYS.map((k) => [k, fields[k]])),
      arLocked: Boolean(settings?.arLockedAt),
      // Before the first save, the single eligible receivables account is proposed.
      suggestedArAccountId: settings ? null : await this.suggestArAccount(tx, organizationId),
      numbering: numberingView(sequences),
    } as SalesSettingsFields & {
      configured: boolean;
      version: number;
      arLocked: boolean;
      suggestedArAccountId: string | null;
      numbering: ReturnType<typeof numberingView>;
    };
  }

  private async suggestArAccount(tx: Transaction, organizationId: string) {
    const settings = await requireAccountingSettings(tx, organizationId);
    const candidates = (await listAccounts(tx, organizationId)).filter(
      (a) =>
        a.status === 'ACTIVE' &&
        a.isLeaf &&
        a.accountType === 'ASSET' &&
        a.subtype === 'ACCOUNTS_RECEIVABLE' &&
        a.currencyCode === settings.baseCurrency &&
        !a.usedInPostedJournals,
    );
    return candidates.length === 1 ? candidates[0]!.id : null;
  }

  get(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      if (!SETTINGS_VIEW_PERMISSIONS.some((p) => hasPermission(ctx, p))) {
        throw new PermissionDeniedError();
      }
      await requireAccountingSettings(tx, ctx.organizationId);
      return this.view(tx, ctx.organizationId, await getSalesSettings(tx, ctx.organizationId));
    });
  }

  /** Validates the default accounts and tax code; AR is validated by accounting (E3). */
  private async fieldIssues(tx: Transaction, organizationId: string, input: SalesSettingsFields) {
    const settings = await requireAccountingSettings(tx, organizationId);
    const issues: ValidationIssue[] = [];
    const account = async (id: string | null, path: string) => {
      if (!id) return undefined;
      const found = await getAccount(tx, organizationId, id);
      if (!found) issues.push({ path, message: 'Account not found.' });
      else if (found.status !== 'ACTIVE')
        issues.push({ path, message: 'Choose an active account.' });
      else if (!found.isLeaf) issues.push({ path, message: 'Choose a posting (leaf) account.' });
      else if (found.isControlAccount && path !== 'arAccountId') {
        issues.push({ path, message: 'A control account cannot be used here.' });
      } else return found;
      return undefined;
    };
    const revenue = await account(input.defaultRevenueAccountId, 'defaultRevenueAccountId');
    if (revenue && revenue.accountType !== 'REVENUE') {
      issues.push({ path: 'defaultRevenueAccountId', message: 'Choose a revenue account.' });
    } else if (revenue && revenue.currencyCode !== settings.baseCurrency) {
      issues.push({
        path: 'defaultRevenueAccountId',
        message: 'The revenue account is in the base currency.',
      });
    }
    const deposit = await account(input.defaultDepositAccountId, 'defaultDepositAccountId');
    if (deposit && !isBankOrCash(deposit.subtype)) {
      issues.push({
        path: 'defaultDepositAccountId',
        message: 'Choose a bank or cash account (Decision 42).',
      });
    }
    if (input.defaultTaxCodeId) {
      const code = await getTaxCode(tx, organizationId, input.defaultTaxCodeId);
      if (!code) issues.push({ path: 'defaultTaxCodeId', message: 'Tax code not found.' });
      else if (code.status !== 'ACTIVE') {
        issues.push({ path: 'defaultTaxCodeId', message: 'Choose an active tax code.' });
      }
    }
    return issues;
  }

  update(principal: Principal, input: SalesSettingsInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.SettingsManage, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const current = await getSalesSettings(tx, ctx.organizationId, { forUpdate: true });
        if ((current?.version ?? 0) !== input.version) throw versionConflict();
        const fields = Object.fromEntries(
          FIELD_KEYS.map((k) => [k, input[k]]),
        ) as SalesSettingsFields;
        const before: SalesSettingsFields = current ?? DEFAULT_FIELDS;

        const issues = await this.fieldIssues(tx, ctx.organizationId, fields);
        if (current?.arLockedAt && fields.arAccountId !== current.arAccountId) {
          issues.push({
            path: 'arAccountId',
            message: 'The AR control account cannot change once Sales documents have been issued.',
          });
        }
        const sequences = current
          ? await listNumberSequences(tx, ctx.organizationId, { forUpdate: true })
          : [];
        const plan = planNumbering({
          types: salesDocumentTypes,
          existing: sequences,
          defaults: DEFAULT_NUMBERING,
          wanted: input.numbering,
        });
        issues.push(...plan.issues);
        const numbering = plan.numbering as Record<SalesDocumentType, NumberingFields>;
        if (issues.length) throw new ValidationError(issues);

        if (fields.arAccountId !== before.arAccountId) {
          await this.accounting.setReceivablesControlInTransaction(
            tx,
            ctx,
            {
              accountId: fields.arAccountId,
              previousAccountId: before.arAccountId,
              path: 'arAccountId',
            },
            origin,
          );
        }

        const changed = FIELD_KEYS.filter((k) => fields[k] !== before[k]);
        const numberingChanges = plan.changes;
        const anyChange = changed.length > 0 || Object.keys(numberingChanges).length > 0;

        let saved: SalesSettings | undefined;
        if (!current) {
          saved = await insertSalesSettings(tx, {
            organizationId: ctx.organizationId,
            fields,
            numbering,
            userId: ctx.userId,
            now: this.now,
          });
          if (!saved) throw versionConflict();
        } else if (anyChange) {
          // Any change bumps the settings version, numbering included (no silent overwrites).
          saved = await updateSalesSettings(tx, {
            organizationId: ctx.organizationId,
            version: input.version,
            set: Object.fromEntries(changed.map((k) => [k, fields[k]])),
            userId: ctx.userId,
            now: this.now,
          });
          if (!saved) throw versionConflict();
        } else {
          saved = current;
        }

        if (current) {
          for (const type of Object.keys(numberingChanges) as SalesDocumentType[]) {
            await updateNumberSequence(tx, {
              organizationId: ctx.organizationId,
              documentType: type,
              set: numbering[type],
              userId: ctx.userId,
              now: this.now,
            });
          }
        }

        if (!current || anyChange) {
          await this.audit(
            tx,
            ctx,
            current ? 'sales_settings.updated' : 'sales_settings.created',
            {
              changedFields: changed,
              before: Object.fromEntries(changed.map((k) => [k, before[k]])),
              after: Object.fromEntries(changed.map((k) => [k, fields[k]])),
              numbering: numberingChanges,
            },
            origin,
          );
        }
        return this.view(tx, ctx.organizationId, saved);
      },
    );
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'sales_settings',
      resourceId: ctx.organizationId,
      metadata,
      origin,
    });
  }
}
