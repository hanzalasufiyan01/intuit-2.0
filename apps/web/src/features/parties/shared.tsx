import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api-client';
import type { Country } from './types';
import { useT } from '../../i18n/i18n';
import { SelectField } from '../../shared/ui/SelectField';

/** Country reference data (S4-05); cached for the session. */
export function useCountries() {
  return useQuery({
    queryKey: ['reference-countries'],
    queryFn: () => api.get<Country[]>('/reference/countries'),
    staleTime: Infinity,
  });
}

/**
 * Country select. Inactive countries are offered only when already selected (they may be kept
 * but not newly chosen).
 */
export function CountrySelect({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (code: string) => void;
  error?: string | undefined;
}) {
  const countries = useCountries();
  const t = useT();
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
    >
      <option value="">{t('parties.selectCountry')}</option>
      {(countries.data ?? [])
        .filter((c) => c.isActive || c.code === value)
        .map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
    </SelectField>
  );
}

/** Blank inputs travel as null. */
export const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
