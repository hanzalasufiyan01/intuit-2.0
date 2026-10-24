import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBadge as AccountingStatusBadge } from '../src/features/accounting/shared';
import { AssetStatusBadge } from '../src/features/assets/AssetPages';
import {
  AccountStatusBadge,
  StatusBadge as BankTransactionStatusBadge,
} from '../src/features/banking/BankAccountPages';
import { StatusBadge as ClaimStatusBadge } from '../src/features/claims/ClaimPages';
import { StatusBadge as PurchaseOrderStatusBadge } from '../src/features/purchases/OrderPages';
import { StatusLabel as OpeningBatchStatusLabel } from '../src/features/accounting/OpeningBalancesPage';
import { StatusLabel as RevaluationRunStatusLabel } from '../src/features/accounting/RevaluationPages';
import { RuleStatusBadge, TransferStatusBadge } from '../src/features/banking/BankingPages';
import { ImportStatusBadge } from '../src/features/data-exchange/ImportsPage';
import { PostedVoidBadge } from '../src/features/inventory/InventoryPages';
import { StatusBadge as RefundStatusBadge } from '../src/features/sales/RefundPages';
import { toneOf } from '../src/shared/ui/Badge';
import { accountingStatusLabel } from '../src/features/accounting/shared';
import { AppointmentStatusBadge, PatientStatusBadge } from '../src/features/clinic/ClinicPages';
import { CountStatusBadge } from '../src/features/inventory/CountPages';
import {
  ProjectStatusBadge,
  TaskStatusBadge,
  TimeStatusBadge,
} from '../src/features/projects/ProjectPages';
import { QuoteStatusBadge, RecurringStatusBadge } from '../src/features/quotes/QuotePages';
import { OrderStatusBadge, ShareLinkStatusBadge } from '../src/features/sales/ExtraPages';
import { statusLabel } from '../src/features/sales/shared';
import { translate } from '../src/i18n/i18n';
import { statusText, type StatusMap } from '../src/shared/ui/StatusBadge';

/**
 * The status badges that used to build their own `badge badge--<status>` class names: each status shows
 * the tone and translated label it should, and a status the page does not know is neutral and shown as
 * it came, never success or danger by accident.
 */

function badge(element: ReactElement) {
  const { container } = render(element);
  const span = container.querySelector('span.badge');
  if (!span) throw new Error('no badge rendered');
  const tone = [...span.classList].find((c) => c.startsWith('badge--'))?.slice('badge--'.length);
  return { tone, text: span.textContent };
}

describe('toneOf', () => {
  it('returns the mapped tone and neutral for anything the map does not list', () => {
    const map = { POSTED: 'success', VOID: 'danger' } as const;
    expect(toneOf(map, 'POSTED')).toBe('success');
    expect(toneOf(map, 'VOID')).toBe('danger');
    expect(toneOf(map, 'SOMETHING_NEW')).toBe('neutral');
    expect(toneOf(map, '')).toBe('neutral');
  });

  it('does not read inherited object properties as statuses', () => {
    const map = { POSTED: 'success' } as const;
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(toneOf(map, inherited)).toBe('neutral');
    }
  });
});

describe('accounting status badge', () => {
  it.each([
    ['DRAFT', 'neutral', 'Draft'],
    ['PENDING_APPROVAL', 'warning', 'Pending approval'],
    ['POSTED', 'success', 'Posted'],
    ['REVERSED', 'danger', 'Reversed'],
    ['DISCARDED', 'neutral', 'Discarded'],
    ['OPEN', 'success', 'Open'],
    ['CLOSED', 'neutral', 'Closed'],
    ['ACTIVE', 'success', 'Active'],
    ['ARCHIVED', 'neutral', 'Archived'],
  ] as const)('%s is %s and reads "%s"', (status, tone, text) => {
    expect(badge(<AccountingStatusBadge status={status} />)).toEqual({ tone, text });
  });

  it('shows an unknown status as it came, in the neutral tone', () => {
    const unknown = 'ON_HOLD' as never;
    expect(badge(<AccountingStatusBadge status={unknown} />)).toEqual({
      tone: 'neutral',
      text: 'ON_HOLD',
    });
  });
});

