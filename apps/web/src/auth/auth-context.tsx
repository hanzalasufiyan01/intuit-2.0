import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken } from '../services/api-client';
import type { ActiveOrganization, SessionState } from '../services/types';

export const SESSION_QUERY_KEY = ['session'] as const;

/** Loads the current session; a 401 means "signed out", not an error. */
async function fetchSession(): Promise<SessionState | null> {
  try {
    return await api.get<SessionState>('/auth/session');
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

interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  session: SessionState | null;
  activeOrganization: ActiveOrganization | null;
  login(input: { email: string; password: string }): Promise<SessionState>;
  register(input: RegisterInput): Promise<SessionState>;
  logout(): Promise<void>;
  switchOrganization(organizationId: string): Promise<SessionState>;
  /** Replaces the cached session (e.g. after accepting an invitation). */
  setSession(session: SessionState | null): void;
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
  const session = sessionQuery.data ?? null;

  useEffect(() => {
    setCsrfToken(session?.csrfToken ?? null);
  }, [session]);

  const value = useMemo<AuthContextValue>(() => {
    const setSession = (next: SessionState | null) => {
      setCsrfToken(next?.csrfToken ?? null);
      // Organization-scoped data must never leak across users or organizations.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
    };
    return {
      status: sessionQuery.isPending ? 'loading' : session ? 'authenticated' : 'anonymous',
      session,
      activeOrganization: session?.activeOrganization ?? null,
      setSession,
      async login(input) {
        const next = await api.post<SessionState>('/auth/login', input);
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
  }, [queryClient, session, sessionQuery.isPending]);

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
