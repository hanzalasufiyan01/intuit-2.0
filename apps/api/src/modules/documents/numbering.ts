import type { ValidationIssue } from '../../domain/errors.js';

/**
 * Document numbering rules shared by Sales and Purchases (D3, R37; ADR 0004 P4-51). Pure.
 * A sequence has a prefix, a minimum digit count and the next number; numbers are assigned when a
 * document is issued, posted or recorded (never for drafts), only move forward, and are not
 * gapless. Each module keeps its own sequence table.
 */

export interface NumberSequenceFields {
  prefix: string;
  minDigits: number;
  nextNumber: number;
}

/** The number a sequence produces, e.g. INV-00042. */
export function formatDocumentNumber(
  sequence: Pick<NumberSequenceFields, 'prefix' | 'minDigits'>,
  n: number,
) {
  return `${sequence.prefix}${String(n).padStart(sequence.minDigits, '0')}`;
}

/** Each type's sequence with a preview of its next number (defaults before the first save). */
export function numberingView<T extends string>(
  types: readonly T[],
  sequences: readonly ({ documentType: string } & NumberSequenceFields)[],
  defaults: Record<T, NumberSequenceFields>,
): Record<T, NumberSequenceFields & { preview: string }> {
  return Object.fromEntries(
    types.map((type) => {
      const s = sequences.find((q) => q.documentType === type) ?? defaults[type];
      return [
        type,
        {
          prefix: s.prefix,
          minDigits: s.minDigits,
          nextNumber: s.nextNumber,
          preview: formatDocumentNumber(s, s.nextNumber),
        },
      ];
    }),
  ) as Record<T, NumberSequenceFields & { preview: string }>;
}

/**
 * The numbering a settings save asks for: every type's wanted sequence (the current one, or the
 * default before the first save, when not given), issues for a next number that would move
 * backwards, and the per-type before/after changes to audit.
 */
export function planNumbering<T extends string>(input: {
  types: readonly T[];
  existing: readonly ({ documentType: string } & NumberSequenceFields)[];
  defaults: Record<T, NumberSequenceFields>;
  wanted?: { [K in T]?: NumberSequenceFields | undefined } | undefined;
}): {
  numbering: Record<T, NumberSequenceFields>;
  issues: ValidationIssue[];
  changes: Record<string, { before: NumberSequenceFields; after: NumberSequenceFields }>;
} {
  const numbering = {} as Record<T, NumberSequenceFields>;
  const issues: ValidationIssue[] = [];
  const changes: Record<string, { before: NumberSequenceFields; after: NumberSequenceFields }> = {};
  for (const type of input.types) {
    const existing = input.existing.find((s) => s.documentType === type);
    const base = existing ?? input.defaults[type];
    const wanted = input.wanted?.[type] ?? base;
    if (existing && wanted.nextNumber < existing.nextNumber) {
      issues.push({
        path: `numbering.${type}.nextNumber`,
        message: `The next number cannot be lower than ${existing.nextNumber}.`,
      });
    }
    const after = {
      prefix: wanted.prefix,
      minDigits: wanted.minDigits,
      nextNumber: wanted.nextNumber,
    };
    numbering[type] = after;
    if (
      !existing ||
      existing.prefix !== after.prefix ||
      existing.minDigits !== after.minDigits ||
      existing.nextNumber !== after.nextNumber
    ) {
      changes[type] = {
        before: existing
          ? {
              prefix: existing.prefix,
              minDigits: existing.minDigits,
              nextNumber: existing.nextNumber,
            }
          : input.defaults[type],
        after,
      };
    }
  }
  return { numbering, issues, changes };
}