describe('fixed asset status badge', () => {
  it('maps in use to success and disposed to danger', () => {
    expect(badge(<AssetStatusBadge status="ACTIVE" />)).toEqual({
      tone: 'success',
      text: 'In use',
    });
    expect(badge(<AssetStatusBadge status="DISPOSED" />)).toEqual({
      tone: 'danger',
      text: 'Disposed',
    });
  });

  it('does not turn a status it does not know into disposed', () => {
    expect(badge(<AssetStatusBadge status="IMPAIRED" />)).toEqual({
      tone: 'neutral',
      text: 'IMPAIRED',
    });
  });
});

describe('banking status badges', () => {
  it('translates the bank account and rule statuses instead of showing the raw value', () => {
    expect(badge(<AccountStatusBadge status="ACTIVE" />)).toEqual({
      tone: 'success',
      text: 'Active',
    });
    expect(badge(<AccountStatusBadge status="ARCHIVED" />)).toEqual({
      tone: 'neutral',
      text: 'Archived',
    });
    expect(badge(<RuleStatusBadge status="ACTIVE" />)).toEqual({ tone: 'success', text: 'Active' });
    expect(badge(<RuleStatusBadge status="ARCHIVED" />)).toEqual({
      tone: 'neutral',
      text: 'Archived',
    });
  });

  it('maps a transfer to posted success or void danger, and anything else to neutral', () => {
    expect(badge(<TransferStatusBadge status="POSTED" />)).toEqual({
      tone: 'success',
      text: 'Posted',
    });
    expect(badge(<TransferStatusBadge status="VOID" />)).toEqual({ tone: 'danger', text: 'Void' });
    expect(badge(<TransferStatusBadge status="HELD" />)).toEqual({ tone: 'neutral', text: 'HELD' });
    expect(badge(<AccountStatusBadge status="SUSPENDED" />)).toEqual({
      tone: 'neutral',
      text: 'SUSPENDED',
    });
    expect(badge(<RuleStatusBadge status="PAUSED" />)).toEqual({ tone: 'neutral', text: 'PAUSED' });
  });
});

describe('inventory and sales refund status badges', () => {
  it('maps posted to success and void to danger', () => {
    expect(badge(<PostedVoidBadge status="POSTED" />)).toEqual({ tone: 'success', text: 'Posted' });
    expect(badge(<PostedVoidBadge status="VOID" />)).toEqual({ tone: 'danger', text: 'Void' });
  });

  it('maps a recorded refund to success and a void refund to danger', () => {
    expect(badge(<RefundStatusBadge status="RECORDED" />)).toEqual({
      tone: 'success',
      text: 'Recorded',
    });
    expect(badge(<RefundStatusBadge status="VOID" />)).toEqual({ tone: 'danger', text: 'Void' });
  });

  it('never shows an unknown status as success or danger', () => {
    expect(badge(<PostedVoidBadge status="DISCARDED" />)).toEqual({
      tone: 'neutral',
      text: 'DISCARDED',
    });
    expect(badge(<RefundStatusBadge status="PENDING" />)).toEqual({
      tone: 'neutral',
      text: 'PENDING',
    });
  });
});

describe('import status badge', () => {
  it.each([
    ['awaiting_file', 'neutral', 'Waiting for file'],
    ['ready', 'info', 'Ready to map'],
    ['validating', 'info', 'Validating'],
    ['validated', 'success', 'Ready to review'],
    ['failed_file', 'danger', 'File rejected'],
    ['committing', 'info', 'Importing'],
    ['committed', 'success', 'Imported'],
    ['needs_review', 'warning', 'Needs review'],
    ['cancelled', 'neutral', 'Cancelled'],
    ['expired', 'neutral', 'Expired'],
  ] as const)('%s is %s and reads "%s"', (status, tone, text) => {
    expect(badge(<ImportStatusBadge status={status} />)).toEqual({ tone, text });
  });

  it('shows an unknown import status as it came, in the neutral tone', () => {
    expect(badge(<ImportStatusBadge status="rolled_back" />)).toEqual({
      tone: 'neutral',
      text: 'rolled_back',
    });
  });
});

