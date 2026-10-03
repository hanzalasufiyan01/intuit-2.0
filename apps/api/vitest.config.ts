import { defineConfig } from 'vitest/config';

/**
 * Test files that touch state shared by every organization run one at a time, after the other
 * files (which run in parallel):
 * - files that run the background job worker claim every due job in the shared test database,
 *   including jobs other files create with deliberately unregistered types;
 * - files that replay permission-backfill migrations update role permissions of every
 *   organization and would deadlock with files registering organizations in parallel.
 */
const serialFiles = [
  'test/jobs.test.ts',
  'test/imports.test.ts',
  'test/approval-conditions.test.ts',
  'test/exports.test.ts',
  'test/database.test.ts',
  'test/s2-fixes.test.ts',
  // S8: drives the job worker for opening-balance imports and exports.
  'test/opening-balances.test.ts',
  // Phase 3B: drives the job worker for document PDFs and email.
  'test/sales-output.test.ts',
  'test/sales-data-exchange.test.ts',
  // Phase 3B step 21: replays the Sales permission backfill (migration 0026).
  'test/sales-permissions.test.ts',
  // Phase 4A-1: replays the 0027 backfill, dropping a CHECK inside a rolled-back transaction.
  'test/subledger-control.test.ts',
  // Phase 4A-4: replays the catalog permission backfill (migration 0031).
  'test/catalog-permissions.test.ts',
  // ADR 0004 P4-36: drives the job worker for an opening-balance import.
  'test/opening-balance-ap-guard.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    // Applies migrations and seeds reference data on the real PostgreSQL database first.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'api',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: serialFiles,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'api-serial',
          include: serialFiles,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
