import { useId } from 'react';

/**
 * The ids and aria wiring shared by the form-field components: the control's id (a caller id wins),
 * the ids of its hint and error text, and the aria-describedby list (generated ids plus any the
 * caller passed). As in TextField, the hint is
 * replaced by the error while one is showing.
 */
export function useFieldIds(
  idOverride: string | undefined,
  {
    hint,
    error,
    describedBy: caller,
  }: { hint: string | undefined; error: string | undefined; describedBy?: string | undefined },
) {
  const generated = useId();
  const id = idOverride ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // The generated hint or error comes first; ids the caller passed are kept after them.
  const describedBy =
    [error ? errorId : null, hint && !error ? hintId : null, caller].filter(Boolean).join(' ') ||
    undefined;
  return { id, hintId, errorId, describedBy, invalid: error ? true : undefined };
}
