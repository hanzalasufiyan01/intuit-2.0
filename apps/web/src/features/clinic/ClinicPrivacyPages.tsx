import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Clinic consent register and retention review (migration 0086, ADR 0013 addendum). The wording
 * and the retention period are the organization's own: the system supplies neither, applies no
 * default, and never removes a record on its own.
 */

interface ConsentView {
  current: {
    purpose: string;
    status: 'granted' | 'withdrawn';
    effectiveDate: string;
    wording: string;
  }[];
  history: {
    id: string;
    purpose: string;
    action: 'granted' | 'withdrawn';
    effectiveDate: string;
    recordedAt: string;
  }[];
}

export function ConsentCard({ patientId, active }: { patientId: string; active: boolean }) {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.ClinicPatientsManage);
  const consents = useQuery({
    queryKey: ['clinic-consents', org, patientId],
    queryFn: () => api.get<ConsentView>(`/clinic/patients/${patientId}/consents`),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [form, setForm] = useState({ purpose: '', wording: '' });
  const record = useApiMutation(
    (body: { purpose: string; wording?: string; action: 'granted' | 'withdrawn' }) =>
      api.post(`/clinic/patients/${patientId}/consents`, body),
  );
  const done = {
    onSuccess: () => {
      setForm({ purpose: '', wording: '' });
      void queryClient.invalidateQueries({ queryKey: ['clinic-consents', org, patientId] });
    },
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    record.mutate(
      { purpose: form.purpose.trim(), wording: form.wording.trim(), action: 'granted' },
      done,
    );
  };
  return (
    <Card title={t('clinic.clinicPrivacyPages.consent')}>
      {consents.isPending ? <Spinner /> : null}
      <ErrorAlert error={consents.error} />
      {consents.data ? (
        consents.data.current.length === 0 ? (
          <p className="muted">{t('clinic.clinicPrivacyPages.noConsentIsOnFile')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinic.clinicPrivacyPages.purpose')}</th>
                <th>{t('clinic.clinicPrivacyPages.status')}</th>
                <th>{t('clinic.clinicPrivacyPages.since')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {consents.data.current.map((c) => (
                <tr key={c.purpose}>
                  <td>{c.purpose}</td>
                  <td>{c.status}</td>
                  <td>{c.effectiveDate}</td>
                  <td>
                    {canManage && active && c.status === 'granted' ? (
                      <Button
                        variant="ghost"
                        aria-label={t('clinic.clinicPrivacyPages.withdrawConsentFor', {
                          purpose: c.purpose,
                        })}
                        onClick={() =>
                          record.mutate({ purpose: c.purpose, action: 'withdrawn' }, done)
                        }
                      >
                        {t('clinic.clinicPrivacyPages.recordWithdrawal')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      {canManage && active ? (
        <form className="form" onSubmit={submit} noValidate>
          <TextField
            label={t('clinic.clinicPrivacyPages.purpose')}
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
          />
          <div className="field">
            <label htmlFor="consent-wording">
              {t('clinic.clinicPrivacyPages.consentWordingShownToThe')}
            </label>
            <textarea
              id="consent-wording"
              rows={3}
              value={form.wording}
              onChange={(e) => setForm({ ...form, wording: e.target.value })}
            />
            <small className="field__hint">
              {t('clinic.clinicPrivacyPages.enterYourOrganizationSOwn')}
            </small>
          </div>
          <ErrorAlert error={record.error} />
          <Button
            type="submit"
            busy={record.isPending}
            disabled={!form.purpose.trim() || !form.wording.trim()}
          >
            {t('clinic.clinicPrivacyPages.recordConsent')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

interface Settings {
  retentionYears: number | null;
  version: number;
}
interface Review {
  retentionYears: number | null;
  cutoff: string | null;
  items: { id: string; number: string; displayName: string; lastActivity: string }[];
}

export function ClinicPrivacyPage() {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['clinic-settings', org],
    queryFn: () => api.get<Settings>('/clinic/settings'),
  });
  const review = useQuery({
    queryKey: ['clinic-retention', org],
    queryFn: () => api.get<Review>('/clinic/retention-review'),
    refetchOnWindowFocus: false,
  });
  const [years, setYears] = useState<string | null>(null);
  const shown = years ?? settings.data?.retentionYears?.toString() ?? '';
  const save = useApiMutation((body: Settings) => api.put('/clinic/settings', body));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!settings.data) return;
    save.mutate(
      {
        retentionYears: shown.trim() ? Number(shown) : null,
        version: settings.data.version,
      },
      {
        onSuccess: () => {
          setYears(null);
          void queryClient.invalidateQueries({ queryKey: ['clinic-settings', org] });
          void queryClient.invalidateQueries({ queryKey: ['clinic-retention', org] });
        },
      },
    );
  };
  return (
    <>
      <PageHeader
        title={t('clinic.clinicPrivacyPages.privacyAndRetention')}
        description={t('clinic.clinicPrivacyPages.setHowLongYourOrganization')}
      />
      <Card title={t('clinic.clinicPrivacyPages.retentionPeriod')}>
        {settings.isPending ? <Spinner /> : null}
        <ErrorAlert error={settings.error} />
        <form className="form" onSubmit={submit} noValidate>
          <TextField
            label={t('clinic.clinicPrivacyPages.keepPatientRecordsForYears')}
            value={shown}
            inputMode="numeric"
            onChange={(e) => setYears(e.target.value)}
          />
          <small className="field__hint">
            {t('clinic.clinicPrivacyPages.enterThePeriodRequiredBy')}
          </small>
          <ErrorAlert error={save.error} />
          <Button type="submit" busy={save.isPending} disabled={!settings.data}>
            {t('clinic.clinicPrivacyPages.saveRetentionPeriod')}
          </Button>
        </form>
      </Card>
      <Card title={t('clinic.clinicPrivacyPages.patientsPastTheRetentionPeriod')}>
        {review.isPending ? <Spinner /> : null}
        <ErrorAlert error={review.error} />
        {review.data && review.data.retentionYears === null ? (
          <Alert tone="info">{t('clinic.clinicPrivacyPages.noRetentionPeriodIsSet')}</Alert>
        ) : null}
        {review.data && review.data.retentionYears !== null ? (
          review.data.items.length === 0 ? (
            <p className="muted">
              {t('clinic.clinicPrivacyPages.noPatientHasBeenInactive', {
                cutoff: review.data.cutoff,
              })}
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinic.clinicPrivacyPages.number')}</th>
                  <th>{t('clinic.clinicPrivacyPages.name')}</th>
                  <th>{t('clinic.clinicPrivacyPages.lastActivity')}</th>
                </tr>
              </thead>
              <tbody>
                {review.data.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/clinic/patients/${i.id}`}>{i.number}</Link>
                    </td>
                    <td>{i.displayName}</td>
                    <td>{i.lastActivity.slice(0, 10)}</td>
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
