import type { InputHTMLAttributes } from 'react';
import { FieldMessages } from './FieldMessages';
import { useFieldIds } from './field-ids';

interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

/**
 * A native checkbox with its label. The label wraps the input, so clicking the text toggles it,
 * and `checked`, `value`, `name`, `disabled` and `required` keep their native meaning.
 */
export function CheckboxField({
  label,
  error,
  hint,
  id: idOverride,
  'aria-describedby': describedByCaller,
  ...rest
}: CheckboxFieldProps) {
  const ids = useFieldIds(idOverride, { hint, error, describedBy: describedByCaller });
  return (
    <div className="checkbox-field">
      <label className="checkbox" htmlFor={ids.id}>
        <input
          {...rest}
          type="checkbox"
          id={ids.id}
          aria-invalid={ids.invalid}
          aria-describedby={ids.describedBy}
        />{' '}
        {label}
      </label>
      <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
    </div>
  );
}
