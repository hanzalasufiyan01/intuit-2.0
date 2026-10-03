import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getAccount } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { CatalogPermissions } from '../modules/catalog/index.js';
import { BillPermissions, PurchasesPermissions } from '../modules/purchases/index.js';
import { SalesPermissions } from '../modules/sales/index.js';
import {
  deleteTaxCodeRate,
  getTaxCode,
  insertTaxCode,
  insertTaxCodeRate,
  listTaxCodeRates,
  listTaxCodes,
  TaxPermissions,
  updateTaxCode,
  type TaxCode,
  type TaxCodeRate,
} from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/** Anyone who picks or reviews tax on Sales documents may read tax codes. */
const TAX_VIEW_PERMISSIONS = [
  TaxPermissions.CodesManage,
  SalesPermissions.SettingsManage,
  SalesPermissions.ItemsManage,
  // ADR 0004 P4-06: the neutral catalog key (items carry sales and purchase tax codes).
  CatalogPermissions.ItemsManage,
  // ADR 0004 P4-07: choosing the Purchases default tax code.
  PurchasesPermissions.SettingsManage,
  // Phase 4A-5: choosing and reviewing tax on bills.
  BillPermissions.View,
  BillPermissions.Create,
  SalesPermissions.InvoicesView,
  SalesPermissions.InvoicesCreate,
  SalesPermissions.CreditNotesView,
] as const;

function rateView(rate: TaxCodeRate) {
  return {
    id: rate.id,
    rate: rate.rate,
    effectiveFrom: rate.effectiveFrom,
    verificationNote: rate.verificationNote,
    createdAt: rate.createdAt.toISOString(),
  };
}

function codeView(code: TaxCode, rates: readonly TaxCodeRate[]) {
  return {
    id: code.id,
    code: code.code,
    name: code.name,
    description: code.description,
    taxAccountId: code.taxAccountId,
    inputTaxAccountId: code.inputTaxAccountId,
    status: code.status,
    version: code.version,
    systemSeeded: code.createdByUserId === null,
    createdAt: code.createdAt.toISOString(),
    updatedAt: code.updatedAt.toISOString(),
    rates: rates.filter((r) => r.taxCodeId === code.id).map(rateView),
  };
}

const conflict = (message: string) => new ConflictError('CONFLICT', message);

export interface TaxCodeInput {
  code: string;
  name: string;
  description: string;
  taxAccountId: string;
  /** Optional input tax account for purchases (ADR 0004 P4-11). */
  inputTaxAccountId?: string | null | undefined;
  rate: string;
  effectiveFrom: string;
}

/**
 * Tax codes and their effective-dated rate versions (Decisions 15, 33, 60; Phase 3B D4).
 * Configuration changes need `tax.codes.manage` and a recent password confirmation (D12).
 */
