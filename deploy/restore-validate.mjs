#!/usr/bin/env node
// Compares a restored database with its source and checks the restored copy's own rules.
//
//   SOURCE_URL=... TARGET_URL=... node deploy/restore-validate.mjs
//
// Needs the `pg` package (run from the repository: it is resolved from apps/api). Exit 0 = all
// checks passed. The source may have changed since the dump was taken: for tables that are
// append-only (journals, ledger, audit) the restored count must not EXCEED the source, and when the
// source has not changed the counts must be equal; set STRICT_COUNTS=yes (the default when nothing
// writes to the source) to require equality.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'),
);
const pg = require('pg');
const strict = (process.env.STRICT_COUNTS ?? 'yes') === 'yes';
const source = new pg.Client({ connectionString: process.env.SOURCE_URL });
const target = new pg.Client({ connectionString: process.env.TARGET_URL });
await source.connect();
await target.connect();

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL ${message}`);
};
const ok = (message) => console.log(`  ok   ${message}`);

const tablesOf = async (client) =>
  (
    await client.query(
      `SELECT c.relname AS name, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
  ).rows;

const [sourceTables, targetTables] = [await tablesOf(source), await tablesOf(target)];
const targetNames = new Set(targetTables.map((t) => t.name));
const missing = sourceTables.filter((t) => !targetNames.has(t.name)).map((t) => t.name);
if (missing.length) fail(`tables missing from the restore: ${missing.join(', ')}`);
else ok(`${sourceTables.length} tables present`);

// Row-level security must survive the restore (tenant isolation).
const sourceRls = new Map(sourceTables.map((t) => [t.name, t.rls]));
const rlsLost = targetTables
  .filter((t) => sourceRls.get(t.name) === true && t.rls !== true)
  .map((t) => t.name);
if (rlsLost.length) fail(`row-level security lost on: ${rlsLost.join(', ')}`);
else ok(`row-level security enabled on ${targetTables.filter((t) => t.rls).length} tables`);

// Row counts.
let compared = 0;
for (const t of sourceTables) {
  if (!targetNames.has(t.name)) continue;
  const q = `SELECT count(*)::bigint AS n FROM "${t.name}"`;
  const [a, b] = [
    Number((await source.query(q)).rows[0].n),
    Number((await target.query(q)).rows[0].n),
  ];
  compared += 1;
  if (strict ? a !== b : b > a) fail(`row count of ${t.name}: source ${a}, restored ${b}`);
}
if (!failures.some((f) => f.startsWith('row count'))) ok(`row counts match on ${compared} tables`);

// Migrations: same versions and checksums.
const migrations = async (c) =>
  (await c.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
const [ma, mb] = [await migrations(source), await migrations(target)];
if (JSON.stringify(ma) !== JSON.stringify(mb))
  fail('schema_migrations differ between source and restore');
else ok(`${mb.length} migrations with identical checksums`);

// The restored books balance: every posted journal has equal debits and credits, and the trial
// balance sums to zero, per organization.
const unbalanced = await target.query(
  `SELECT j.id FROM accounting_journal_entries j
    WHERE j.status IN ('POSTED', 'REVERSED')
      AND j.total_base_debit IS DISTINCT FROM j.total_base_credit LIMIT 5`,
);
if (unbalanced.rows.length)
  fail(`${unbalanced.rows.length}+ posted journals with unequal base totals`);
else ok('every posted journal balances');
const trial = await target.query(
  `SELECT j.organization_id, sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))::numeric(28,4) AS diff
     FROM accounting_journal_lines l
     JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
    WHERE j.status IN ('POSTED', 'REVERSED') GROUP BY j.organization_id HAVING sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)) <> 0 LIMIT 5`,
);
if (trial.rows.length)
  fail(`trial balance does not sum to zero for ${trial.rows.length}+ organizations`);
else ok('trial balance sums to zero for every organization');

// The ledger totals are identical to the source's (a content check, not only counts).
const fingerprint = async (c) =>
  (
    await c.query(
      `SELECT md5(string_agg(x, ',' ORDER BY x)) AS h FROM (
         SELECT l.journal_id::text || ':' || l.account_id::text || ':' || coalesce(l.base_debit, 0)::text || ':' || coalesce(l.base_credit, 0)::text AS x
           FROM accounting_journal_lines l) s`,
    )
  ).rows[0].h;
const [fa, fb] = [await fingerprint(source), await fingerprint(target)];
if (strict && fa !== fb) fail('journal line fingerprint differs from the source');
else ok(`journal lines fingerprint ${strict ? 'identical' : 'taken'} (${fb})`);

// Inventory placement still adds up (ADR 0014), when the table exists.
const hasLevels = (await target.query(`SELECT to_regclass('public.inventory_stock_levels') AS r`))
  .rows[0].r;
if (hasLevels) {
  const off = await target.query(
    `SELECT b.item_id FROM inventory_balances b
      WHERE b.quantity IS DISTINCT FROM (SELECT coalesce(sum(l.quantity), 0) FROM inventory_stock_levels l
                                          WHERE l.organization_id = b.organization_id AND l.item_id = b.item_id) LIMIT 5`,
  );
  if (off.rows.length) fail('inventory warehouse levels do not add up to balances');
  else ok('inventory levels add up to balances');
}

// The app role can still read tenant tables only through row-level security (policy count equal).
const policies = async (c) =>
  Number(
    (await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`))
      .rows[0].n,
  );
const [pa, pb] = [await policies(source), await policies(target)];
if (pa !== pb) fail(`row-level security policies: source ${pa}, restored ${pb}`);
else ok(`${pb} row-level security policies restored`);

await source.end();
await target.end();
if (failures.length) {
  console.error(
    `RESTORE VALIDATION FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'})`,
  );
  process.exit(1);
}
console.log('Restore validation passed.');
