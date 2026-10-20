import { decimal } from '../domain/money.js';
import type { ApReportService } from './ap-report-service.js';
import type { ArReportService } from './ar-report-service.js';
import type { Principal } from './authorization.js';

/**
 * Tax liability summary (FP-22): output tax on issued sales minus recoverable input tax on posted
 * purchases for a period, per tax code and rate. It combines the two existing review summaries, so
 * it needs both `sales.reports.view` and `purchases.reports.view`, and it is a REVIEW summary only:
 * it is not a MIRA return and applies no tax-policy rule (see docs/design/tax-localization-open-decisions.md).
 */
export class TaxLiabilityService {
  constructor(
    private readonly arReports: ArReportService,
    private readonly apReports: ApReportService,
  ) {}

  async summary(principal: Principal, input: { from: string; to: string }) {
    const output = await this.arReports.taxSummary(principal, input);
    const inputTax = await this.apReports.inputTaxSummary(principal, input);
    const key = (taxCodeId: string | null, rate: string | null) =>
      `${taxCodeId ?? '-'}|${rate ?? '-'}`;
    const rows = new Map<
      string,
      {
        taxCodeId: string | null;
        code: string | null;
        rate: string | null;
        outputTax: string;
        recoverableInputTax: string;
      }
    >();
    for (const c of output.codes) {
      rows.set(key(c.taxCodeId, c.rate), {
        taxCodeId: c.taxCodeId,
        code: c.code,
        rate: c.rate,
        outputTax: c.tax,
        recoverableInputTax: '0',
      });
    }
    for (const c of inputTax.codes) {
      const k = key(c.taxCodeId, c.rate);
      const existing = rows.get(k);
      if (existing) existing.recoverableInputTax = c.recoverableTax;
      else {
        rows.set(k, {
          taxCodeId: c.taxCodeId,
          code: c.code,
          rate: c.rate,
          outputTax: '0',
          recoverableInputTax: c.recoverableTax,
        });
      }
    }
    const places = (output.totals.tax.split('.')[1] ?? '').length;
    const codes = [...rows.values()]
      .map((r) => ({
        ...r,
        netPayable: decimal(r.outputTax).minus(r.recoverableInputTax).toFixed(places),
      }))
      .sort(
        (a, b) =>
          (a.code ?? '\uffff').localeCompare(b.code ?? '\uffff') ||
          decimal(a.rate ?? 0).comparedTo(b.rate ?? 0),
      );
    const outTotal = decimal(output.totals.tax);
    const inTotal = decimal(inputTax.totals.recoverableTax);
    return {
      from: input.from,
      to: input.to,
      baseCurrency: output.baseCurrency,
      reviewOnly: true,
      note: 'Review summary only; not a tax return. Output tax less recoverable input tax per tax code; no MIRA rule is applied.',
      codes,
      totals: {
        outputTax: outTotal.toFixed(places),
        recoverableInputTax: inTotal.toFixed(places),
        netPayable: outTotal.minus(inTotal).toFixed(places),
      },
    };
  }
}
