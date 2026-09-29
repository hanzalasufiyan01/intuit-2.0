import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, setSessionStateErrorHandler } from '../services/api-client';
import type {
  ActiveOrganization,
  AnySession,
  PendingMfaSession,
  SessionState,
} from '../services/types';

export const SESSION_QUERY_KEY = ['session'] as const;

/** Loads the current session; a 401 means "signed out", not an error. */
async function fetchSession(): Promise<AnySession | null> {
  try {
    return await api.get<AnySession>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  organizationName: string;
}

export interface ChallengeInput {
  method: 'totp' | 'recovery_code';
  code: string;
  rememberDevice?: boolean;
}

interface AuthContextValue {
  /** `mfa_pending`: the password was accepted and a verification code is expected (S7-14). */
  status: 'loading' | 'authenticated' | 'mfa_pending' | 'anonymous';
  session: SessionState | null;
  pending: PendingMfaSession | null;
  activeOrganization: ActiveOrganization | null;
  login(input: { email: string; password: string }): Promise<AnySession>;
  completeChallenge(input: ChallengeInput): Promise<SessionState>;
  register(input: RegisterInput): Promise<SessionState>;
  logout(): Promise<void>;
  switchOrganization(organizationId: string): Promise<SessionState>;
  /** Replaces the cached session and drops all other cached data (a different user/org). */
  setSession(session: AnySession | null): void;
  /** Updates the same user's session view in place (e.g. after MFA setup or a step-up). */
  updateSession(session: SessionState): void;
  /** Reloads the session view (MFA state changed). */
  refreshSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: 60_000,
    retry: false,
  });
  const current = sessionQuery.data ?? null;
  const session = current?.authentication === 'complete' ? current : null;
  const pending = current?.authentication === 'mfa_required' ? current : null;

  useEffect(() => {
    setCsrfToken(current?.csrfToken ?? null);
  }, [current]);

  useEffect(() => {
    setSessionStateErrorHandler(() => {
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    });
    return () => setSessionStateErrorHandler(null);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const setSession = (next: AnySession | null) => {
      setCsrfToken(next?.csrfToken ?? null);
      // Organization-scoped data must never leak across users or organizations.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
    };
    return {
      status: sessionQuery.isPending
        ? 'loading'
        : session
          ? 'authenticated'
          : pending
            ? 'mfa_pending'
            : 'anonymous',
      session,
      pending,
      activeOrganization: session?.activeOrganization ?? null,
      setSession,
      updateSession(next) {
        setCsrfToken(next.csrfToken);
        queryClient.setQueryData(SESSION_QUERY_KEY, next);
      },
      async refreshSession() {
        await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      },
      async login(input) {
        const next = await api.post<AnySession>('/auth/login', input);
        setSession(next);
        return next;
      },
      async completeChallenge(input) {
        const next = await api.post<SessionState>('/auth/mfa/challenge', {
          method: input.method,
          code: input.code,
          rememberDevice: input.rememberDevice ?? false,
        });
        setSession(next);
        return next;
      },
      async register(input) {
        const next = await api.post<SessionState>('/auth/register', input);
        setSession(next);
        return next;
      },
      async logout() {
        try {
          await api.post('/auth/logout');
        } finally {
          setSession(null);
          queryClient.clear();
        }
      },
      async switchOrganization(organizationId) {
        const next = await api.put<SessionState>('/auth/session/organization', { organizationId });
        setSession(next);
        return next;
      },
    };
  }, [queryClient, session, pending, sessionQuery.isPending]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Mutation helper for forms: exposes pending state and the last ApiError. */
export function useApiMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  return useMutation<TResult, ApiError, TInput>({ mutationFn: fn });
}
