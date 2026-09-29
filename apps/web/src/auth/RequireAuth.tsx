import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Spinner } from '../shared/ui/Spinner';
import { useAuth } from './auth-context';

/** Only same-app paths are allowed as post-login destinations (no open redirects). */
export function safeRedirectTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

/**
 * Protected route: redirects signed-out visitors to /login and a sign-in waiting for its
 * verification code to /login/verify, remembering where they were going.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner label="Loading your session" />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (status === 'mfa_pending') {
    return <Navigate to="/login/verify" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/** Public-only route (login, register): signed-in users continue to where they were going. */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner label="Loading your session" />;
  if (status === 'authenticated')
    return <Navigate to={safeRedirectTarget(location.state)} replace />;
  return <>{children}</>;
}

/** The verification step of sign-in: only for a sign-in that is waiting for its code. */
export function RequirePendingMfa({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner label="Loading your session" />;
  if (status === 'authenticated')
    return <Navigate to={safeRedirectTarget(location.state)} replace />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={location.state} />;
  return <>{children}</>;
}
