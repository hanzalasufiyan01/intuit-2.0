import type { ImportDomainKey } from '../../../modules/data-exchange/index.js';
import type { ImportDomain } from '../types.js';
import { accountsImport } from './accounts.js';
import { journalsImport } from './journals.js';
import { openingBalancesImport } from './opening-balances.js';
import { partiesImport } from './parties.js';
import { dimensionValuesImport, exchangeRatesImport, partyContactsImport } from './small.js';

/** Approved S6 import domains (L-2). Phase 3B registers its own (customers, items, ...). */
export const importDomains: ReadonlyMap<ImportDomainKey, ImportDomain> = new Map(
  [
    accountsImport,
    partiesImport,
    partyContactsImport,
    dimensionValuesImport,
    exchangeRatesImport,
    journalsImport,
    // Phase 3A S8 (S8-16): fills the draft opening batch; never posts.
    openingBalancesImport,
  ].map((d) => [d.key, d]),
);
