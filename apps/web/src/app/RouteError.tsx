import { Link, useRouteError } from 'react-router';
import { ErrorAlert } from '../shared/ui/Alert';

/** Top-level error boundary for routes. */
export function RouteError() {
  const error = useRouteError();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <ErrorAlert error={error instanceof Error ? error : new Error('Something went wrong.')} />
        <p>
          <Link to="/">Return to the app</Link>
        </p>
      </div>
    </main>
  );
}
