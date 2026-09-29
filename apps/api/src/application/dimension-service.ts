import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  createDimensionType,
  createDimensionValue,
  getDimensionType,
  getDimensionValue,
  listDimensionTypes,
  findDimensionValueConflicts,
  listDimensionValues,
  setDimensionTypeStatus,
  setDimensionValueStatus,
  updateDimensionType,
  updateDimensionValue,
  type AccountSubtype,
  type AccountType,
  type DimensionStatus,
  type DimensionType,
  type DimensionTypeFields,
  type DimensionValue,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

export interface DimensionTypeInput {
  code: string;
  name: string;
  description: string;
  isRequired: boolean;
  scope: { accountTypes: AccountType[]; accountSubtypes: AccountSubtype[] };
}

function valueView(value: DimensionValue) {
  return {
    id: value.id,
    dimensionTypeId: value.dimensionTypeId,
    code: value.code,
    name: value.name,
    status: value.status,
    archivedAt: value.archivedAt?.toISOString() ?? null,
  };
}

function typeView(type: DimensionType, values: readonly DimensionValue[] = []) {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: type.description,
    isRequired: type.isRequired,
    scope: { accountTypes: type.scopeAccountTypes, accountSubtypes: type.scopeAccountSubtypes },
    status: type.status,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
    archivedAt: type.archivedAt?.toISOString() ?? null,
    values: values.filter((v) => v.dimensionTypeId === type.id).map(valueView),
  };
}

const unique = <T>(items: readonly T[]) => [...new Set(items)];
const conflict = (message: string) => new ConflictError('CONFLICT', message);

/**
 * Dimension configuration (Decisions 3, 16, 84): organization-defined dimension types with a
 * required/optional setting and an account-classification scope, and their values. Types and
 * values are archived, never deleted, so posted assignments always resolve.
 */
