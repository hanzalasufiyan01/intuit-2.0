import { useMemo } from 'react';
import { useAuth } from '../../auth/auth-context';
import { useModules } from '../payroll/PayrollPages';
import type { Access } from './tutorials';

/**
 * What the signed-in member can use, for deciding which tutorials and steps apply. A convenience
 * for the reader only: the pages and the server enforce access themselves.
 */
export function useHelpAccess(): Access {
  const { activeOrganization } = useAuth();
  const modules = useModules().data?.modules ?? null;
  const permissions = activeOrganization?.permissions;
  return useMemo(() => ({ permissions: permissions ?? [], modules }), [permissions, modules]);
}
