import type { ReactNode } from 'react';
import { ApiError } from '../../services/api-client';

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Displays an API error with its request id for support. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Alert>
      {message}
      {requestId ? <span className="alert__ref"> (reference {requestId})</span> : null}
    </Alert>
  );
}
