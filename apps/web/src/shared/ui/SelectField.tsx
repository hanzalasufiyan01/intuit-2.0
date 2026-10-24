import type { SelectHTMLAttributes } from 'react';
import { FieldMessages } from './FieldMessages';
import { useFieldIds } from './field-ids';

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

/** A labelled native select. Options are passed as children, so option behaviour stays native. */
export function SelectField({
  label,
  error,
  hint,
  id: idOverride,
  'aria-describedby': describedByCaller,
  children,
  ...rest
}: SelectFieldProps) {
  const ids = useFieldIds(idOverride, { hint, error, describedBy: describedByCaller });
  return (
    <div className="field">
      <label htmlFor={ids.id}>{label}</label>
      <select {...rest} id={ids.id} aria-invalid={ids.invalid} aria-describedby={ids.describedBy}>
        {children}
      </select>
      <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
    </div>
  );
}
