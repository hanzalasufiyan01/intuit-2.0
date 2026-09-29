import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { RuleIssue } from './rules.js';
import {
  accountingDimensionTypes,
  accountingDimensionValues,
  accountingJournalLineDimensions,
  type AccountSubtype,
  type AccountType,
  type DimensionStatus,
} from './schema.js';

/**
 * Generic dimension framework (Decisions 3, 16): organization-defined types, their values and
 * journal-line assignments. No dimension type is hard-coded.
 */
export type DimensionType = typeof accountingDimensionTypes.$inferSelect;
export type DimensionValue = typeof accountingDimensionValues.$inferSelect;

export interface DimensionAssignmentInput {
  dimensionTypeId: string;
  dimensionValueId: string;
}

export interface LineDimension extends DimensionAssignmentInput {
  journalLineId: string;
  typeCode: string;
  typeName: string;
  valueCode: string;
  valueName: string;
}

// ---------------------------------------------------------------------------
// Pure applicability rules (Decisions 55, 67, 78, 84)
// ---------------------------------------------------------------------------

export interface RequirementFacts {
  id: string;
  name: string;
  status: DimensionStatus;
  isRequired: boolean;
  scopeAccountTypes: readonly AccountType[];
  scopeAccountSubtypes: readonly AccountSubtype[];
}

/**
 * The required dimension types that apply to a line posting to an account: active required
 * types whose account-classification scope contains the account's nature or subtype. An empty
 * scope enforces nothing.
 */
export function requiredTypesForAccount(
  account: { accountType: AccountType; subtype: AccountSubtype | null },
  types: readonly RequirementFacts[],
): RequirementFacts[] {
  return types.filter(
    (t) =>
      t.status === 'ACTIVE' &&
      t.isRequired &&
      (t.scopeAccountTypes.includes(account.accountType) ||
        (account.subtype !== null && t.scopeAccountSubtypes.includes(account.subtype))),
  );
}

