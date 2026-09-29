import type { z } from 'zod';
import { AppError, ValidationError } from '../../domain/errors.js';
import { normalize, type RowMessage } from '../../modules/data-exchange/index.js';
import type { ImportField, RowOutcome } from './types.js';

export function field(
  key: string,
  label: string,
  options: { required?: boolean; description: string; example: string; synonyms?: string[] },
): ImportField {
  return {
    key,
    label,
    required: options.required ?? false,
    description: options.description,
    example: options.example,
    synonyms: options.synonyms ?? [],
  };
}

/** Zod issues as row messages. `fieldOf` maps a schema path to the import field key. */
export function zodMessages(
  error: z.ZodError,
  fieldOf: (path: string) => string | null,
): RowMessage[] {
  return error.issues.map((issue) =>
    normalize.rowError('INVALID_VALUE', fieldOf(issue.path.map(String).join('.')), issue.message),
  );
}

/** A service ValidationError (or other AppError) as row messages. */
export function appErrorMessages(
  error: unknown,
  fieldOf: (path: string) => string | null,
): RowMessage[] {
  if (error instanceof ValidationError) {
    return (error.details?.issues ?? [{ path: '', message: error.message }]).map((issue) =>
      normalize.rowError('INVALID_VALUE', fieldOf(issue.path), issue.message),
    );
  }
  if (error instanceof AppError) {
    return [normalize.rowError(error.code, null, error.message)];
  }
  throw error;
}

export function outcome(
  rowNumber: number,
  normalized: Record<string, unknown> | null,
  messages: RowMessage[],
  groupKey: string | null = null,
): RowOutcome {
  const hasError = messages.some((m) => m.severity === 'error');
  return { rowNumber, normalized: hasError ? null : normalized, messages, groupKey };
}

/** Collects normalization results, remembering failures as row messages. */
export class Collector {
  readonly messages: RowMessage[] = [];

  take<T>(result: normalize.Normalized<T>, fallback: T): T {
    if (result.ok) return result.value;
    this.messages.push(result.message);
    return fallback;
  }

  error(code: string, fieldKey: string | null, message: string) {
    this.messages.push(normalize.rowError(code, fieldKey, message));
  }

  warning(code: string, fieldKey: string | null, message: string) {
    this.messages.push(normalize.rowWarning(code, fieldKey, message));
  }

  require(value: string | null, fieldKey: string, label: string): string | null {
    if (value === null) this.error('REQUIRED', fieldKey, `${label} is required.`);
    return value;
  }

  get failed() {
    return this.messages.some((m) => m.severity === 'error');
  }
}
