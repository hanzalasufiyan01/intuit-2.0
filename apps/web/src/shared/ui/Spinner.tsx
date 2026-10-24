import { useT } from '../../i18n/i18n';

/** A loading indicator. The label defaults to the translated "Loading"; a trailing ellipsis is added once. */
export function Spinner({ label }: { label?: string }) {
  const t = useT();
  const text = label ?? t('state.loading');
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__dot" aria-hidden="true" />
      <span>{text.endsWith('…') ? text : `${text}…`}</span>
    </div>
  );
}
