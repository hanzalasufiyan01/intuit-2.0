import type { ReactNode } from 'react';

/** What a badge means, not what colour it is: each tone maps to a theme token pair in styles.css. */
export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * The tone of a status string from a typed status-to-tone map. A status the map does not list (one the
 * server added before the UI knew it) gets the neutral tone, never a success or danger colour by accident.
 */
export function toneOf(map: Readonly<Record<string, BadgeTone>>, status: string): BadgeTone {
  return Object.hasOwn(map, status) ? (map[status] ?? 'neutral') : 'neutral';
}

/**
 * A status badge. The caller picks the tone from a typed status-to-tone map, so a new status that
 * has no entry fails type-checking instead of silently rendering uncoloured. The leading dot comes
 * from the stylesheet, so the meaning never rests on colour alone.
 */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
