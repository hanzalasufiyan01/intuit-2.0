import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { AccountingPage, useAccountingSetup, useAccounts, useOrgKey } from './shared';
import { type Account, type Designation, type DesignationEntry } from './types';
import { useT } from '../../i18n/i18n';

/**
 * System account designations (Decisions 14, 64): the accounts that dependent features post to
 * or report through. Nothing is guessed: an undesignated entry stays empty until chosen.
 */
export function DesignationsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canEdit = usePermission(Permission.AccountingSetup);
  const accounts = useAccounts();
  const baseCurrency = useAccountingSetup().data?.settings?.baseCurrency;
  const designations = useQuery({
    queryKey: ['accounting-designations', org],
    queryFn: () => api.get<DesignationEntry[]>('/accounting/designations'),
  });
  const [changes, setChanges] = useState<Partial<Record<Designation, string | null>>>({});
  const save = useApiMutation(() =>
    api.put<DesignationEntry[]>('/accounting/designations', changes),
  );

  const eligible = (entry: DesignationEntry): Account[] =>
    (accounts.data ?? []).filter(
      (a) =>
        a.status === 'ACTIVE' &&
        a.isLeaf &&
        !a.isControlAccount &&
        entry.allowedTypes.includes(a.type) &&
        (!baseCurrency || a.currencyCode === baseCurrency),
    );
  const accountLabel = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : t('designations.none');
  };

  return (
    <>
      <PageHeader title={t('designations.title')} description={t('designations.description')} />
      <AccountingPage>
        <Card>
          {designations.isPending || accounts.isPending ? (
            <Spinner label={t('designations.loading')} />
          ) : designations.isError ? (
            <ErrorAlert error={designations.error} />
          ) : (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(undefined, {
                  onSuccess: () => {
                    setChanges({});
                    void queryClient.invalidateQueries({
                      queryKey: ['accounting-designations', org],
                    });
                  },
                });
              }}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('designations.designation')}</th>
                    <th>{t('designations.account')}</th>
                  </tr>
                </thead>
                <tbody>
                  {designations.data.map((entry) => {
                    const value =
                      changes[entry.designation] !== undefined
                        ? changes[entry.designation]
                        : entry.accountId;
                    const id = `designation-${entry.designation}`;
                    return (
                      <tr key={entry.designation}>
                        <td>
                          <label htmlFor={id}>{t(`designations.label.${entry.designation}`)}</label>
                        </td>
                        <td>
                          {canEdit ? (
                            <select
                              id={id}
                              value={value ?? ''}
                              onChange={(e) =>
                                setChanges({
                                  ...changes,
                                  [entry.designation]: e.target.value || null,
                                })
                              }
                            >
                              <option value="">{t('designations.none')}</option>
                              {eligible(entry).map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.code} {a.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span id={id}>{accountLabel(entry.accountId)}</span>
                          )}
                          {save.error?.fieldError(entry.designation) ? (
                            <small className="field__error" role="alert">
                              {save.error.fieldError(entry.designation)}
                            </small>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {designations.data.some((d) => d.accountId === null) ? (
                <Alert tone="info">{t('designations.unavailable')}</Alert>
              ) : null}
              {canEdit ? (
                <Button type="submit" busy={save.isPending} disabled={!Object.keys(changes).length}>
                  {t('designations.save')}
                </Button>
              ) : null}
              <ErrorAlert error={save.error?.issues.length ? null : save.error} />
            </form>
          )}
        </Card>
      </AccountingPage>
    </>
  );
}
