/**
 * Frozen render snapshots for the PDF regression tests (Phase 4B-7, D10). The three existing
 * document types — a Sales invoice, a Sales credit note and a Purchases debit note — are rendered
 * from these fixed inputs, and their SHA-256 hashes are pinned from the renderer as it stood before
 * the additive `remittance_advice` branch (commit 6ca38f3). Any change to how those documents are
 * drawn changes a hash.
 */

const address = {
  line1: 'Boduthakurufaanu Magu 12',
  line2: 'Henveiru',
  city: 'Malé',
  region: null,
  postalCode: '20026',
  countryCode: 'MV',
};

const seller = {
  legalName: 'Atoll Trading Pvt Ltd',
  tradingName: null,
  tin: '1000234',
  gstRegistrationNumber: '1000234GST501',
  email: 'accounts@atoll.test',
  phone: '+960 300 0000',
  logoFileId: null,
  address,
};

const line = (n: number, extra: Record<string, unknown> = {}) => ({
  description: `Line ${n} — ދިވެހި ތަފްސީލު Mixed text ${n}`,
  quantity: String((n % 4) + 1),
  unitPrice: '125.5',
  amount: '125.50',
  discount: '0.0000',
  taxCode: n % 2 === 0 ? 'GST' : null,
  taxRate: n % 2 === 0 ? '8.0000' : null,
  taxAmount: n % 2 === 0 ? '10.04' : '0',
  total: n % 2 === 0 ? '135.54' : '125.50',
  ...extra,
});

/** Enough lines to run onto a second page. */
const manyLines = Array.from({ length: 70 }, (_, i) => line(i + 1));

export const invoiceSnapshot: Record<string, unknown> = {
  version: 1,
  documentType: 'invoice',
  number: 'INV-00001',
  invoiceDate: '2026-03-10',
  dueDate: '2026-04-09',
  currencyCode: 'MVR',
  taxTreatment: 'exclusive',
  reference: 'PO-77',
  memo: 'Thank you for your business. ޝުކުރިއްޔާ',
  seller,
  customer: {
    displayName: 'Reef Divers',
    companyName: 'Reef Divers Pvt Ltd',
    tin: '2000111',
    email: 'billing@reef.test',
    billingAddress: address,
  },
  lines: manyLines,
  totals: { subtotal: '8785.00', discountTotal: '0', taxTotal: '351.40', total: '9136.40' },
};

export const creditNoteSnapshot: Record<string, unknown> = {
  version: 1,
  documentType: 'credit_note',
  number: 'CN-00001',
  creditDate: '2026-03-20',
  creditedInvoiceNumber: 'INV-00001',
  currencyCode: 'USD',
  taxTreatment: 'inclusive',
  reference: null,
  memo: '',
  seller,
  customer: {
    displayName: 'ރީފް ޑައިވަރސް',
    companyName: null,
    tin: null,
    email: null,
    billingAddress: address,
  },
  lines: [line(1), line(2), line(3)],
  totals: { subtotal: '386.54', discountTotal: '5', taxTotal: '10.04', total: '391.58' },
};

export const debitNoteSnapshot: Record<string, unknown> = {
  version: 1,
  documentType: 'debit_note',
  number: 'DN-00001',
  creditDate: '2026-03-25',
  billNumber: 'BILL-00004',
  counterpartyLabel: 'To',
  currencyCode: 'MVR',
  taxTreatment: 'exclusive',
  reference: null,
  memo: 'Returned goods',
  seller,
  customer: {
    displayName: 'Island Supplies',
    companyName: null,
    tin: '3000222',
    email: 'ap@island.test',
    billingAddress: address,
  },
  lines: [line(1), line(2)],
  totals: { subtotal: '251.00', discountTotal: '0', taxTotal: '10.04', total: '261.04' },
};

/** A remittance advice snapshot (Phase 4B-7); only the vendor block varies between the Thaana tests. */
export function remittanceSnapshot(
  vendor: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    version: 1,
    documentType: 'remittance_advice',
    number: 'PAY-00001',
    paymentDate: '2026-03-20',
    currencyCode: 'MVR',
    amount: '150.00',
    reference: null,
    seller,
    vendor: {
      displayName: 'Island Supplies',
      companyName: null,
      email: null,
      address: null,
      ...vendor,
    },
    lines: [
      {
        billNumber: 'BILL-00001',
        vendorReference: 'SUP-1',
        billDate: '2026-03-01',
        billTotal: '100.00',
        amountPaid: '100.00',
      },
    ],
    totals: { applied: '100.00', advance: '50.00', total: '150.00' },
    ...extra,
  } as Record<string, unknown>;
}
