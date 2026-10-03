import {
  ConflictError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  designationsOfAccount,
  getAccount,
  isBankOrCash,
  listAccounts,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  numberingView,
  planNumbering,
  type NumberSequenceFields,
} from '../modules/documents/index.js';
import {
  DEFAULT_PURCHASE_NUMBERING,
  getPurchasesSettings,
  insertPurchasesSettings,
  listPurchaseNumberSequences,
  purchaseDocumentTypes,
  PurchasesPermissions,
  updatePurchaseNumberSequence,
  updatePurchasesSettings,
  type PurchaseDocumentType,
  type PurchasesSettings,
  type PurchasesSettingsFields,
} from '../modules/purchases/index.js';
import { getTaxCode, type TaxTreatment } from '../modules/tax/index.js';
import { purchaseAccountProblem } from '../modules/vendors/index.js';
import type { AccountingService } from './accounting-service.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Purchases settings and document numbering (Phase 4A-4; ADR 0004 P4-07, P4-08, P4-19, P4-26,
 * P4-39, P4-41, P4-42, P4-51). Changes need `purchases.settings.manage` (an MFA-required key,
 * P4-41) and a recent password confirmation (P4-42). The AP control account is claimed and
 * released only through accounting's generalized subledger-control operation (4A-1), owned by
 * `purchases`, and is fixed once the first Purchases document is posted. Settings never post.
 */

/** Who may read the Purchases settings. The bill keys join when Bills exist (brief §24). */
const SETTINGS_VIEW_PERMISSIONS = [PurchasesPermissions.SettingsManage] as const;

export interface PurchasesSettingsInput extends PurchasesSettingsFields {
  /** 0 for the first save; otherwise the version read. */
  version: number;
  numbering?: { [K in PurchaseDocumentType]?: NumberSequenceFields | undefined } | undefined;
}

const FIELD_KEYS = [
  'apAccountId',
  'defaultExpenseAccountId',
  'defaultPaymentAccountId',
  'defaultTaxCodeId',
  'defaultTaxTreatment',
  'defaultPaymentTermsDays',
] as const satisfies readonly (keyof PurchasesSettingsFields)[];

const DEFAULT_FIELDS: PurchasesSettingsFields = {
  apAccountId: null,
  defaultExpenseAccountId: null,
  defaultPaymentAccountId: null,
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive' satisfies TaxTreatment,
  defaultPaymentTermsDays: 30,
};

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'The Purchases settings were changed by someone else. Reload them and apply your changes again.',
  );

