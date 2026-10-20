# Tax localization: unresolved decisions (Maldives / MIRA)

Status: **BLOCKED on decisions**, requirement FP-23. Nothing below is implemented and no tax rule has been invented. The system today supports tax codes with configurable rates, exclusive/inclusive treatment, recoverable and non-recoverable input tax, and a sales/purchases tax summary "for review, not a tax return" (R31).

Decisions the business or its tax adviser must give, in writing, before any return data is built:

1. **Tax types in scope**: which of GST, TGST, Green Tax, and others apply to which kinds of business, and whether the organization can hold more than one registration.
2. **Rates and effective dates**: the rate table to seed, and whether historical rate changes must be reproduced on old documents (the system freezes the rate on each document today).
3. **Return layout**: the exact boxes of the MIRA return (the "205" return named in the brief), what feeds each box (taxable, zero-rated, exempt, out of scope, imports, input tax by category), and the filing period rules.
4. **Zero-rated versus exempt** treatment and its effect on input-tax recovery (partial exemption apportionment).
5. **Withholding tax**: which payments, which rates, who withholds, when it is remitted, and how it appears on the vendor payment and on a certificate.
6. **Rounding**: per line, per document, or per return.
7. **Bad-debt relief, adjustments and credit notes** across periods.
8. **Filing**: file export only, or a submission format; any e-filing identifier.

Independent work that does not need these decisions (done or planned): sales and purchases tax summaries (done), a tax-liability summary of output minus input tax per tax code (FP-22), data exports (done).
