/** The hint and error text under a form field; ids come from useFieldIds. */
export function FieldMessages({
  hint,
  error,
  hintId,
  errorId,
}: {
  hint: string | undefined;
  error: string | undefined;
  hintId: string;
  errorId: string;
}) {
  return (
    <>
      {hint && !error ? (
        <small id={hintId} className="field__hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errorId} className="field__error" role="alert">
          {error}
        </small>
      ) : null}
    </>
  );
}