/** The status vocabularies that used to print `status.toLowerCase()` in a plain cell. */
const en = (key: Parameters<typeof translate>[1]) => translate('en', key);

describe('status vocabularies shown in table cells', () => {
  type Row = readonly [string, string, string];
  const vocabularies: Array<[string, (status: string) => ReactElement, Row[]]> = [
    [
      'quote',
      (status) => <QuoteStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['SENT', 'info', 'Sent'],
        ['ACCEPTED', 'success', 'Accepted'],
        ['DECLINED', 'danger', 'Declined'],
        ['EXPIRED', 'neutral', 'Expired'],
        ['CONVERTED', 'success', 'Converted'],
      ],
    ],
    [
      'recurring schedule',
      (status) => <RecurringStatusBadge status={status} />,
      [
        ['ACTIVE', 'success', 'Active'],
        ['PAUSED', 'warning', 'Paused'],
        ['ENDED', 'neutral', 'Ended'],
      ],
    ],
    [
      'project',
      (status) => <ProjectStatusBadge status={status} />,
      [
        ['PLANNED', 'info', 'Planned'],
        ['ACTIVE', 'success', 'Active'],
        ['ON_HOLD', 'warning', 'On hold'],
        ['COMPLETED', 'success', 'Completed'],
        ['CANCELLED', 'danger', 'Cancelled'],
      ],
    ],
    [
      'task',
      (status) => <TaskStatusBadge status={status} />,
      [
        ['OPEN', 'info', 'Open'],
        ['DONE', 'success', 'Done'],
      ],
    ],
    [
      'time entry',
      (status) => <TimeStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['SUBMITTED', 'warning', 'Submitted'],
        ['APPROVED', 'success', 'Approved'],
        ['REJECTED', 'danger', 'Rejected'],
        ['BILLED', 'success', 'Billed'],
      ],
    ],
    [
      'appointment',
      (status) => <AppointmentStatusBadge status={status} />,
      [
        ['BOOKED', 'info', 'Booked'],
        ['CHECKED_IN', 'warning', 'Checked in'],
        ['COMPLETED', 'success', 'Completed'],
        ['CANCELLED', 'danger', 'Cancelled'],
        ['NO_SHOW', 'danger', 'No-show'],
      ],
    ],
    [
      'patient',
      (status) => <PatientStatusBadge status={status} />,
      [
        ['ACTIVE', 'success', 'Active'],
        ['ANONYMIZED', 'neutral', 'Anonymized'],
      ],
    ],
    [
      'stock count',
      (status) => <CountStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['POSTED', 'success', 'Posted'],
        ['CANCELLED', 'danger', 'Cancelled'],
      ],
    ],
    [
      'sales order',
      (status) => <OrderStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['CONFIRMED', 'info', 'Confirmed'],
        ['PARTIALLY_INVOICED', 'warning', 'Partially invoiced'],
        ['INVOICED', 'success', 'Invoiced'],
        ['CANCELLED', 'danger', 'Cancelled'],
      ],
    ],
    [
      'invoice share link',
      (status) => <ShareLinkStatusBadge status={status} />,
      [
        ['active', 'success', 'Active'],
        ['expired', 'neutral', 'Expired'],
        ['revoked', 'danger', 'Revoked'],
      ],
    ],
  ];

  for (const [name, render_, rows] of vocabularies) {
    it.each(rows)(`${name}: %s is %s and reads "%s"`, (status, tone, text) => {
      expect(badge(render_(status))).toEqual({ tone, text });
    });

    it(`${name}: a status it does not know is neutral and shown as it came`, () => {
      expect(badge(render_('SOMETHING_NEW'))).toEqual({ tone: 'neutral', text: 'SOMETHING_NEW' });
      expect(badge(render_('constructor'))).toEqual({ tone: 'neutral', text: 'constructor' });
    });
  }
});

