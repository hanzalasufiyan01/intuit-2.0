import { Link, useRouteError } from 'react-router';
import { useT } from '../i18n/i18n';
import { ErrorAlert } from '../shared/ui/Alert';

/** Top-level error boundary for routes. */
export function RouteError() {
  const error = useRouteError();
  const t = useT();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <ErrorAlert error={error instanceof Error ? error : new Error(t('error.generic'))} />
        <p>
          <Link to="/">{t('error.returnToApp')}</Link>
        </p>
      </div>
    </main>
  );
}
