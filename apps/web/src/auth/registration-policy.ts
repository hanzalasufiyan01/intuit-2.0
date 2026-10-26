import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api-client';

export type RegistrationMode = 'open' | 'code' | 'closed';

/**
 * How the server lets people register (REGISTRATION_MODE). Only a convenience for the screens: the
 * server enforces the mode on every registration. While the answer is loading, or if it cannot be
 * read, the screens behave as for `open`, and the server still refuses what it must.
 */
export function useRegistrationMode(): RegistrationMode {
  const policy = useQuery({
    queryKey: ['registration-policy'],
    queryFn: () => api.get<{ mode: RegistrationMode }>('/auth/registration-policy'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return policy.data?.mode ?? 'open';
}
