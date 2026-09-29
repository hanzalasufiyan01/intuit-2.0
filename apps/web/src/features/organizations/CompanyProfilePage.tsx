import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { CountrySelect, orNull } from '../parties/shared';
import { LogoCard } from './LogoCard';
import type { OrganizationAddress, OrganizationProfile } from '../parties/types';

interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

const toDraft = (a: OrganizationAddress | null): AddressDraft => ({
  line1: a?.line1 ?? '',
  line2: a?.line2 ?? '',
  city: a?.city ?? '',
  region: a?.region ?? '',
  postalCode: a?.postalCode ?? '',
  countryCode: a?.countryCode ?? '',
});

const fromDraft = (a: AddressDraft) =>
  a.line1.trim() === '' && a.countryCode === ''
    ? null
    : {
        line1: a.line1.trim(),
        line2: orNull(a.line2),
        city: orNull(a.city),
        region: orNull(a.region),
        postalCode: orNull(a.postalCode),
        countryCode: a.countryCode,
      };

function AddressFields({
  prefix,
  title,
  value,
  onChange,
  disabled,
  fieldError,
}: {
  prefix: 'registeredAddress' | 'businessAddress';
  title: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  disabled: boolean;
  fieldError: (path: string) => string | undefined;
}) {
  const set = (k: keyof AddressDraft) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset className="fieldset" disabled={disabled}>
      <legend>{title}</legend>
      <div className="form form--inline">
        <TextField
          label={`${title} line 1`}
          value={value.line1}
          onChange={set('line1')}
          error={fieldError(`${prefix}.line1`)}
        />
        <TextField label={`${title} line 2`} value={value.line2} onChange={set('line2')} />
        <TextField label={`${title} city`} value={value.city} onChange={set('city')} />
        <TextField
          label={`${title} region / atoll`}
          value={value.region}
          onChange={set('region')}
        />
        <TextField
          label={`${title} postal code`}
          value={value.postalCode}
          onChange={set('postalCode')}
        />
        <CountrySelect
          id={`${prefix}-country`}
          label={`${title} country`}
          value={value.countryCode}
          onChange={(countryCode) => onChange({ ...value, countryCode })}
          error={fieldError(`${prefix}.countryCode`)}
        />
      </div>
    </fieldset>
  );
}

