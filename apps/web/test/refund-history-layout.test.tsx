import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { RefundHistory } from '../src/features/purchases/RefundPages';
import { CustomerRefundHistory } from '../src/features/sales/RefundPages';
import { makeSession } from './fake-api';

/**
 * The "Refund ..." link of a refund history sits in the card header, not after the list. The list
 * is fetched separately: while it loads the card holds a spinner, afterwards rows or an empty
 * note. A link that followed the list moved when the list arrived, so a click aimed at it (a
 * person's or a browser test's, which measures the position first) could land on the card instead.
 * Observed in the browser tests: 8 lost clicks in 25 full page loads of a receipt. The header does
 * not move, so the link must be there from the first render and stay the same element.
 */

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Answers the session at once and holds the refund list until `release` is called. */
function stubApiHoldingRefunds(listPath: string) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      if (path === '/auth/session') return json(makeSession({ permissions: [] }));
      if (path === listPath) {
        await held;
        return json({ items: [], nextCursor: null });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return release;
}

function renderCard(element: React.ReactElement) {
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('refund history card', () => {
  it('shows the customer refund link in the header while the list loads, and keeps it', async () => {
    const release = stubApiHoldingRefunds('/sales/refunds');
    renderCard(<CustomerRefundHistory sourceType="receipt" sourceId="r1" canRefund />);

    const link = await screen.findByRole('link', { name: 'Refund unallocated amount' });
    expect(screen.getByText('Loading…')).toBeTruthy(); // the list is still loading
    expect(link.closest('header.card__header')).not.toBeNull();

    release();
    await screen.findByText('Nothing has been refunded from this document.');
    // The same element, still in the header: the arrival of the list did not move or replace it.
    expect(screen.getByRole('link', { name: 'Refund unallocated amount' })).toBe(link);
    expect(link.closest('header.card__header')).not.toBeNull();
  });

  it('does the same for a credit note', async () => {
    const release = stubApiHoldingRefunds('/sales/refunds');
    renderCard(<CustomerRefundHistory sourceType="credit_note" sourceId="n1" canRefund />);
    const credit = await screen.findByRole('link', { name: 'Refund credit' });
    expect(credit.closest('header.card__header')).not.toBeNull();
    release();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByRole('link', { name: 'Refund credit' })).toBe(credit);
  });

  it('offers no link without the permission, whatever the list shows', async () => {
    const release = stubApiHoldingRefunds('/sales/refunds');
    renderCard(<CustomerRefundHistory sourceType="receipt" sourceId="r1" canRefund={false} />);
    await screen.findByText('Loading…');
    release();
    await screen.findByText('Nothing has been refunded from this document.');
    expect(screen.queryByRole('link', { name: 'Refund unallocated amount' })).toBeNull();
  });

  it('shows the vendor refund link in the header while the list loads, and keeps it', async () => {
    const release = stubApiHoldingRefunds('/purchases/refunds');
    renderCard(<RefundHistory sourceType="payment" sourceId="p1" canRefund />);

    const link = await screen.findByRole('link', { name: 'Refund prepayment' });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(link.closest('header.card__header')).not.toBeNull();

    release();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByRole('link', { name: 'Refund prepayment' })).toBe(link);
  });
});
