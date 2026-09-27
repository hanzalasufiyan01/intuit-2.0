import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';

/** Parses untrusted input with a Zod schema, mapping failures to the platform error format. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Shared field schemas. Password policy (length) is enforced by the auth service from config. */
export const fields = {
  email: z.email({ error: 'Enter a valid email address.' }).max(320).trim(),
  password: z.string().min(1, 'Password is required.').max(1024),
  displayName: z.string().trim().min(1, 'Name is required.').max(200),
  organizationName: z.string().trim().min(1, 'Organization name is required.').max(200),
  token: z.string().min(16).max(256),
  id: z.uuid({ error: 'Must be a valid identifier.' }),
};

export const idParams = (name: string) => z.object({ [name]: fields.id });