export class TaxService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'tax_code',
      resourceId,
      metadata,
      origin,
    });
  }

  /** The tax account: an active leaf LIABILITY account in the base currency, not a control account. */
  private async assertTaxAccount(tx: Transaction, organizationId: string, accountId: string) {
    const settings = await requireAccountingSettings(tx, organizationId);
    const account = await getAccount(tx, organizationId, accountId);
    const invalid = (message: string) => new ValidationError([{ path: 'taxAccountId', message }]);
    if (!account) throw invalid('Account not found.');
    if (account.accountType !== 'LIABILITY') throw invalid('The tax account must be a liability.');
    if (account.status !== 'ACTIVE') throw invalid('The tax account must be active.');
    if (!account.isLeaf) throw invalid('The tax account must be a posting (leaf) account.');
    if (account.isControlAccount) throw invalid('A control account cannot be a tax account.');
    if (account.currencyCode !== settings.baseCurrency) {
      throw invalid('The tax account must be in the base currency.');
    }
  }

  /**
   * The input tax account (ADR 0004 P4-11; brief §12 "the account must be an asset"): an active
   * leaf ASSET account in the base currency, not a control account. Kept separate from the output
   * tax account rule, which is unchanged.
   */
  private async assertInputTaxAccount(tx: Transaction, organizationId: string, accountId: string) {
    const settings = await requireAccountingSettings(tx, organizationId);
    const account = await getAccount(tx, organizationId, accountId);
    const invalid = (message: string) =>
      new ValidationError([{ path: 'inputTaxAccountId', message }]);
    if (!account) throw invalid('Account not found.');
    if (account.accountType !== 'ASSET') throw invalid('The input tax account must be an asset.');
    if (account.status !== 'ACTIVE') throw invalid('The input tax account must be active.');
    if (!account.isLeaf) throw invalid('The input tax account must be a posting (leaf) account.');
    if (account.isControlAccount) {
      throw invalid('A control account cannot be an input tax account.');
    }
    if (account.currencyCode !== settings.baseCurrency) {
      throw invalid('The input tax account must be in the base currency.');
    }
  }

  private async requireCode(tx: Transaction, organizationId: string, id: string) {
    const code = await getTaxCode(tx, organizationId, id, { forUpdate: true });
    if (!code) throw new NotFoundError('Tax code not found.');
    return code;
  }

  private async view(tx: Transaction, organizationId: string, code: TaxCode) {
    return codeView(code, await listTaxCodeRates(tx, organizationId, [code.id]));
  }

  listCodes(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      if (!TAX_VIEW_PERMISSIONS.some((p) => hasPermission(ctx, p))) {
        throw new PermissionDeniedError();
      }
      await requireAccountingSettings(tx, ctx.organizationId);
      const codes = await listTaxCodes(tx, ctx.organizationId);
      const rates = await listTaxCodeRates(
        tx,
        ctx.organizationId,
        codes.map((c) => c.id),
      );
      return codes.map((c) => codeView(c, rates));
    });
  }

  createCode(principal: Principal, input: TaxCodeInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: TaxPermissions.CodesManage, sensitive: true },
      async (tx, ctx) => {
        await this.assertTaxAccount(tx, ctx.organizationId, input.taxAccountId);
        if (input.inputTaxAccountId) {
          await this.assertInputTaxAccount(tx, ctx.organizationId, input.inputTaxAccountId);
        }
        const code = await insertTaxCode(tx, {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name.trim(),
          description: input.description.trim(),
          taxAccountId: input.taxAccountId,
          inputTaxAccountId: input.inputTaxAccountId ?? null,
          userId: ctx.userId,
          now: this.now,
        });
        if (!code) throw conflict('A tax code with this code already exists.');
        await insertTaxCodeRate(tx, {
          organizationId: ctx.organizationId,
          taxCodeId: code.id,
          rate: input.rate,
          effectiveFrom: input.effectiveFrom,
          userId: ctx.userId,
          now: this.now,
        });
        await this.audit(
          tx,
          ctx,
          'tax_code.created',
          code.id,
          {
            code: code.code,
            name: code.name,
            taxAccountId: code.taxAccountId,
            inputTaxAccountId: code.inputTaxAccountId,
            rate: input.rate,
            effectiveFrom: input.effectiveFrom,
          },
          origin,
        );
        return this.view(tx, ctx.organizationId, code);
      },
    );
  }

  updateCode(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string;
      description?: string;
      taxAccountId?: string;
      /** null clears the mapping (purchases with the code are then blocked, P4-11). */
      inputTaxAccountId?: string | null;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: TaxPermissions.CodesManage, sensitive: true },
      async (tx, ctx) => {
        const code = await this.requireCode(tx, ctx.organizationId, id);
        const set: {
          name?: string;
          description?: string;
          taxAccountId?: string;
          inputTaxAccountId?: string | null;
        } = {};
        if (input.name !== undefined && input.name.trim() !== code.name)
          set.name = input.name.trim();
        if (input.description !== undefined && input.description.trim() !== code.description) {
          set.description = input.description.trim();
        }
        if (input.taxAccountId !== undefined && input.taxAccountId !== code.taxAccountId) {
          await this.assertTaxAccount(tx, ctx.organizationId, input.taxAccountId);
          set.taxAccountId = input.taxAccountId;
        }
        if (
          input.inputTaxAccountId !== undefined &&
          input.inputTaxAccountId !== code.inputTaxAccountId
        ) {
          if (input.inputTaxAccountId !== null) {
            await this.assertInputTaxAccount(tx, ctx.organizationId, input.inputTaxAccountId);
          }
          set.inputTaxAccountId = input.inputTaxAccountId;
        }
        if (Object.keys(set).length === 0) return this.view(tx, ctx.organizationId, code);
        const updated = await updateTaxCode(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set,
          userId: ctx.userId,
          now: this.now,
        });
        if (!updated) {
          throw new ConflictError('VERSION_CONFLICT', 'The tax code was changed by someone else.');
        }
        const before = Object.fromEntries(
          Object.keys(set).map((k) => [k, code[k as keyof typeof set]]),
        );
        await this.audit(tx, ctx, 'tax_code.updated', id, { before, after: set }, origin);
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  setStatus(
    principal: Principal,
    id: string,
    input: { version: number; status: 'ACTIVE' | 'ARCHIVED' },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: TaxPermissions.CodesManage, sensitive: true },
      async (tx, ctx) => {
        const code = await this.requireCode(tx, ctx.organizationId, id);
        if (code.status === input.status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            input.status === 'ARCHIVED'
              ? 'The tax code is already archived.'
              : 'The tax code is already active.',
          );
        }
        if (input.status === 'ACTIVE') {
          await this.assertTaxAccount(tx, ctx.organizationId, code.taxAccountId);
          if (code.inputTaxAccountId) {
            await this.assertInputTaxAccount(tx, ctx.organizationId, code.inputTaxAccountId);
          }
        }
        const updated = await updateTaxCode(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status: input.status },
          userId: ctx.userId,
          now: this.now,
        });
        if (!updated) {
          throw new ConflictError('VERSION_CONFLICT', 'The tax code was changed by someone else.');
        }
        await this.audit(
          tx,
          ctx,
          input.status === 'ARCHIVED' ? 'tax_code.archived' : 'tax_code.restored',
          id,
          { code: code.code },
          origin,
        );
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  /** Adds a rate version; a correction to a rate is a new version (Decision 15). */
  addRate(
    principal: Principal,
    id: string,
    input: { rate: string; effectiveFrom: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: TaxPermissions.CodesManage, sensitive: true },
      async (tx, ctx) => {
        const code = await this.requireCode(tx, ctx.organizationId, id);
        const rate = await insertTaxCodeRate(tx, {
          organizationId: ctx.organizationId,
          taxCodeId: id,
          rate: input.rate,
          effectiveFrom: input.effectiveFrom,
          userId: ctx.userId,
          now: this.now,
        });
        if (!rate) throw conflict('A rate version already starts on this date.');
        await this.audit(
          tx,
          ctx,
          'tax_code.rate_added',
          id,
          { code: code.code, rateId: rate.id, rate: rate.rate, effectiveFrom: rate.effectiveFrom },
          origin,
        );
        return this.view(tx, ctx.organizationId, code);
      },
    );
  }

  /**
   * Removes a rate version nothing references (documents that used it keep it through their
   * foreign key). The last version of a code cannot be removed.
   */
  deleteRate(principal: Principal, id: string, rateId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: TaxPermissions.CodesManage, sensitive: true },
      async (tx, ctx) => {
        const code = await this.requireCode(tx, ctx.organizationId, id);
        const rates = await listTaxCodeRates(tx, ctx.organizationId, [id]);
        if (!rates.some((r) => r.id === rateId)) throw new NotFoundError('Rate version not found.');
        if (rates.length === 1) throw conflict('A tax code keeps at least one rate version.');
        const removed = await deleteTaxCodeRate(tx, ctx.organizationId, id, rateId);
        if (!removed) throw new NotFoundError('Rate version not found.');
        await this.audit(
          tx,
          ctx,
          'tax_code.rate_removed',
          id,
          {
            code: code.code,
            rateId,
            rate: removed.rate,
            effectiveFrom: removed.effectiveFrom,
            verificationNote: removed.verificationNote,
          },
          origin,
        );
        return this.view(tx, ctx.organizationId, code);
      },
    );
  }
}
