import type { ReactNode } from 'react';

/**
 * What a list or table shows when there is nothing to list. It only states the situation: `message`
 * is already translated, and an optional `action` (for example a "New invoice" link the caller has
 * already permission-checked) sits below it. It never shows figures or placeholder records.
 */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="muted">{message}</p>
      {action}
    </div>
  );
}
