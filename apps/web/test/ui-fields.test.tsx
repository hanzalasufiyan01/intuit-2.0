import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CountrySelect } from '../src/features/parties/shared';
import { CheckboxField } from '../src/shared/ui/CheckboxField';
import { SelectField } from '../src/shared/ui/SelectField';
import { TextareaField } from '../src/shared/ui/TextareaField';
import { TextField } from '../src/shared/ui/TextField';

/** UI phase 3, batch B: SelectField, TextareaField and CheckboxField, and the forms that use them. */

describe('SelectField', () => {
  it('labels the select and keeps native option behaviour', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectField label="Status" defaultValue="active" onChange={(e) => onChange(e.target.value)}>
        <option value="active">Active</option>
        <option value="archived">Archived</option>
      </SelectField>,
    );
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('active');
    await user.selectOptions(select, 'archived');
    expect(onChange).toHaveBeenCalledWith('archived');
    expect(select.getAttribute('aria-invalid')).toBeNull();
    expect(select.getAttribute('aria-describedby')).toBeNull();
  });

  it('shows the hint, then replaces it with the error and marks the select invalid', () => {
    const { rerender } = render(
      <SelectField label="Currency" hint="Used on new invoices" defaultValue="">
        <option value="">Choose</option>
      </SelectField>,
    );
    const select = screen.getByLabelText('Currency');
    expect(select.getAttribute('aria-describedby')).toBe(
      screen.getByText('Used on new invoices').id,
    );
    rerender(
      <SelectField
        label="Currency"
        hint="Used on new invoices"
        error="Pick a currency"
        defaultValue=""
      >
        <option value="">Choose</option>
      </SelectField>,
    );
    expect(screen.queryByText('Used on new invoices')).toBeNull();
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('Pick a currency');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('passes disabled and required through, and lets a caller id win', () => {
    render(
      <SelectField label="Role" id="role-select" required disabled>
        <option>Owner</option>
      </SelectField>,
    );
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    expect(select.id).toBe('role-select');
    expect(select.required).toBe(true);
    expect(select.disabled).toBe(true);
  });
});

describe('TextareaField', () => {
  it('is a labelled native textarea whose attributes pass through', async () => {
    const user = userEvent.setup();
    function Memo() {
      const [value, setValue] = useState('');
      return (
        <TextareaField
          label="Memo"
          rows={4}
          maxLength={10}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }
    render(<Memo />);
    const box = screen.getByLabelText('Memo') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.rows).toBe(4);
    expect(box.required).toBe(true);
    await user.type(box, 'abcdefghijklmnop');
    expect(box.value).toBe('abcdefghij'); // native maxLength still applies
  });

  it('wires the hint and the error like TextField does', () => {
    const { rerender } = render(<TextareaField label="Notes" hint="Shown to the vendor" />);
    const box = screen.getByLabelText('Notes');
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText('Shown to the vendor').id);
    rerender(<TextareaField label="Notes" hint="Shown to the vendor" error="Too long" />);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('uses the same error markup as TextField', () => {
    render(
      <>
        <TextField label="A" error="bad" />
        <TextareaField label="B" error="bad" />
      </>,
    );
    const [a, b] = screen.getAllByRole('alert');
    expect(a!.className).toBe(b!.className);
    expect(a!.tagName).toBe(b!.tagName);
  });
});

describe('CheckboxField', () => {
  it('toggles from the label text and reports the checked state', async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [on, setOn] = useState(false);
      return (
        <CheckboxField
          label="Primary contact"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />
      );
    }
    render(<Toggle />);
    const box = screen.getByRole('checkbox', { name: 'Primary contact' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(screen.getByText('Primary contact'));
    expect(box.checked).toBe(true);
    await user.click(box);
    expect(box.checked).toBe(false);
  });

  it('keeps name, value, disabled and required native', () => {
    render(<CheckboxField label="Customer" name="roles" value="customer" disabled required />);
    const box = screen.getByRole('checkbox', { name: 'Customer' }) as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.name).toBe('roles');
    expect(box.value).toBe('customer');
    expect(box.disabled).toBe(true);
    expect(box.required).toBe(true);
  });

  it('describes the box by its hint, then by its error', () => {
    const { rerender } = render(<CheckboxField label="Default" hint="One per kind" />);
    const box = screen.getByRole('checkbox', { name: 'Default' });
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText('One per kind').id);
    rerender(<CheckboxField label="Default" hint="One per kind" error="Already set" />);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });
});

describe('CountrySelect (migrated to SelectField)', () => {
  const renderCountry = (error?: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { code: 'MV', name: 'Maldives', isActive: true },
                { code: 'XX', name: 'Retired Land', isActive: false },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CountrySelect id="c" label="Country" value="" onChange={onChange} error={error} />
      </QueryClientProvider>,
    );
    return onChange;
  };

  it('offers active countries, reports the selection and keeps the caller id', async () => {
    const user = userEvent.setup();
    const onChange = renderCountry();
    const select = (await screen.findByLabelText('Country')) as HTMLSelectElement;
    expect(select.id).toBe('c');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Maldives' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Retired Land' })).toBeNull();
    await user.selectOptions(select, 'MV');
    expect(onChange).toHaveBeenCalledWith('MV');
  });

  it('now ties its server error to the select', async () => {
    renderCountry('Country is required');
    const select = await screen.findByLabelText('Country');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });
});