/** Issues for manual-journal lines missing a required dimension. Never assigns anything. */
export function missingRequiredDimensions(
  lines: readonly {
    index: number;
    accountId: string | null;
    dimensionTypeIds: ReadonlySet<string>;
  }[],
  accounts: ReadonlyMap<string, { accountType: AccountType; subtype: AccountSubtype | null }>,
  types: readonly RequirementFacts[],
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const line of lines) {
    const account = line.accountId ? accounts.get(line.accountId) : undefined;
    if (!account) continue;
    for (const type of requiredTypesForAccount(account, types)) {
      if (!line.dimensionTypeIds.has(type.id)) {
        issues.push({
          path: `lines.${line.index}.dimensions`,
          message: `${type.name} is required for this account.`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export async function listDimensionTypes(
  tx: Transaction,
  organizationId: string,
): Promise<DimensionType[]> {
  return tx
    .select()
    .from(accountingDimensionTypes)
    .where(eq(accountingDimensionTypes.organizationId, organizationId))
    .orderBy(asc(accountingDimensionTypes.code));
}

export async function getDimensionType(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<DimensionType | undefined> {
  const query = tx
    .select()
    .from(accountingDimensionTypes)
    .where(
      and(
        eq(accountingDimensionTypes.organizationId, organizationId),
        eq(accountingDimensionTypes.id, id),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export type DimensionTypeFields = Pick<
  DimensionType,
  'code' | 'name' | 'description' | 'isRequired' | 'scopeAccountTypes' | 'scopeAccountSubtypes'
>;

export async function createDimensionType(
  tx: Transaction,
  input: DimensionTypeFields & { organizationId: string; userId: string },
): Promise<DimensionType> {
  const [row] = await tx
    .insert(accountingDimensionTypes)
    .values({ ...input, createdByUserId: input.userId, updatedByUserId: input.userId })
    .returning();
  return row!;
}

export async function updateDimensionType(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    changes: Partial<DimensionTypeFields>;
    userId: string;
  },
): Promise<DimensionType | undefined> {
  const [row] = await tx
    .update(accountingDimensionTypes)
    .set({ ...input.changes, updatedByUserId: input.userId })
    .where(
      and(
        eq(accountingDimensionTypes.organizationId, input.organizationId),
        eq(accountingDimensionTypes.id, input.id),
      ),
    )
    .returning();
  return row;
}

export async function setDimensionTypeStatus(
  tx: Transaction,
  input: { organizationId: string; id: string; status: DimensionStatus; userId: string; now: Date },
): Promise<DimensionType | undefined> {
  const archived = input.status === 'ARCHIVED';
  const [row] = await tx
    .update(accountingDimensionTypes)
    .set({
      status: input.status,
      archivedAt: archived ? input.now : null,
      archivedByUserId: archived ? input.userId : null,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(accountingDimensionTypes.organizationId, input.organizationId),
        eq(accountingDimensionTypes.id, input.id),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export async function listDimensionValues(
  tx: Transaction,
  organizationId: string,
): Promise<DimensionValue[]> {
  return tx
    .select()
    .from(accountingDimensionValues)
    .where(eq(accountingDimensionValues.organizationId, organizationId))
    .orderBy(asc(accountingDimensionValues.code));
}

/**
 * Values of one type that already use a code or (case-insensitively) a name. Indexed lookup, so
 * bulk creation (S6 imports) does not scan every value of the organization per row.
 */
export async function findDimensionValueConflicts(
  tx: Transaction,
  organizationId: string,
  typeId: string,
  fields: { code?: string | undefined; name?: string | undefined },
  exceptId?: string,
): Promise<DimensionValue[]> {
  const name = fields.name?.trim().toLowerCase();
  const matches = [
    fields.code !== undefined ? eq(accountingDimensionValues.code, fields.code) : undefined,
    name !== undefined ? sql`lower(${accountingDimensionValues.name}) = ${name}` : undefined,
  ].filter((c) => c !== undefined);
  if (matches.length === 0) return [];
  return tx
    .select()
    .from(accountingDimensionValues)
    .where(
      and(
        eq(accountingDimensionValues.organizationId, organizationId),
        eq(accountingDimensionValues.dimensionTypeId, typeId),
        exceptId ? ne(accountingDimensionValues.id, exceptId) : undefined,
        or(...matches),
      ),
    );
}

export async function getDimensionValue(
  tx: Transaction,
  organizationId: string,
  typeId: string,
  valueId: string,
  options: { forUpdate?: boolean } = {},
): Promise<DimensionValue | undefined> {
  const query = tx
    .select()
    .from(accountingDimensionValues)
    .where(
      and(
        eq(accountingDimensionValues.organizationId, organizationId),
        eq(accountingDimensionValues.dimensionTypeId, typeId),
        eq(accountingDimensionValues.id, valueId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getDimensionValuesByIds(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, DimensionValue & { typeStatus: DimensionStatus }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ value: accountingDimensionValues, typeStatus: accountingDimensionTypes.status })
    .from(accountingDimensionValues)
    .innerJoin(
      accountingDimensionTypes,
      and(
        eq(accountingDimensionTypes.id, accountingDimensionValues.dimensionTypeId),
        eq(accountingDimensionTypes.organizationId, accountingDimensionValues.organizationId),
      ),
    )
    .where(
      and(
        eq(accountingDimensionValues.organizationId, organizationId),
        inArray(accountingDimensionValues.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.value.id, { ...r.value, typeStatus: r.typeStatus }]));
}

export async function createDimensionValue(
  tx: Transaction,
  input: {
    organizationId: string;
    dimensionTypeId: string;
    code: string;
    name: string;
    userId: string;
  },
): Promise<DimensionValue> {
  const [row] = await tx
    .insert(accountingDimensionValues)
    .values({
      organizationId: input.organizationId,
      dimensionTypeId: input.dimensionTypeId,
      code: input.code,
      name: input.name,
      createdByUserId: input.userId,
      updatedByUserId: input.userId,
    })
    .returning();
  return row!;
}

export async function updateDimensionValue(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    changes: Partial<Pick<DimensionValue, 'code' | 'name'>>;
    userId: string;
  },
): Promise<DimensionValue | undefined> {
  const [row] = await tx
    .update(accountingDimensionValues)
    .set({ ...input.changes, updatedByUserId: input.userId })
    .where(
      and(
        eq(accountingDimensionValues.organizationId, input.organizationId),
        eq(accountingDimensionValues.id, input.id),
      ),
    )
    .returning();
  return row;
}

export async function setDimensionValueStatus(
  tx: Transaction,
  input: { organizationId: string; id: string; status: DimensionStatus; userId: string; now: Date },
): Promise<DimensionValue | undefined> {
  const archived = input.status === 'ARCHIVED';
  const [row] = await tx
    .update(accountingDimensionValues)
    .set({
      status: input.status,
      archivedAt: archived ? input.now : null,
      archivedByUserId: archived ? input.userId : null,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(accountingDimensionValues.organizationId, input.organizationId),
        eq(accountingDimensionValues.id, input.id),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Journal-line assignments
// ---------------------------------------------------------------------------

export async function insertLineDimensions(
  tx: Transaction,
  organizationId: string,
  rows: readonly (DimensionAssignmentInput & { journalLineId: string })[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(accountingJournalLineDimensions)
    .values(rows.map((r) => ({ organizationId, ...r })));
}

export async function getLineDimensions(
  tx: Transaction,
  organizationId: string,
  lineIds: readonly string[],
): Promise<LineDimension[]> {
  if (lineIds.length === 0) return [];
  return tx
    .select({
      journalLineId: accountingJournalLineDimensions.journalLineId,
      dimensionTypeId: accountingJournalLineDimensions.dimensionTypeId,
      dimensionValueId: accountingJournalLineDimensions.dimensionValueId,
      typeCode: accountingDimensionTypes.code,
      typeName: accountingDimensionTypes.name,
      valueCode: accountingDimensionValues.code,
      valueName: accountingDimensionValues.name,
    })
    .from(accountingJournalLineDimensions)
    .innerJoin(
      accountingDimensionTypes,
      and(
        eq(accountingDimensionTypes.id, accountingJournalLineDimensions.dimensionTypeId),
        eq(accountingDimensionTypes.organizationId, accountingJournalLineDimensions.organizationId),
      ),
    )
    .innerJoin(
      accountingDimensionValues,
      and(
        eq(accountingDimensionValues.id, accountingJournalLineDimensions.dimensionValueId),
        eq(
          accountingDimensionValues.organizationId,
          accountingJournalLineDimensions.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(accountingJournalLineDimensions.organizationId, organizationId),
        inArray(accountingJournalLineDimensions.journalLineId, [...lineIds]),
      ),
    )
    .orderBy(asc(accountingDimensionTypes.code));
}
