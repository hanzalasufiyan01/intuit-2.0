import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, type ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES, sumAmounts } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { requiredTypesFor, useAccountingSetup, useAccounts, useDimensions } from './shared';
import type { DimensionType, JournalDetail } from './types';

interface LineDraft {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
  /** Dimension type id -> value id. Line-level only (Decision 85). */
  dimensions?: Record<string, string>;
}

const emptyLine = (): LineDraft => ({
  accountId: '',
  description: '',
  debit: '',
  credit: '',
  dimensions: {},
});

/** Values offered for a line: active values, plus the value already assigned (even if archived). */
function valueOptions(type: DimensionType, current: string | undefined) {
  return type.values.filter((v) => v.status === 'ACTIVE' || v.id === current);
}

export interface JournalEditorProps {
  journal?: JournalDetail;
  onSaved?: (journal: JournalDetail) => void;
}

/** Totals for the editor, computed exactly with decimal.js. */
export function editorTotals(lines: readonly LineDraft[]) {
  const debit = sumAmounts(lines.map((l) => l.debit));
  const credit = sumAmounts(lines.map((l) => l.credit));
  return { debit, credit, balanced: debit.eq(credit) && debit.gt(0) };
}

/** Draft journal editor: drafts may be incomplete; posting validates the full double entry. */
export function JournalEditor({ journal, onSaved }: JournalEditorProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useAccountingSetup();
  const accounts = useAccounts();
  const canViewDimensions = usePermission(Permission.DimensionsView);
  const dimensions = useDimensions(canViewDimensions);
  const baseCurrency = setup.data?.settings?.baseCurrency ?? '';
  const [header, setHeader] = useState({
    entryDate: journal?.entryDate ?? '',
    description: journal?.description ?? '',
    reference: journal?.reference ?? '',
    currency: journal?.currency ?? baseCurrency ?? 'MVR',
    exchangeRate: journal?.exchangeRate ?? '',
  });
  const [lines, setLines] = useState<LineDraft[]>(
    journal?.lines.length
      ? journal.lines.map((l) => ({
          accountId: l.accountId ?? '',
          description: l.description,
          debit: l.debit ?? '',
          credit: l.credit ?? '',
          dimensions: Object.fromEntries(
            (l.dimensions ?? []).map((d) => [d.dimensionTypeId, d.dimensionValueId]),
          ),
        }))
      : [emptyLine(), emptyLine()],
  );
  // Types shown on lines: active types, plus any type a line already carries.
  const lineTypes = (dimensions.data ?? []).filter(
    (t) =>
      t.status === 'ACTIVE' ||
      lines.some((l) => l.dimensions?.[t.id] !== undefined && l.dimensions[t.id] !== ''),
  );
  const postable = (accounts.data ?? []).filter((a) => a.isLeaf && a.status === 'ACTIVE');
  const currency = header.currency || baseCurrency;
  const totals = editorTotals(lines);

  const save = useApiMutation<void, JournalDetail>(async () => {
    const body = {
      entryDate: header.entryDate || null,
      description: header.description,
      reference: header.reference,
      currency,
      exchangeRate:
        currency !== baseCurrency && header.exchangeRate ? header.exchangeRate.trim() : null,
      lines: lines.map((l) => ({
        accountId: l.accountId || null,
        description: l.description,
        debit: l.debit.trim() || null,
        credit: l.credit.trim() || null,
        // Without accounting.dimensions.view the field is omitted, so the server keeps the
        // line's existing assignments (Decision 91).
        ...(canViewDimensions
          ? {
              dimensions: Object.entries(l.dimensions ?? {})
                .filter(([, valueId]) => valueId)
                .map(([dimensionTypeId, dimensionValueId]) => ({
                  dimensionTypeId,
                  dimensionValueId,
                })),
            }
          : {}),
      })),
    };
    return journal
      ? api.patch<JournalDetail>(`/accounting/journals/${journal.id}`, body)
      : api.post<JournalDetail>('/accounting/journals', body);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: ['accounting-journals'] });
        if (onSaved) onSaved(saved);
        else void navigate(`/accounting/journals/${saved.id}`);
      },
    });
  };

  const update = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const lineError = (error: ApiError | null, index: number) =>
    error?.issues.find(
      (i) => i.path.startsWith(`lines.${index}`) && i.path !== `lines.${index}.dimensions`,
    )?.message;
  const dimensionError = (error: ApiError | null, index: number) =>
    error?.issues
      .filter((i) => i.path === `lines.${index}.dimensions`)
      .map((i) => i.message)
      .join(' ');

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form form--inline">
        <TextField
          label="Date"
          type="date"
          value={header.entryDate}
          onChange={(e) => setHeader({ ...header, entryDate: e.target.value })}
          error={save.error?.fieldError('entryDate')}
        />
        <TextField
          label="Currency"
          value={currency}
          list="journal-currencies"
          maxLength={3}
          onChange={(e) => setHeader({ ...header, currency: e.target.value.toUpperCase() })}
          error={save.error?.fieldError('currency')}
        />
        <datalist id="journal-currencies">
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {currency && currency !== baseCurrency ? (
          <TextField
            label={`Rate to ${baseCurrency}`}
            inputMode="decimal"
            value={header.exchangeRate}
            onChange={(e) => setHeader({ ...header, exchangeRate: e.target.value })}
            hint="Leave blank to use the rate table"
            error={save.error?.fieldError('exchangeRate')}
          />
        ) : null}
        <TextField
          label="Reference"
          value={header.reference}
          onChange={(e) => setHeader({ ...header, reference: e.target.value })}
        />
      </div>
      <TextField
        label="Description"
        value={header.description}
        onChange={(e) => setHeader({ ...header, description: e.target.value })}
      />

      <table className="table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Description</th>
            {lineTypes.length ? <th>Dimensions</th> : null}
            <th>Debit</th>
            <th>Credit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>
                <select
                  aria-label={`Line ${index + 1} account`}
                  value={line.accountId}
                  onChange={(e) => update(index, { accountId: e.target.value })}
                >
                  <option value="">Select account…</option>
                  {postable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
                {lineError(save.error, index) ? (
                  <small className="field__error">{lineError(save.error, index)}</small>
                ) : null}
              </td>
              <td>
                <input
                  aria-label={`Line ${index + 1} description`}
                  value={line.description}
                  onChange={(e) => update(index, { description: e.target.value })}
                />
              </td>
              {lineTypes.length ? (
                <td>
                  {lineTypes.map((type) => {
                    const required = requiredTypesFor(
                      postable.find((a) => a.id === line.accountId),
                      [type],
                    ).length;
                    const current = line.dimensions?.[type.id] ?? '';
                    return (
                      <select
                        key={type.id}
                        aria-label={`Line ${index + 1} ${type.name}`}
                        value={current}
                        onChange={(e) =>
                          update(index, {
                            dimensions: { ...line.dimensions, [type.id]: e.target.value },
                          })
                        }
                      >
                        <option value="">
                          {type.name}
                          {required ? ' (required)' : ''}: none
                        </option>
                        {valueOptions(type, current).map((v) => (
                          <option key={v.id} value={v.id}>
                            {type.name}: {v.name}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                  {dimensionError(save.error, index) ? (
                    <small className="field__error" role="alert">
                      {dimensionError(save.error, index)}
                    </small>
                  ) : null}
                </td>
              ) : null}
              <td>
                <input
                  aria-label={`Line ${index + 1} debit`}
                  inputMode="decimal"
                  value={line.debit}
                  disabled={line.credit !== ''}
                  onChange={(e) => update(index, { debit: e.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={`Line ${index + 1} credit`}
                  inputMode="decimal"
                  value={line.credit}
                  disabled={line.debit !== ''}
                  onChange={(e) => update(index, { credit: e.target.value })}
                />
              </td>
              <td>
                <Button
                  variant="ghost"
                  aria-label={`Remove line ${index + 1}`}
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={lineTypes.length ? 3 : 2}>
              <Button variant="secondary" onClick={() => setLines([...lines, emptyLine()])}>
                Add line
              </Button>
            </th>
            <th data-testid="total-debit">{totals.debit.toFixed()}</th>
            <th data-testid="total-credit">{totals.credit.toFixed()}</th>
            <th>
              <span className={totals.balanced ? 'badge badge--posted' : 'badge badge--closed'}>
                {totals.balanced ? 'Balanced' : 'Not balanced'}
              </span>
            </th>
          </tr>
        </tfoot>
      </table>
      <ErrorAlert error={save.error?.issues.length ? null : save.error} />
      {save.error?.issues.some((i) => i.path === 'lines') ? (
        <ErrorAlert
          error={
            new Error(
              save.error.issues
                .filter((i) => i.path === 'lines')
                .map((i) => i.message)
                .join(' '),
            )
          }
        />
      ) : null}
      <div className="actions">
        <Button type="submit" busy={save.isPending}>
          Save draft
        </Button>
      </div>
    </form>
  );
}
