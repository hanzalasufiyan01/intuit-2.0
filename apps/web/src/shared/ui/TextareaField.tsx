import type { TextareaHTMLAttributes } from 'react';
import { FieldMessages } from './FieldMessages';
import { useFieldIds } from './field-ids';

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

/** A labelled native textarea. `rows`, `maxLength`, `required` and the rest pass straight through. */
export function TextareaField({
  label,
  error,
  hint,
  id: idOverride,
  'aria-describedby': describedByCaller,
  ...rest
}: TextareaFieldProps) {
  const ids = useFieldIds(idOverride, { hint, error, describedBy: describedByCaller });
  return (
    <div className="field">
      <label htmlFor={ids.id}>{label}</label>
      <textarea
        {...rest}
        id={ids.id}
        aria-invalid={ids.invalid}
        aria-describedby={ids.describedBy}
      />
      <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
    </div>
  );
}