export class DimensionService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceType: 'accounting_dimension_type' | 'accounting_dimension_value',
    resourceId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  /** Rejects a code or case-insensitive name already used by another type. */
  private async assertTypeUnique(
    tx: Transaction,
    organizationId: string,
    fields: { code?: string | undefined; name?: string | undefined },
    exceptId?: string,
  ) {
    const others = (await listDimensionTypes(tx, organizationId)).filter((t) => t.id !== exceptId);
    if (fields.code !== undefined && others.some((t) => t.code === fields.code)) {
      throw conflict('A dimension type with this code already exists.');
    }
    const name = fields.name?.trim().toLowerCase();
    if (name !== undefined && others.some((t) => t.name.toLowerCase() === name)) {
      throw conflict('A dimension type with this name already exists.');
    }
  }

  private async assertValueUnique(
    tx: Transaction,
    organizationId: string,
    typeId: string,
    fields: { code?: string | undefined; name?: string | undefined },
    exceptId?: string,
  ) {
    const others = await findDimensionValueConflicts(tx, organizationId, typeId, fields, exceptId);
    if (fields.code !== undefined && others.some((v) => v.code === fields.code)) {
      throw conflict('A value with this code already exists for this dimension.');
    }
    const name = fields.name?.trim().toLowerCase();
    if (name !== undefined && others.some((v) => v.name.toLowerCase() === name)) {
      throw conflict('A value with this name already exists for this dimension.');
    }
  }

  private async requireType(tx: Transaction, organizationId: string, typeId: string) {
    const type = await getDimensionType(tx, organizationId, typeId, { forUpdate: true });
    if (!type) throw new NotFoundError('Dimension type not found.');
    return type;
  }

  listDimensions(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const [types, values] = await Promise.all([
          listDimensionTypes(tx, ctx.organizationId),
          listDimensionValues(tx, ctx.organizationId),
        ]);
        return types.map((t) => typeView(t, values));
      },
    );
  }

  createType(principal: Principal, input: DimensionTypeInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        await this.assertTypeUnique(tx, ctx.organizationId, input);
        const type = await createDimensionType(tx, {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          code: input.code,
          name: input.name.trim(),
          description: input.description.trim(),
          isRequired: input.isRequired,
          scopeAccountTypes: unique(input.scope.accountTypes),
          scopeAccountSubtypes: unique(input.scope.accountSubtypes),
        });
        await this.audit(
          tx,
          ctx,
          'dimension_type.created',
          'accounting_dimension_type',
          type.id,
          {
            code: type.code,
            name: type.name,
            isRequired: type.isRequired,
            scope: typeView(type).scope,
          },
          origin,
        );
        return typeView(type);
      },
    );
  }

  /**
   * Updates a type. Required/optional and scope changes affect posting from then on (Decision
   * 86: journals already submitted are revalidated at posting); they are audited as such.
   */
  updateType(
    principal: Principal,
    typeId: string,
    input: { [K in keyof DimensionTypeInput]?: DimensionTypeInput[K] | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const type = await this.requireType(tx, ctx.organizationId, typeId);
        const changes: Partial<DimensionTypeFields> = {};
        if (input.code !== undefined && input.code !== type.code) changes.code = input.code;
        if (input.name !== undefined && input.name.trim() !== type.name) {
          changes.name = input.name.trim();
        }
        if (input.description !== undefined && input.description.trim() !== type.description) {
          changes.description = input.description.trim();
        }
        if (input.isRequired !== undefined && input.isRequired !== type.isRequired) {
          changes.isRequired = input.isRequired;
        }
        if (input.scope) {
          const types = unique(input.scope.accountTypes);
          const subtypes = unique(input.scope.accountSubtypes);
          const same = (a: readonly string[], b: readonly string[]) =>
            a.length === b.length && a.every((x) => b.includes(x));
          if (!same(types, type.scopeAccountTypes)) changes.scopeAccountTypes = types;
          if (!same(subtypes, type.scopeAccountSubtypes)) changes.scopeAccountSubtypes = subtypes;
        }
        if (Object.keys(changes).length === 0) return this.viewType(tx, ctx.organizationId, type);
        await this.assertTypeUnique(
          tx,
          ctx.organizationId,
          { code: changes.code, name: changes.name },
          type.id,
        );
        const updated = (await updateDimensionType(tx, {
          organizationId: ctx.organizationId,
          id: type.id,
          changes,
          userId: ctx.userId,
        }))!;
        const before = Object.fromEntries(
          Object.keys(changes).map((k) => [k, type[k as keyof DimensionTypeFields]]),
        );
        await this.audit(
          tx,
          ctx,
          'dimension_type.updated',
          'accounting_dimension_type',
          type.id,
          {
            code: updated.code,
            before,
            after: changes,
            affectsPosting:
              'isRequired' in changes ||
              'scopeAccountTypes' in changes ||
              'scopeAccountSubtypes' in changes,
          },
          origin,
        );
        return this.viewType(tx, ctx.organizationId, updated);
      },
    );
  }

  private async viewType(tx: Transaction, organizationId: string, type: DimensionType) {
    return typeView(type, await listDimensionValues(tx, organizationId));
  }

  setTypeStatus(
    principal: Principal,
    typeId: string,
    status: DimensionStatus,
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const type = await this.requireType(tx, ctx.organizationId, typeId);
        if (type.status === status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `The dimension type is already ${status.toLowerCase()}.`,
          );
        }
        const updated = (await setDimensionTypeStatus(tx, {
          organizationId: ctx.organizationId,
          id: typeId,
          status,
          userId: ctx.userId,
          now: this.now,
        }))!;
        await this.audit(
          tx,
          ctx,
          status === 'ARCHIVED' ? 'dimension_type.archived' : 'dimension_type.restored',
          'accounting_dimension_type',
          typeId,
          // Archiving a required type stops its enforcement; restoring resumes it.
          {
            code: type.code,
            name: type.name,
            isRequired: type.isRequired,
            affectsPosting: type.isRequired,
          },
          origin,
        );
        return this.viewType(tx, ctx.organizationId, updated);
      },
    );
  }

  createValue(
    principal: Principal,
    typeId: string,
    input: { code: string; name: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) =>
        valueView(await this.createValueInTransaction(tx, ctx, typeId, input, origin)),
    );
  }

  /** S6 (L-7): creates a value inside the caller's transaction (same rules and audit). */
  async createValueInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    typeId: string,
    input: { code: string; name: string },
    origin: EventOrigin,
  ) {
    requirePermission(ctx, AccountingPermissions.DimensionsManage);
    await requireAccountingSettings(tx, ctx.organizationId);
    const type = await this.requireType(tx, ctx.organizationId, typeId);
    if (type.status !== 'ACTIVE') {
      throw new ValidationError([
        { path: 'dimensionTypeId', message: 'Values cannot be added to an archived dimension.' },
      ]);
    }
    await this.assertValueUnique(tx, ctx.organizationId, typeId, input);
    const value = await createDimensionValue(tx, {
      organizationId: ctx.organizationId,
      dimensionTypeId: typeId,
      code: input.code,
      name: input.name.trim(),
      userId: ctx.userId,
    });
    await this.audit(
      tx,
      ctx,
      'dimension_value.created',
      'accounting_dimension_value',
      value.id,
      { dimensionTypeId: typeId, typeCode: type.code, code: value.code, name: value.name },
      origin,
    );
    return value;
  }

  updateValue(
    principal: Principal,
    typeId: string,
    valueId: string,
    input: { code?: string | undefined; name?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const value = await getDimensionValue(tx, ctx.organizationId, typeId, valueId, {
          forUpdate: true,
        });
        if (!value) throw new NotFoundError('Dimension value not found.');
        const changes: { code?: string; name?: string } = {};
        if (input.code !== undefined && input.code !== value.code) changes.code = input.code;
        if (input.name !== undefined && input.name.trim() !== value.name) {
          changes.name = input.name.trim();
        }
        if (Object.keys(changes).length === 0) return valueView(value);
        await this.assertValueUnique(tx, ctx.organizationId, typeId, changes, valueId);
        const updated = (await updateDimensionValue(tx, {
          organizationId: ctx.organizationId,
          id: valueId,
          changes,
          userId: ctx.userId,
        }))!;
        await this.audit(
          tx,
          ctx,
          'dimension_value.updated',
          'accounting_dimension_value',
          valueId,
          {
            dimensionTypeId: typeId,
            before: Object.fromEntries(
              Object.keys(changes).map((k) => [k, value[k as 'code' | 'name']]),
            ),
            after: changes,
          },
          origin,
        );
        return valueView(updated);
      },
    );
  }

  setValueStatus(
    principal: Principal,
    typeId: string,
    valueId: string,
    status: DimensionStatus,
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.DimensionsManage },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const value = await getDimensionValue(tx, ctx.organizationId, typeId, valueId, {
          forUpdate: true,
        });
        if (!value) throw new NotFoundError('Dimension value not found.');
        if (value.status === status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `The dimension value is already ${status.toLowerCase()}.`,
          );
        }
        const updated = (await setDimensionValueStatus(tx, {
          organizationId: ctx.organizationId,
          id: valueId,
          status,
          userId: ctx.userId,
          now: this.now,
        }))!;
        await this.audit(
          tx,
          ctx,
          status === 'ARCHIVED' ? 'dimension_value.archived' : 'dimension_value.restored',
          'accounting_dimension_value',
          valueId,
          { dimensionTypeId: typeId, code: value.code, name: value.name },
          origin,
        );
        return valueView(updated);
      },
    );
  }
}