export class PurchasesSettingsService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly accounting: AccountingService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async view(
    tx: Transaction,
    organizationId: string,
    settings: PurchasesSettings | undefined,
  ) {
    const sequences = settings ? await listPurchaseNumberSequences(tx, organizationId) : [];
    const fields: PurchasesSettingsFields = settings ?? DEFAULT_FIELDS;
    return {
      configured: settings !== undefined,
      version: settings?.version ?? 0,
      ...Object.fromEntries(FIELD_KEYS.map((k) => [k, fields[k]])),
      apLocked: Boolean(settings?.apLockedAt),
      // Before the first save, the single eligible payables account is proposed.
      suggestedApAccountId: settings ? null : await this.suggestApAccount(tx, organizationId),
      numbering: numberingView(purchaseDocumentTypes, sequences, DEFAULT_PURCHASE_NUMBERING),
    } as PurchasesSettingsFields & {
      configured: boolean;
      version: number;
      apLocked: boolean;
      suggestedApAccountId: string | null;
      numbering: Record<PurchaseDocumentType, NumberSequenceFields & { preview: string }>;
    };
  }

  private async suggestApAccount(tx: Transaction, organizationId: string) {
    const settings = await requireAccountingSettings(tx, organizationId);
    const candidates = (await listAccounts(tx, organizationId)).filter(
      (a) =>
        a.status === 'ACTIVE' &&
        a.isLeaf &&
        a.accountType === 'LIABILITY' &&
        a.subtype === 'ACCOUNTS_PAYABLE' &&
        a.currencyCode === settings.baseCurrency &&
        a.controlSubledger === null &&
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
      return this.view(tx, ctx.organizationId, await getPurchasesSettings(tx, ctx.organizationId));
    });
  }

  /** Validates the default accounts and tax code; AP is validated by accounting (4A-1). */
  private async fieldIssues(
    tx: Transaction,
    organizationId: string,
    input: PurchasesSettingsFields,
  ) {
    const issues: ValidationIssue[] = [];
    if (input.defaultExpenseAccountId) {
      const account = await getAccount(tx, organizationId, input.defaultExpenseAccountId);
      const problem = account
        ? purchaseAccountProblem({
            status: account.status,
            isLeaf: account.isLeaf,
            subtype: account.subtype,
            isControlAccount: account.isControlAccount,
            designated: (await designationsOfAccount(tx, organizationId, account.id)).length > 0,
          })
        : 'Account not found.';
      if (problem) issues.push({ path: 'defaultExpenseAccountId', message: problem });
    }
    if (input.defaultPaymentAccountId) {
      const path = 'defaultPaymentAccountId';
      const account = await getAccount(tx, organizationId, input.defaultPaymentAccountId);
      if (!account) issues.push({ path, message: 'Account not found.' });
      else if (account.status !== 'ACTIVE') {
        issues.push({ path, message: 'Choose an active account.' });
      } else if (!account.isLeaf) {
        issues.push({ path, message: 'Choose a posting (leaf) account.' });
      } else if (account.isControlAccount) {
        issues.push({ path, message: 'A control account cannot be used here.' });
      } else if (!isBankOrCash(account.subtype) && account.subtype !== 'CREDIT_CARD') {
        issues.push({
          path,
          message: 'Choose a bank, cash or credit card account (Decision 42, P4-26).',
        });
      }
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

  update(principal: Principal, input: PurchasesSettingsInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.SettingsManage, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const current = await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true });
        if ((current?.version ?? 0) !== input.version) throw versionConflict();
        const fields = Object.fromEntries(
          FIELD_KEYS.map((k) => [k, input[k]]),
        ) as PurchasesSettingsFields;
        const before: PurchasesSettingsFields = current ?? DEFAULT_FIELDS;

        const issues = await this.fieldIssues(tx, ctx.organizationId, fields);
        if (current?.apLockedAt && fields.apAccountId !== current.apAccountId) {
          issues.push({
            path: 'apAccountId',
            message:
              'The AP control account cannot change once Purchases documents have been posted.',
          });
        }
        const sequences = current
          ? await listPurchaseNumberSequences(tx, ctx.organizationId, { forUpdate: true })
          : [];
        const plan = planNumbering({
          types: purchaseDocumentTypes,
          existing: sequences,
          defaults: DEFAULT_PURCHASE_NUMBERING,
          wanted: input.numbering,
        });
        issues.push(...plan.issues);
        if (issues.length) throw new ValidationError(issues);

        // P4-08: claim the new AP account and release the previous one, atomically, through
        // accounting (classification, base currency, leaf, active, not owned by another
        // subledger, no postings from outside Purchases; audited there).
        if (fields.apAccountId !== before.apAccountId) {
          await this.accounting.setSubledgerControlInTransaction(
            tx,
            ctx,
            {
              subledger: 'purchases',
              accountId: fields.apAccountId,
              previousAccountId: before.apAccountId,
              path: 'apAccountId',
            },
            origin,
          );
        }

        const changed = FIELD_KEYS.filter((k) => fields[k] !== before[k]);
        const anyChange = changed.length > 0 || Object.keys(plan.changes).length > 0;

        let saved: PurchasesSettings | undefined;
        if (!current) {
          saved = await insertPurchasesSettings(tx, {
            organizationId: ctx.organizationId,
            fields,
            numbering: plan.numbering,
            userId: ctx.userId,
            now: this.now,
          });
          if (!saved) throw versionConflict();
        } else if (anyChange) {
          // Any change bumps the settings version, numbering included (no silent overwrites).
          saved = await updatePurchasesSettings(tx, {
            organizationId: ctx.organizationId,
            version: input.version,
            set: Object.fromEntries(changed.map((k) => [k, fields[k]])),
            userId: ctx.userId,
            now: this.now,
          });
          if (!saved) throw versionConflict();
          for (const type of Object.keys(plan.changes) as PurchaseDocumentType[]) {
            await updatePurchaseNumberSequence(tx, {
              organizationId: ctx.organizationId,
              documentType: type,
              set: plan.numbering[type],
              userId: ctx.userId,
              now: this.now,
            });
          }
        } else {
          saved = current;
        }

        if (!current || anyChange) {
          await recordAuditEvent(tx, {
            occurredAt: this.now,
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: current ? 'purchases_settings.updated' : 'purchases_settings.created',
            resourceType: 'purchases_settings',
            resourceId: ctx.organizationId,
            metadata: {
              changedFields: changed,
              before: Object.fromEntries(changed.map((k) => [k, before[k]])),
              after: Object.fromEntries(changed.map((k) => [k, fields[k]])),
              numbering: plan.changes,
            },
            origin,
          });
        }
        return this.view(tx, ctx.organizationId, saved);
      },
    );
  }
}
