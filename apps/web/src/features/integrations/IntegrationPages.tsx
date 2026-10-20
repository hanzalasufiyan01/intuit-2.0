import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT, type Translate } from '../../i18n/i18n';

/**
 * Public API integrations, tokens and webhook endpoints (ADR 0011). Administrators create an
 * integration with a fixed set of scopes, issue tokens for it and subscribe endpoints to events.
 * A token or signing secret is shown ONCE, in memory only: it is never stored in the browser,
 * never written to the query cache and cleared when dismissed. Every write asks for a recent
 * password (and second factor where the policy applies) through the shared prompt.
 */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function useOrgId() {
  return useAuth().activeOrganization?.id ?? 'none';
}

/** A secret shown once; leaves memory when dismissed. */
function SecretPanel({
  label,
  secret,
  onDismiss,
}: {
  label: string;
  secret: string;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <Card title={label}>
      <Alert>{t('integrations.integrationPages.copyThisNowItIs')}</Alert>
      <input
        aria-label={label}
        readOnly
        value={secret}
        onFocus={(e) => e.currentTarget.select()}
        style={{ width: '100%', fontFamily: 'monospace' }}
        autoComplete="off"
      />
      <div className="filters">
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(secret)}>
          {t('integrations.integrationPages.copy')}
        </Button>
        <Button onClick={onDismiss}>{t('integrations.integrationPages.iHaveStoredIt')}</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Integrations and tokens
// ---------------------------------------------------------------------------

interface Integration {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'disabled' | 'revoked';
  scopes: string[];
  responsible: { membershipId: string; displayName: string | null };
  version: number;
  disabledAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}
interface ScopeInfo {
  scope: string;
  description: string;
  write: boolean;
}
interface Token {
  id: string;
  name: string;
  prefix: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokeReason: string | null;
}

function TokensPanel({
  integration,
  canManage,
  showSecret,
}: {
  integration: Integration;
  canManage: boolean;
  showSecret: (label: string, secret: string) => void;
}) {
  const translate = useT();
  const org = useOrgId();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const tokens = useQuery({
    queryKey: ['api-tokens', org, integration.id],
    queryFn: () => api.get<Token[]>(`/api-integrations/${integration.id}/tokens`),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['api-tokens', org, integration.id] });
  const create = useApiMutation(() =>
    sensitive(() =>
      api.post<Token & { token: string }>(`/api-integrations/${integration.id}/tokens`, {
        name: name.trim(),
        expiresInDays: Number(days),
      }),
    ),
  );
  const rotate = useApiMutation((t: Token) =>
    sensitive(() =>
      api.post<Token & { token: string }>(`/api-tokens/${t.id}/rotate`, {
        name: `${t.name} (rotated)`.slice(0, 100),
        expiresInDays: Number(days),
      }),
    ),
  );
  const revoke = useApiMutation((t: Token) => {
    const reason = window.prompt(
      translate('integrations.integrationPages.whyIsTheTokenRevoked', { name: t.name }),
    );
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() => api.post(`/api-tokens/${t.id}/revoke`, { reason: reason.trim() }));
  });
  const usable = integration.status === 'active';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (result) => {
        setName('');
        showSecret(
          translate('integrations.integrationPages.newTokenFor', { name: integration.name }),
          result.token,
        );
        refresh();
      },
    });
  };
  return (
    <Card title={translate('integrations.integrationPages.tokensFor', { name: integration.name })}>
      {tokens.isPending ? <Spinner /> : null}
      <ErrorAlert error={tokens.error} />
      {tokens.data ? (
        tokens.data.length === 0 ? (
          <p className="muted">{translate('integrations.integrationPages.noTokensYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{translate('integrations.integrationPages.name')}</th>
                <th>{translate('integrations.integrationPages.prefix')}</th>
                <th>{translate('integrations.integrationPages.status')}</th>
                <th>{translate('integrations.integrationPages.expires')}</th>
                <th>{translate('integrations.integrationPages.lastUsed')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}</code>
                  </td>
                  <td>
                    {t.status}
                    {t.revokeReason ? ` (${t.revokeReason})` : ''}
                  </td>
                  <td>{when(t.expiresAt)}</td>
                  <td>{when(t.lastUsedAt)}</td>
                  <td>
                    {canManage && usable && t.status === 'active' ? (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            rotate.mutate(t, {
                              onSuccess: (result) => {
                                if (result)
                                  showSecret(
                                    translate('integrations.integrationPages.rotatedToken', {
                                      name: t.name,
                                    }),
                                    result.token,
                                  );
                                refresh();
                              },
                            })
                          }
                        >
                          {translate('integrations.integrationPages.rotate')}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => revoke.mutate(t, { onSuccess: refresh })}
                        >
                          {translate('integrations.integrationPages.revoke')}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      <ErrorAlert error={rotate.error ?? revoke.error} />
      {canManage && usable ? (
        <form className="filters" onSubmit={submit}>
          <TextField
            label={translate('integrations.integrationPages.tokenName')}
            value={name}
            required
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={translate('integrations.integrationPages.validForDays')}
            value={days}
            inputMode="numeric"
            onChange={(e) => setDays(e.target.value)}
          />
          <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
            {translate('integrations.integrationPages.createToken')}
          </Button>
        </form>
      ) : null}
      <ErrorAlert error={create.error} />
    </Card>
  );
}

export function IntegrationsPage() {
  const t = useT();
  const org = useOrgId();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.ApiTokensManage);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [chosen, setChosen] = useState<string[]>([]);
  const list = useQuery({
    queryKey: ['api-integrations', org],
    queryFn: () => api.get<Integration[]>('/api-integrations'),
  });
  const scopes = useQuery({
    queryKey: ['api-scopes', org],
    queryFn: () => api.get<ScopeInfo[]>('/api-integrations/scopes'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['api-integrations', org] });
  const create = useApiMutation(() =>
    sensitive(() =>
      api.post<Integration>('/api-integrations', {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        scopes: chosen,
      }),
    ),
  );
  const transition = useApiMutation(
    (input: { integration: Integration; action: 'disable' | 'enable' | 'revoke' }) => {
      const { integration, action } = input;
      if (action === 'revoke') {
        const reason = window.prompt(
          t('integrations.integrationPages.revokingIsPermanentAndRevokes', {
            name: integration.name,
          }),
        );
        if (!reason?.trim()) return Promise.resolve(null);
        return sensitive(() =>
          api.post(`/api-integrations/${integration.id}/revoke`, {
            version: integration.version,
            reason: reason.trim(),
          }),
        );
      }
      return sensitive(() =>
        api.post(`/api-integrations/${integration.id}/${action}`, { version: integration.version }),
      );
    },
  );
  const toggle = (scope: string) =>
    setChosen((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (created) => {
        setForm({ name: '', description: '' });
        setChosen([]);
        setSelected(created.id);
        refresh();
      },
    });
  };
  const current = list.data?.find((i) => i.id === selected) ?? null;
  return (
    <>
      <PageHeader
        title={t('integrations.integrationPages.apiIntegrations')}
        description={t('integrations.integrationPages.integrationsLetAnotherSystemRead')}
      />
      {secret ? (
        <SecretPanel label={secret.label} secret={secret.value} onDismiss={() => setSecret(null)} />
      ) : null}
      <Card title={t('integrations.integrationPages.integrations')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('integrations.integrationPages.noIntegrationsYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('integrations.integrationPages.name')}</th>
                  <th>{t('integrations.integrationPages.status')}</th>
                  <th>{t('integrations.integrationPages.responsible')}</th>
                  <th>{t('integrations.integrationPages.scopes')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>
                      {i.status}
                      {i.revokeReason ? ` (${i.revokeReason})` : ''}
                    </td>
                    <td>{i.responsible.displayName ?? '—'}</td>
                    <td>{i.scopes.length}</td>
                    <td>
                      <Button variant="ghost" onClick={() => setSelected(i.id)}>
                        {t('integrations.integrationPages.tokens')}
                      </Button>
                      {canManage && i.status === 'active' ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            transition.mutate(
                              { integration: i, action: 'disable' },
                              { onSuccess: refresh },
                            )
                          }
                        >
                          {t('integrations.integrationPages.disable')}
                        </Button>
                      ) : null}
                      {canManage && i.status === 'disabled' ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            transition.mutate(
                              { integration: i, action: 'enable' },
                              { onSuccess: refresh },
                            )
                          }
                        >
                          {t('integrations.integrationPages.enable')}
                        </Button>
                      ) : null}
                      {canManage && i.status !== 'revoked' ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            transition.mutate(
                              { integration: i, action: 'revoke' },
                              { onSuccess: refresh },
                            )
                          }
                        >
                          {t('integrations.integrationPages.revoke')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={transition.error} />
      </Card>
      {current ? (
        <TokensPanel
          integration={current}
          canManage={canManage}
          showSecret={(label, value) => setSecret({ label, value })}
        />
      ) : null}
      <Can permission={Permission.ApiTokensManage}>
        <Card title={t('integrations.integrationPages.newIntegration')}>
          <form className="form" onSubmit={submit} noValidate>
            <TextField
              label={t('integrations.integrationPages.name')}
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label={t('integrations.integrationPages.description')}
              value={form.description}
              maxLength={500}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <fieldset>
              <legend>{t('integrations.integrationPages.scopes')}</legend>
              {(scopes.data ?? []).map((s) => (
                <label key={s.scope} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(s.scope)}
                    onChange={() => toggle(s.scope)}
                  />{' '}
                  <code>{s.scope}</code>
                  {s.write ? t('integrations.integrationPages.write') : ''} — {s.description}
                </label>
              ))}
            </fieldset>
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={!form.name.trim() || chosen.length === 0}
            >
              {t('integrations.integrationPages.createIntegration')}
            </Button>
          </form>
        </Card>
      </Can>
    </>
  );
}

// ---------------------------------------------------------------------------
// Webhook endpoints and deliveries
// ---------------------------------------------------------------------------

interface Endpoint {
  id: string;
  name: string;
  url: string;
  integrationId: string;
  status: 'active' | 'disabled';
  payloadMode: 'thin' | 'full';
  eventTypes: string[];
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  disabledReason: string | null;
  pingVerifiedAt: string | null;
  secretOverlapUntil: string | null;
  version: number;
}
interface EventType {
  type: string;
  subscribable: boolean;
}
interface Delivery {
  id: string;
  endpointId: string;
  eventType: string;
  resource: { type: string; id: string };
  status: 'pending' | 'succeeded' | 'dead' | 'cancelled';
  attemptsMade: number;
  redeliveryCount: number;
  lastStatusCode: number | null;
  lastErrorClass: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface DeliveryDetail extends Delivery {
  attempts: {
    attemptNo: number;
    startedAt: string;
    durationMs: number | null;
    statusCode: number | null;
    errorClass: string | null;
    responseExcerpt: string | null;
  }[];
}

function health(e: Endpoint, t: Translate) {
  if (e.status === 'disabled') return t('integrations.integrationPages.healthDisabled');
  if (e.consecutiveFailures > 0) {
    return t('integrations.integrationPages.healthFailing', { count: e.consecutiveFailures });
  }
  return e.lastSuccessAt
    ? t('integrations.integrationPages.healthHealthy')
    : t('integrations.integrationPages.healthNone');
}

function DeliveryDetailCard({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const org = useOrgId();
  const detail = useQuery({
    queryKey: ['webhook-delivery', org, id],
    queryFn: () => api.get<DeliveryDetail>(`/webhooks/deliveries/${id}`),
  });
  return (
    <Card title={t('integrations.integrationPages.deliveryAttempts')}>
      {detail.isPending ? <Spinner /> : null}
      <ErrorAlert error={detail.error} />
      {detail.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('integrations.integrationPages.started')}</th>
              <th>{t('integrations.integrationPages.duration')}</th>
              <th>{t('integrations.integrationPages.status')}</th>
              <th>{t('integrations.integrationPages.error')}</th>
              <th>{t('integrations.integrationPages.response')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.data.attempts.map((a) => (
              <tr key={a.attemptNo}>
                <td>{a.attemptNo}</td>
                <td>{when(a.startedAt)}</td>
                <td>
                  {a.durationMs === null
                    ? '—'
                    : t('integrations.integrationPages.ms', { durationMs: a.durationMs })}
                </td>
                <td>{a.statusCode ?? '—'}</td>
                <td>{a.errorClass ?? '—'}</td>
                <td>{a.responseExcerpt ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Button variant="ghost" onClick={onClose}>
        {t('integrations.integrationPages.close')}
      </Button>
    </Card>
  );
}

export function WebhooksPage() {
  const translate = useT();
  const org = useOrgId();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.WebhooksManage);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [endpointFilter, setEndpointFilter] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    url: '',
    integrationId: '',
    payloadMode: 'thin',
  });
  const [events, setEvents] = useState<string[]>([]);
  const endpoints = useQuery({
    queryKey: ['webhook-endpoints', org],
    queryFn: () => api.get<Endpoint[]>('/webhooks/endpoints'),
  });
  const catalog = useQuery({
    queryKey: ['webhook-event-types', org],
    queryFn: () => api.get<EventType[]>('/webhooks/event-types'),
  });
  const integrations = useQuery({
    queryKey: ['api-integrations', org],
    enabled: canManage,
    queryFn: () => api.get<Integration[]>('/api-integrations'),
  });
  const query = new URLSearchParams();
  if (statusFilter) query.set('status', statusFilter);
  if (endpointFilter) query.set('endpointId', endpointFilter);
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', org, statusFilter, endpointFilter],
    queryFn: () => api.get<Delivery[]>(`/webhooks/deliveries?${query.toString()}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints', org] });
    void queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', org] });
  };
  const create = useApiMutation(() =>
    sensitive(() =>
      api.post<Endpoint & { secret: string }>('/webhooks/endpoints', {
        name: form.name.trim(),
        url: form.url.trim(),
        integrationId: form.integrationId,
        eventTypes: events,
        payloadMode: form.payloadMode,
      }),
    ),
  );
  const act = useApiMutation(
    (input: {
      endpoint: Endpoint;
      action: 'disable' | 'enable' | 'rotate-secret' | 'ping' | 'delete';
    }) => {
      const { endpoint, action } = input;
      if (action === 'delete') {
        if (
          !window.confirm(
            translate('integrations.integrationPages.deleteTheEndpointItsHistory', {
              name: endpoint.name,
            }),
          )
        ) {
          return Promise.resolve(null);
        }
        return sensitive(() =>
          api.delete<unknown>(`/webhooks/endpoints/${endpoint.id}?version=${endpoint.version}`),
        );
      }
      if (action === 'ping') {
        return sensitive(() => api.post(`/webhooks/endpoints/${endpoint.id}/ping`, {}));
      }
      return sensitive(() =>
        api.post<Endpoint & { secret?: string }>(`/webhooks/endpoints/${endpoint.id}/${action}`, {
          version: endpoint.version,
        }),
      );
    },
  );
  const redeliver = useApiMutation((d: Delivery) =>
    sensitive(() => api.post(`/webhooks/deliveries/${d.id}/redeliver`, {})),
  );
  const toggle = (type: string) =>
    setEvents((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type],
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (created) => {
        setSecret({
          label: translate('integrations.integrationPages.signingSecretFor', {
            name: created.name,
          }),
          value: created.secret,
        });
        setForm({ name: '', url: '', integrationId: '', payloadMode: 'thin' });
        setEvents([]);
        refresh();
      },
    });
  };
  const run = (
    endpoint: Endpoint,
    action: 'disable' | 'enable' | 'rotate-secret' | 'ping' | 'delete',
  ) =>
    act.mutate(
      { endpoint, action },
      {
        onSuccess: (result) => {
          if (action === 'rotate-secret' && result) {
            const value = (result as { secret?: string }).secret;
            if (value) {
              setSecret({
                label: translate('integrations.integrationPages.newSigningSecretFor', {
                  name: endpoint.name,
                }),
                value,
              });
            }
          }
          if (action === 'ping' && result) {
            setNotice(translate('integrations.integrationPages.pingSent', { name: endpoint.name }));
          }
          refresh();
        },
      },
    );
  return (
    <>
      <PageHeader
        title={translate('integrations.integrationPages.webhooks')}
        description={translate('integrations.integrationPages.sendSignedEventNotificationsTo')}
      />
      {secret ? (
        <SecretPanel label={secret.label} secret={secret.value} onDismiss={() => setSecret(null)} />
      ) : null}
      {notice ? <Alert>{notice}</Alert> : null}
      <Card title={translate('integrations.integrationPages.endpoints')}>
        {endpoints.isPending ? <Spinner /> : null}
        <ErrorAlert error={endpoints.error} />
        {endpoints.data ? (
          endpoints.data.length === 0 ? (
            <p className="muted">{translate('integrations.integrationPages.noEndpointsYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{translate('integrations.integrationPages.name')}</th>
                  <th>URL</th>
                  <th>{translate('integrations.integrationPages.health')}</th>
                  <th>{translate('integrations.integrationPages.lastSuccess')}</th>
                  <th>{translate('integrations.integrationPages.lastFailure')}</th>
                  <th>{translate('integrations.integrationPages.events')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {endpoints.data.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>
                      <code>{e.url}</code>
                    </td>
                    <td>
                      {health(e, translate)}
                      {e.disabledReason ? ` — ${e.disabledReason}` : ''}
                      {e.secretOverlapUntil ? (
                        <small>
                          {' '}
                          {translate('integrations.integrationPages.oldSecretValidUntil', {
                            value: when(e.secretOverlapUntil),
                          })}
                        </small>
                      ) : null}
                    </td>
                    <td>{when(e.lastSuccessAt)}</td>
                    <td>{when(e.lastFailureAt)}</td>
                    <td>{e.eventTypes.length}</td>
                    <td>
                      {canManage ? (
                        <>
                          {e.status === 'active' ? (
                            <>
                              <Button variant="ghost" onClick={() => run(e, 'ping')}>
                                {translate('integrations.integrationPages.sendTest')}
                              </Button>
                              <Button variant="ghost" onClick={() => run(e, 'disable')}>
                                {translate('integrations.integrationPages.disable')}
                              </Button>
                            </>
                          ) : (
                            <Button variant="ghost" onClick={() => run(e, 'enable')}>
                              {translate('integrations.integrationPages.enable')}
                            </Button>
                          )}
                          <Button variant="ghost" onClick={() => run(e, 'rotate-secret')}>
                            {translate('integrations.integrationPages.rotateSecret')}
                          </Button>
                          <Button variant="ghost" onClick={() => run(e, 'delete')}>
                            {translate('common.delete')}
                          </Button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={act.error} />
      </Card>
      <Card title={translate('integrations.integrationPages.deliveryHistory')}>
        <div className="filters">
          <div className="field">
            <label htmlFor="wh-status">{translate('integrations.integrationPages.status')}</label>
            <select
              id="wh-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">{translate('common.all')}</option>
              <option value="pending">{translate('integrations.integrationPages.pending')}</option>
              <option value="succeeded">
                {translate('integrations.integrationPages.succeeded')}
              </option>
              <option value="dead">
                {translate('integrations.integrationPages.failedRetriesExhausted')}
              </option>
              <option value="cancelled">
                {translate('integrations.integrationPages.cancelled')}
              </option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="wh-endpoint">
              {translate('integrations.integrationPages.endpoint')}
            </label>
            <select
              id="wh-endpoint"
              value={endpointFilter}
              onChange={(e) => setEndpointFilter(e.target.value)}
            >
              <option value="">{translate('common.all')}</option>
              {(endpoints.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {deliveries.isPending ? <Spinner /> : null}
        <ErrorAlert error={deliveries.error} />
        {deliveries.data ? (
          deliveries.data.length === 0 ? (
            <p className="muted">{translate('integrations.integrationPages.noDeliveries')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{translate('integrations.integrationPages.event')}</th>
                  <th>{translate('integrations.integrationPages.status')}</th>
                  <th className="num">{translate('integrations.integrationPages.attempts')}</th>
                  <th>{translate('integrations.integrationPages.response')}</th>
                  <th>{translate('integrations.integrationPages.created')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((d) => (
                  <tr key={d.id}>
                    <td>{d.eventType}</td>
                    <td>{d.status}</td>
                    <td className="num">
                      {d.attemptsMade}
                      {d.redeliveryCount
                        ? translate('integrations.integrationPages.redelivered', {
                            redeliveryCount: d.redeliveryCount,
                          })
                        : ''}
                    </td>
                    <td>{d.lastStatusCode ?? d.lastErrorClass ?? '—'}</td>
                    <td>{when(d.createdAt)}</td>
                    <td>
                      <Button variant="ghost" onClick={() => setDetailId(d.id)}>
                        {translate('integrations.integrationPages.attempts')}
                      </Button>
                      {canManage && d.status !== 'pending' && d.eventType !== 'webhook.ping' ? (
                        <Button
                          variant="ghost"
                          onClick={() => redeliver.mutate(d, { onSuccess: refresh })}
                        >
                          {translate('integrations.integrationPages.redeliver')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={redeliver.error} />
      </Card>
      {detailId ? <DeliveryDetailCard id={detailId} onClose={() => setDetailId(null)} /> : null}
      <Can permission={Permission.WebhooksManage}>
        <Card title={translate('integrations.integrationPages.newEndpoint')}>
          <form className="form" onSubmit={submit} noValidate>
            <TextField
              label={translate('integrations.integrationPages.name')}
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label={translate('integrations.integrationPages.urlHttps')}
              value={form.url}
              required
              maxLength={2048}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <div className="field">
              <label htmlFor="wh-integration">
                {translate('integrations.integrationPages.integration')}
              </label>
              <select
                id="wh-integration"
                value={form.integrationId}
                onChange={(e) => setForm({ ...form, integrationId: e.target.value })}
              >
                <option value="">{translate('common.choose')}</option>
                {(integrations.data ?? [])
                  .filter((i) => i.status === 'active')
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
              </select>
              <small className="field__hint">
                {translate('integrations.integrationPages.eventsAreLimitedToWhat')}
              </small>
            </div>
            <div className="field">
              <label htmlFor="wh-mode">{translate('integrations.integrationPages.payload')}</label>
              <select
                id="wh-mode"
                value={form.payloadMode}
                onChange={(e) => setForm({ ...form, payloadMode: e.target.value })}
              >
                <option value="thin">
                  {translate('integrations.integrationPages.thinIdentifiersOnly')}
                </option>
                <option value="full">{translate('integrations.integrationPages.full')}</option>
              </select>
            </div>
            <fieldset>
              <legend>{translate('integrations.integrationPages.events')}</legend>
              {(catalog.data ?? [])
                .filter((t) => t.subscribable)
                .map((t) => (
                  <label key={t.type} className="check">
                    <input
                      type="checkbox"
                      checked={events.includes(t.type)}
                      onChange={() => toggle(t.type)}
                    />{' '}
                    <code>{t.type}</code>
                  </label>
                ))}
            </fieldset>
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={
                !form.name.trim() || !form.url.trim() || !form.integrationId || !events.length
              }
            >
              {translate('integrations.integrationPages.createEndpoint')}
            </Button>
          </form>
        </Card>
      </Can>
    </>
  );
}
