import { useT } from '../../i18n/i18n';
import { Spinner } from './Spinner';

/** The loading state of a page or card: the shared Spinner with the translated default label. */
export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="state">
      <Spinner label={label ?? t('common.loading')} />
    </div>
  );
}