describe('status text in running text', () => {
  const t = (key: Parameters<typeof translate>[1]) => en(key);
  const map: StatusMap = { SENT: { key: 'quotes.quotePages.status.SENT', tone: 'info' } };

  it('translates a known status and shows an unknown one as it came', () => {
    expect(statusText(t, map, 'SENT')).toBe('Sent');
    expect(statusText(t, map, 'LOST')).toBe('LOST');
    expect(statusText(t, map, 'toString')).toBe('toString');
  });

  it('translates accounting statuses, including the period and account ones', () => {
    expect(accountingStatusLabel(t, 'POSTED')).toBe('Posted');
    expect(accountingStatusLabel(t, 'REVERSED')).toBe('Reversed');
    expect(accountingStatusLabel(t, 'OPEN')).toBe('Open');
    expect(accountingStatusLabel(t, 'HELD')).toBe('HELD');
  });

  it('translates the document statuses of a bill shown in a sentence', () => {
    expect(statusLabel(t, 'POSTED')).toBe('Posted');
    expect(statusLabel(t, 'PENDING_APPROVAL')).toBe('Pending approval');
    expect(statusLabel(t, 'VOID')).toBe('Void');
    expect(statusLabel(t, 'ON_FIRE')).toBe('ON_FIRE');
  });
});

/** Badges that looked their tone and label up by index: a status they did not list rendered an empty label. */
describe('status badges with a safe fallback for unknown statuses', () => {
  type Row = readonly [string, string, string];
  const vocabularies: Array<[string, (status: string) => ReactElement, Row[]]> = [
    [
      'expense claim',
      (status) => <ClaimStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['PENDING_APPROVAL', 'warning', 'Awaiting approval'],
        ['APPROVED', 'success', 'Approved'],
        ['POSTED', 'success', 'Posted'],
        ['CANCELLED', 'danger', 'Cancelled'],
        ['VOID', 'danger', 'Void'],
      ],
    ],
    [
      'purchase order',
      (status) => <PurchaseOrderStatusBadge status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['PENDING_APPROVAL', 'warning', 'Awaiting approval'],
        ['APPROVED', 'success', 'Approved'],
        ['PARTIALLY_RECEIVED', 'success', 'Partly received'],
        ['RECEIVED', 'success', 'Received'],
        ['CLOSED', 'danger', 'Closed'],
        ['CANCELLED', 'danger', 'Cancelled'],
      ],
    ],
    [
      'bank transaction',
      (status) => <BankTransactionStatusBadge status={status} />,
      [
        ['UNMATCHED', 'warning', 'Unmatched'],
        ['MATCHED', 'success', 'Matched'],
        ['EXCLUDED', 'neutral', 'Excluded'],
      ],
    ],
    [
      'opening-balance batch',
      (status) => <OpeningBatchStatusLabel status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['PENDING_APPROVAL', 'warning', 'Awaiting approval'],
        ['POSTED', 'success', 'Posted'],
        ['REVERSED', 'danger', 'Reversed'],
      ],
    ],
    [
      'revaluation run',
      (status) => <RevaluationRunStatusLabel status={status} />,
      [
        ['DRAFT', 'neutral', 'Draft'],
        ['PENDING_APPROVAL', 'warning', 'Awaiting approval'],
        ['POSTED', 'success', 'Posted'],
        ['REVERSED', 'danger', 'Cancelled'],
      ],
    ],
  ];

  for (const [name, render_, rows] of vocabularies) {
    it.each(rows)(`${name}: %s keeps its tone %s and label "%s"`, (status, tone, text) => {
      expect(badge(render_(status))).toEqual({ tone, text });
    });

    it(`${name}: an unknown status is neutral with its raw text, never empty`, () => {
      expect(badge(render_('ON_HOLD'))).toEqual({ tone: 'neutral', text: 'ON_HOLD' });
      expect(badge(render_('constructor'))).toEqual({ tone: 'neutral', text: 'constructor' });
      expect(badge(render_('toString'))).toEqual({ tone: 'neutral', text: 'toString' });
    });
  }
});
