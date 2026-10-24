import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { MappedStatusBadge, statusText, type StatusEntry } from '../../shared/ui/StatusBadge';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Physical stock counts (FP-29 A5): start a count, enter what was counted, post the differences as
 * one stock adjustment. The server measures against the stock on hand at posting.
 */

interface Count {
  id: string;
  number: string;
  countDate: string;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  memo: string;
  adjustmentId: string | null;
  cancelReason: string | null;
  version: number;
  lines: {
    itemId: string;
    name: string | null;
    sku: string | null;
    expectedQuantity: string;
    countedQuantity: string | null;
    difference: string | null;
  }[];
}

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function CountsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const counts = useQuery({
    queryKey: ['inventory-counts', org],
    queryFn: () => api.get<Count[]>('/inventory/counts'),
  });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const start = useApiMutation(() =>
    api.post<Count>('/inventory/counts', {
      countDate: date,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
    }),
  );
  return (
    <>
      <PageHeader title={t('counts.title')} description={t('counts.description')} />
      <Card title={t('counts.start')}>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate(undefined, {
              onSuccess: (c) => {
                void queryClient.invalidateQueries({ queryKey: ['inventory-counts', org] });
                void navigate(`/inventory/counts/${c.id}`);
              },
            });
          }}
        >
          <TextField
            label={t('counts.date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextField
            label={t('counts.note')}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <Button type="submit" busy={start.isPending}>
            {t('counts.startAll')}
          </Button>
        </form>
        <ErrorAlert error={start.error} />
      </Card>
      <Card title={t('counts.list')}>
        {counts.isPending ? <Spinner /> : null}
        <ErrorAlert error={counts.error} />
        {counts.data ? (
          counts.data.length === 0 ? (
            <p className="muted">{t('counts.none')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('counts.number')}</th>
                  <th>{t('counts.dateColumn')}</th>
                  <th>{t('counts.items')}</th>
                  <th>{t('counts.status')}</th>
                </tr>
              </thead>
              <tbody>
                {counts.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/inventory/counts/${c.id}`}>{c.number}</Link>
                    </td>
                    <td>{c.countDate}</td>
                    <td>{c.lines.length}</td>
                    <td>
                      <CountStatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
    </>
  );
}

export function CountDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canAdjust = usePermission(Permission.InventoryAdjustmentsCreate);
  const count = useQuery({
    queryKey: ['inventory-count', org, id],
    queryFn: () => api.get<Count>(`/inventory/counts/${id}`),
  });
  const [entered, setEntered] = useState<Record<string, string>>({});
  // Shown inline when posting is attempted while counted quantities are still unsaved.
  const [saveFirst, setSaveFirst] = useState(false);
  const refresh = () => {
    setEntered({});
    setSaveFirst(false);
    void queryClient.invalidateQueries({ queryKey: ['inventory-count', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-counts', org] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-items', org] });
  };
  const save = useApiMutation(() =>
    api.put(`/inventory/counts/${id}/lines`, {
      lines: Object.entries(entered).map(([itemId, value]) => ({
        itemId,
        countedQuantity: value.trim() === '' ? null : value.trim(),
      })),
    }),
  );
  const post = useApiMutation(() =>
    api.post(`/inventory/counts/${id}/post`, { version: count.data?.version }),
  );
  const cancel = useApiMutation((reason: string) =>
    api.post(`/inventory/counts/${id}/cancel`, { version: count.data?.version, reason }),
  );
  const c = count.data;
  const draft = c?.status === 'DRAFT';
  return (
    <>
      <PageHeader
        title={c ? t('counts.titleNumber', { number: c.number }) : t('counts.titleBare')}
        description={c ? `${c.countDate} · ${statusText(t, COUNT_STATUS, c.status)}` : undefined}
      />
      {count.isPending ? <Spinner /> : null}
      <ErrorAlert error={count.error} />
      {c ? (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>{t('counts.item')}</th>
                <th className="num">{t('counts.expected')}</th>
                <th className="num">{t('counts.counted')}</th>
                <th className="num">{t('counts.difference')}</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.itemId}>
                  <td>{l.name ?? l.itemId}</td>
                  <td className="num">{l.expectedQuantity}</td>
                  <td className="num">
                    {draft ? (
                      <input
                        aria-label={t('counts.countedFor', { name: l.name ?? l.itemId })}
                        inputMode="decimal"
                        value={entered[l.itemId] ?? l.countedQuantity ?? ''}
                        onChange={(e) => {
                          setSaveFirst(false);
                          setEntered({ ...entered, [l.itemId]: e.target.value });
                        }}
                      />
                    ) : (
                      (l.countedQuantity ?? '—')
                    )}
                  </td>
                  <td className="num">{l.difference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.cancelReason ? (
            <Alert>{t('counts.cancelled', { reason: c.cancelReason })}</Alert>
          ) : null}
          {c.adjustmentId ? (
            <p>
              {t('counts.postedAs')}{' '}
              <Link to="/inventory/adjustments">{t('counts.postedLink')}</Link>.
            </p>
          ) : null}
          {draft ? (
            <div className="filters">
              <Button
                variant="secondary"
                busy={save.isPending}
                disabled={Object.keys(entered).length === 0}
                onClick={() => {
                  setSaveFirst(false);
                  save.mutate(undefined, { onSuccess: refresh });
                }}
              >
                {t('counts.save')}
              </Button>
              {canAdjust ? (
                <Button
                  busy={post.isPending}
                  onClick={() => {
                    if (Object.keys(entered).length > 0) {
                      setSaveFirst(true);
                      return;
                    }
                    setSaveFirst(false);
                    post.mutate(undefined, { onSuccess: refresh });
                  }}
                >
                  {t('counts.post')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => {
                  const reason = window.prompt(t('counts.whyCancel'));
                  if (reason?.trim()) cancel.mutate(reason.trim(), { onSuccess: refresh });
                }}
              >
                {t('counts.cancel')}
              </Button>
            </div>
          ) : null}
          {saveFirst ? <Alert>{t('counts.saveFirst')}</Alert> : null}
          <ErrorAlert error={save.error ?? post.error ?? cancel.error} />
        </Card>
      ) : null}
    </>
  );
}

/** Stock-count statuses: draft is neutral, posted is success, cancelled is danger. */
const COUNT_STATUS = {
  DRAFT: { key: 'counts.statusValue.DRAFT', tone: 'neutral' },
  POSTED: { key: 'counts.statusValue.POSTED', tone: 'success' },
  CANCELLED: { key: 'counts.statusValue.CANCELLED', tone: 'danger' },
} satisfies Record<'DRAFT' | 'POSTED' | 'CANCELLED', StatusEntry>;

export function CountStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={COUNT_STATUS} status={status} />;
}