function ProfileForm({
  profile,
  onSaved,
}: {
  profile: OrganizationProfile;
  onSaved: (version: number) => void;
}) {
  const queryClient = useQueryClient();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const canEdit = usePermission(Permission.OrganizationUpdate);
  const sensitive = useSensitiveAction();
  const [form, setForm] = useState({
    legalName: profile.legalName ?? '',
    tradingName: profile.tradingName ?? '',
    tin: profile.tin ?? '',
    gstRegistered: profile.gstRegistered,
    gstRegistrationNumber: profile.gstRegistrationNumber ?? '',
    gstRegisteredFrom: profile.gstRegisteredFrom ?? '',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    website: profile.website ?? '',
  });
  const [identifiers, setIdentifiers] = useState(profile.identifiers);
  const [registered, setRegistered] = useState(toDraft(profile.registeredAddress));
  const [business, setBusiness] = useState(toDraft(profile.businessAddress));

  // TIN/GST changes need a recent password confirmation (S4-12); the dialog handles it.
  const save = useApiMutation(() =>
    sensitive(() =>
      api.put<OrganizationProfile>('/organizations/current/profile', {
        version: profile.version,
        legalName: form.legalName.trim(),
        tradingName: orNull(form.tradingName),
        tin: orNull(form.tin),
        gstRegistered: form.gstRegistered,
        gstRegistrationNumber: orNull(form.gstRegistrationNumber),
        gstRegisteredFrom: orNull(form.gstRegisteredFrom),
        email: orNull(form.email),
        phone: orNull(form.phone),
        website: orNull(form.website),
        identifiers: identifiers.filter((i) => i.scheme && i.value),
        registeredAddress: fromDraft(registered),
        businessAddress: fromDraft(business),
      }),
    ),
  );
  const fieldError = (path: string) => save.error?.fieldError(path);
  const text = (key: keyof typeof form, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={String(form[key])}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      error={fieldError(key)}
      disabled={!canEdit}
      {...extra}
    />
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: (next) => {
        // The form remounts on the new version, so the confirmation lives in the page.
        onSaved(next.version);
        queryClient.setQueryData(['organization-profile', org], next);
      },
    });
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      {!canEdit ? (
        <Alert tone="info">You can view the company profile but not change it.</Alert>
      ) : null}
      <Card title="Legal identity">
        <div className="form form--inline">
          {text('legalName', 'Legal name')}
          {text('tradingName', 'Trading name')}
        </div>
      </Card>
      <Card title="Tax registration">
        <div className="form form--inline">
          {text('tin', 'TIN')}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.gstRegistered}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, gstRegistered: e.target.checked })}
            />{' '}
            GST registered
          </label>
          {form.gstRegistered ? (
            <>
              {text('gstRegistrationNumber', 'GST registration number')}
              {text('gstRegisteredFrom', 'GST registered from', { type: 'date' })}
            </>
          ) : null}
        </div>
        <p className="muted">
          Changing the TIN or GST registration asks you to confirm your password.
        </p>
      </Card>
      <Card title="Addresses">
        <AddressFields
          prefix="registeredAddress"
          title="Registered address"
          value={registered}
          onChange={setRegistered}
          disabled={!canEdit}
          fieldError={fieldError}
        />
        <AddressFields
          prefix="businessAddress"
          title="Business address"
          value={business}
          onChange={setBusiness}
          disabled={!canEdit}
          fieldError={fieldError}
        />
      </Card>
      <Card title="Contact details">
        <div className="form form--inline">
          {text('email', 'Email', { type: 'email' })}
          {text('phone', 'Phone')}
          {text('website', 'Website')}
        </div>
      </Card>
      <Card title="Other identifiers">
        {identifiers.map((identifier, i) => (
          <div className="form form--inline" key={i}>
            <TextField
              label={`Identifier ${i + 1} scheme`}
              value={identifier.scheme}
              disabled={!canEdit}
              placeholder="e.g. business_registration"
              onChange={(e) =>
                setIdentifiers(
                  identifiers.map((x, j) => (j === i ? { ...x, scheme: e.target.value } : x)),
                )
              }
              error={fieldError(`identifiers.${i}.scheme`)}
            />
            <TextField
              label={`Identifier ${i + 1} value`}
              value={identifier.value}
              disabled={!canEdit}
              onChange={(e) =>
                setIdentifiers(
                  identifiers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                )
              }
            />
            {canEdit ? (
              <Button
                variant="ghost"
                onClick={() => setIdentifiers(identifiers.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {canEdit && identifiers.length < 20 ? (
          <Button
            variant="secondary"
            onClick={() => setIdentifiers([...identifiers, { scheme: '', value: '' }])}
          >
            Add identifier
          </Button>
        ) : null}
      </Card>
      {save.error?.code === 'VERSION_CONFLICT' ? (
        <Alert>{save.error.message}</Alert>
      ) : (
        <ErrorAlert error={save.error?.issues.length ? null : save.error} />
      )}
      {canEdit ? (
        <div className="actions">
          <Button type="submit" busy={save.isPending}>
            Save profile
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/** Organization legal profile (Decision 17; S4). */
export function CompanyProfilePage() {
  const org = useAuth().activeOrganization?.id ?? 'none';
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const profile = useQuery({
    queryKey: ['organization-profile', org],
    queryFn: () => api.get<OrganizationProfile>('/organizations/current/profile'),
  });
  return (
    <>
      <PageHeader
        title="Company profile"
        description="Legal identity, tax registration and addresses used on your documents."
      />
      {profile.isPending ? (
        <Spinner label="Loading company profile" />
      ) : profile.isError ? (
        <ErrorAlert error={profile.error} />
      ) : (
        <>
          {savedVersion !== null && savedVersion === profile.data.version ? (
            <Alert tone="success">Company profile saved.</Alert>
          ) : null}
          <LogoCard profile={profile.data} />
          <ProfileForm
            key={profile.data.version}
            profile={profile.data}
            onSaved={setSavedVersion}
          />
        </>
      )}
    </>
  );
}
