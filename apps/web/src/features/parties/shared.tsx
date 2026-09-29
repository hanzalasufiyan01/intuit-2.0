import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api-client';
import type { Country } from './types';

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
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select country…</option>
        {(countries.data ?? [])
          .filter((c) => c.isActive || c.code === value)
          .map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
      </select>
      {error ? (
        <small className="field__error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

/** Blank inputs travel as null. */
export const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
