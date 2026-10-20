import type { MessageKey } from './i18n';

/**
 * Dhivehi (Thaana, right-to-left) message catalog: INTENTIONALLY EMPTY.
 *
 * No machine or guessed translation is shipped for a financial application. A qualified Dhivehi
 * translator adds entries here (same keys as `messages.en.ts`, same `{placeholders}`), and a
 * reviewer then sets `status: 'approved'` for `dv` in `i18n.tsx`. Until then the locale is not
 * offered, and any key without a translation falls back to English.
 *
 * Open items (docs/design/localization.md): translator and reviewer, the approved accounting and
 * tax terminology (including MIRA terms, which must be confirmed from MIRA's own publications),
 * a Thaana-capable font, and the extraction of the UI strings that are still English literals.
 */
export const dv: Partial<Record<MessageKey, string>> = {};
