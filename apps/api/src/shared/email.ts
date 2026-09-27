/** Canonical form used for uniqueness and lookups. The original casing is kept for display. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
