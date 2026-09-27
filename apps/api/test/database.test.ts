import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles, runMigrations } from '../src/database/migrator.js';
import { connectAs, createTestContext, uniqueEmail, type TestContext } from './helpers.js';

let ctx: TestContext;
let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
  app = await connectAs('app');
});
afterAll(async () => {
  await owner.end();
  await app.end();
  await ctx.close();
});

const PHASE1_TABLES = [
  'users',
  'sessions',
  'password_reset_tokens',
  'organizations',
  'memberships',
  'permissions',
  'role_templates',
  'role_template_permissions',
  'roles',
  'role_permissions',
  'membership_roles',
  'invitations',
  'ownership_transfers',
  'audit_events',
  'security_events',
  'outbox_events',
];

/** Runs `sql` inside a transaction with the given RLS context and rolls back. */
async function asApp<T>(
  context: { userId?: string; organizationId?: string },
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)`,
      [context.userId ?? '', context.organizationId ?? ''],
    );
    return await work(app);
  } finally {
    await app.query('ROLLBACK');
  }
}

async function expectPgError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('migrations', () => {
  it('are recorded with checksums and re-running is a no-op', async () => {
    const { rows } = await owner.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const files = readMigrationFiles();
    expect(rows.map((r) => r.version)).toEqual(files.map((f) => f.version));
    expect(rows.map((r) => r.checksum)).toEqual(files.map((f) => f.checksum));
    expect(await runMigrations(process.env.DATABASE_MIGRATION_URL!)).toEqual([]);
  });

  it('create every Phase 1 table owned by the migration role', async () => {
    const { rows } = await owner.query(
      `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = new Map(rows.map((r) => [r.tablename, r.tableowner]));
    for (const table of PHASE1_TABLES) {
      expect(tables.get(table), table).toBe('intuit_owner');
    }
  });

  it('create the supporting indexes', async () => {
    const { rows } = await owner.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'users_email_normalized_key',
        'sessions_token_hash_key',
        'sessions_user_active_idx',
        'memberships_organization_user_key',
        'membership_roles_single_owner_idx',
        'roles_organization_name_idx',
        'invitations_single_pending_idx',
        'audit_events_organization_time_idx',
        'security_events_login_failed_email_idx',
        'security_events_login_failed_ip_idx',
        'outbox_events_dispatch_idx',
      ]),
    );
  });
});

const PHASE2_TABLES = [
  'approval_policies',
  'approval_policy_steps',
  'approval_step_eligible_roles',
  'approval_step_eligible_members',
  'approval_requests',
  'approval_decisions',
  'accounting_settings',
  'accounting_accounts',
  'accounting_exchange_rates',
  'accounting_fiscal_years',
  'accounting_periods',
  'accounting_journal_entries',
  'accounting_journal_lines',
  'accounting_journal_reversals',
  'accounting_events',
];

describe('phase 2 migration', () => {
  it('creates the accounting and approval tables with RLS enabled', async () => {
    const { rows } = await owner.query(
      `SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    );
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const table of PHASE2_TABLES) {
      expect(byName.get(table), table).toMatchObject({
        relrowsecurity: true,
        owner: 'intuit_owner',
      });
    }
    for (const table of ['accounting_coa_templates', 'accounting_coa_template_accounts']) {
      expect(byName.get(table)?.owner).toBe('intuit_owner');
    }
  });

  it('grants the application role no DELETE on journals and no UPDATE/DELETE on decisions', async () => {
    const { rows } = await owner.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'intuit_app' AND table_name IN ('accounting_journal_entries', 'approval_decisions',
         'accounting_journal_reversals', 'accounting_exchange_rates')`,
    );
    const granted = rows.map((r) => `${r.table_name}:${r.privilege_type}`).sort();
    expect(granted).toEqual([
      'accounting_exchange_rates:INSERT',
      'accounting_exchange_rates:SELECT',
      'accounting_journal_entries:INSERT',
      'accounting_journal_entries:SELECT',
      'accounting_journal_entries:UPDATE',
      'accounting_journal_reversals:INSERT',
      'accounting_journal_reversals:SELECT',
      'approval_decisions:INSERT',
      'approval_decisions:SELECT',
    ]);
  });

  it('accepts three-segment permission keys and still forbids invoices.delete', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM permissions WHERE key LIKE 'accounting.%'`,
    );
    expect(rows[0].n).toBe(17);
    await expectPgError(
      owner.query(
        `INSERT INTO permissions (key, module, description) VALUES ('invoices.delete', 't', 'x')`,
      ),
      '23514',
    );
  });

  it('backfills pre-Phase-2 Administrator/Member roles additively (migration 0003)', async () => {
    const backfillSql = readMigrationFiles().find(
      (m) => m.version === '0003_phase2_permission_backfill',
    )!.sql;
    const client = ctx.client();
    const { session } = await client.register();
    const orgId = session.activeOrganization.id;
    const customRole = await client.post('/organizations/current/roles', {
      name: 'Custom viewer',
      permissionKeys: ['organization.read'],
    });
    expect(customRole.status).toBe(201);

    await owner.query('BEGIN');
    try {
      // Simulate an organization created before Phase 2: its template roles lack Phase 2 keys,
      // and the Member role was customized with an extra Phase 1 permission.
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1
           AND (permission_key LIKE 'accounting.%' OR permission_key = 'approvals.manage')
           AND role_id IN (SELECT id FROM roles WHERE organization_id = $1 AND NOT is_owner)`,
        [orgId],
      );
      await owner.query(
        `INSERT INTO role_permissions (role_id, organization_id, permission_key)
         SELECT id, organization_id, 'audit.read' FROM roles WHERE organization_id = $1 AND template_key = 'member'`,
        [orgId],
      );
      await owner.query(backfillSql);
      // Idempotent: a second run adds nothing. (Its temp tables normally drop at commit.)
      await owner.query('DROP TABLE phase2_backfill_grants, phase2_backfilled');
      await owner.query(backfillSql);

      const { rows } = await owner.query(
        `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
         WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId],
      );
      const keys = Object.fromEntries(rows.map((r) => [r.name, r.keys as string[]]));
      expect(keys.Administrator).toHaveLength(26);
      expect(keys.Member).toEqual([
        'accounting.accounts.view',
        'accounting.journals.view',
        'accounting.ledger.view',
        'accounting.periods.view',
        'audit.read', // customization preserved: additive only
        'members.read',
        'organization.read',
      ]);
      expect(keys['Custom viewer']).toEqual(['organization.read']);
      expect(keys.Owner).toHaveLength(26);

      const audit = await owner.query(
        `SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'role.permissions_backfilled'`,
        [orgId],
      );
      expect(audit.rows).toHaveLength(2); // second run added nothing
      expect(audit.rows.map((r) => r.metadata.templateKey).sort()).toEqual([
        'administrator',
        'member',
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('constraints', () => {
  it('reject the forbidden invoices.delete permission at the database level', async () => {
    await expectPgError(
      owner.query(
        `INSERT INTO permissions (key, module, description) VALUES ('invoices.delete', 'test', 'x')`,
      ),
      '23514',
    );
  });

  it('enforce unique normalized emails and Argon2id hashes', async () => {
    const client = ctx.client();
    const { email } = await client.register();
    await expectPgError(
      owner.query(
        `INSERT INTO users (email, email_normalized, display_name, password_hash, password_changed_at)
         VALUES ($1, $2, 'x', '$argon2id$v=19$m=1,t=1,p=1$abc', now())`,
        [email.toUpperCase(), email.toLowerCase()],
      ),
      '23505',
    );
    await expectPgError(
      owner.query(
        `INSERT INTO users (email, email_normalized, display_name, password_hash, password_changed_at)
         VALUES ($1, $1, 'x', 'plaintext', now())`,
        [uniqueEmail()],
      ),
      '23514',
    );
  });

  it('allow at most one Owner per organization', async () => {
    const owner1 = ctx.client();
    const { session } = await owner1.register();
    const orgId = session.activeOrganization.id;
    const { invitee } = await (async () => {
      const email = uniqueEmail();
      const roles = (await owner1.get('/organizations/current/roles')).body.data;
      await owner1.post('/organizations/current/invitations', {
        email,
        roleId: roles.find((r: { name: string }) => r.name === 'Member').id,
      });
      const token = ctx.email.lastTo(email)!.text.match(/#token=([A-Za-z0-9_-]+)/)![1];
      const invitee = ctx.client();
      await invitee.post('/invitations/accept', {
        token,
        displayName: 'Second',
        password: 'correct horse battery staple',
      });
      return { invitee };
    })();
    const secondMembership = (await invitee.get('/auth/session')).body.data.activeOrganization
      .membershipId;
    const { rows } = await owner.query(
      `SELECT id FROM roles WHERE organization_id = $1 AND is_owner`,
      [orgId],
    );
    await expectPgError(
      owner.query(
        `INSERT INTO membership_roles (membership_id, role_id, organization_id, role_is_owner)
         VALUES ($1, $2, $3, true)`,
        [secondMembership, rows[0].id, orgId],
      ),
      '23505',
    );
    // The owner flag must match the role (composite foreign key).
    await expectPgError(
      owner.query(
        `INSERT INTO membership_roles (membership_id, role_id, organization_id, role_is_owner)
         VALUES ($1, $2, $3, false)`,
        [secondMembership, rows[0].id, orgId],
      ),
      '23503',
    );
  });

  it('pin role assignments to roles of the same organization', async () => {
    const a = ctx.client();
    const { session: sa } = await a.register();
    const b = ctx.client();
    const { session: sb } = await b.register();
    const { rows } = await owner.query(
      `SELECT id FROM roles WHERE organization_id = $1 AND template_key = 'member'`,
      [sb.activeOrganization.id],
    );
    await expectPgError(
      owner.query(
        `INSERT INTO membership_roles (membership_id, role_id, organization_id, role_is_owner)
         VALUES ($1, $2, $3, false)`,
        [sa.activeOrganization.membershipId, rows[0].id, sa.activeOrganization.id],
      ),
      '23503',
    );
  });
});

describe('audit and security history immutability', () => {
  it('the application role can insert and read but not update or delete history', async () => {
    const privileges = await owner.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'intuit_app' AND table_name IN ('audit_events', 'security_events')`,
    );
    const granted = privileges.rows.map((r) => `${r.table_name}:${r.privilege_type}`).sort();
    expect(granted).toEqual([
      'audit_events:INSERT',
      'audit_events:SELECT',
      'security_events:INSERT',
      'security_events:SELECT',
    ]);

    await expectPgError(app.query(`UPDATE security_events SET event_type = 'x.y'`), '42501');
    await expectPgError(app.query('DELETE FROM security_events'), '42501');
    await expectPgError(app.query('TRUNCATE security_events'), '42501');
    await expectPgError(app.query(`UPDATE audit_events SET action = 'x.y'`), '42501');
    await expectPgError(app.query('DELETE FROM audit_events'), '42501');
  });

  it('triggers reject modification even by the owning role', async () => {
    const client = ctx.client();
    const { session } = await client.register();
    const { rows } = await owner.query(
      'SELECT id FROM security_events WHERE user_id = $1 LIMIT 1',
      [session.user.id],
    );
    const id = rows[0].id;
    await expectPgError(
      owner.query(`UPDATE security_events SET event_type = 'tampered.event' WHERE id = $1`, [id]),
      '42501',
    );
    await expectPgError(owner.query('DELETE FROM security_events WHERE id = $1', [id]), '42501');
    await expectPgError(owner.query('TRUNCATE security_events'), '42501');
    await expectPgError(
      owner.query(`UPDATE audit_events SET action = 'tampered.event' WHERE organization_id = $1`, [
        session.activeOrganization.id,
      ]),
      '42501',
    );
    await expectPgError(owner.query('TRUNCATE audit_events'), '42501');
  });

  it('never records secrets in history', async () => {
    const client = ctx.client();
    const { email, session } = await client.register();
    await ctx.client().post('/auth/password-reset/request', { email });
    const token = ctx.email.lastTo(email)!.text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
    await ctx
      .client()
      .post('/auth/password-reset/complete', { token, newPassword: 'another long passphrase' });
    const history = await owner.query(
      `SELECT row_to_json(s)::text AS row FROM security_events s WHERE user_id = $1
       UNION ALL
       SELECT row_to_json(a)::text FROM audit_events a WHERE actor_user_id = $1`,
      [session.user.id],
    );
    const text = history.rows.map((r) => r.row).join('\n');
    expect(history.rows.length).toBeGreaterThan(3);
    expect(text).not.toContain(token);
    expect(text).not.toContain('correct horse battery staple');
    expect(text).not.toContain('another long passphrase');
    expect(text).not.toContain(client.sessionToken ?? 'no-session');
    expect(text).not.toContain('$argon2id$');
  });
});

describe('row-level security (defence-in-depth)', () => {
  it('is enabled on every tenant-scoped table', async () => {
    const { rows } = await owner.query(
      `SELECT relname FROM pg_class WHERE relrowsecurity AND relnamespace = 'public'::regnamespace`,
    );
    expect(rows.map((r) => r.relname)).toEqual(
      expect.arrayContaining([
        'organizations',
        'memberships',
        'roles',
        'role_permissions',
        'membership_roles',
        'invitations',
        'ownership_transfers',
        'audit_events',
      ]),
    );
  });

  it('hides other organizations from the application role even with direct queries', async () => {
    const a = ctx.client();
    const { session: sa } = await a.register();
    const b = ctx.client();
    const { session: sb } = await b.register();
    const orgA = sa.activeOrganization.id;
    const orgB = sb.activeOrganization.id;

    await asApp({ userId: sa.user.id, organizationId: orgA }, async (db) => {
      const tables = [
        'organizations',
        'memberships',
        'roles',
        'role_permissions',
        'membership_roles',
        'audit_events',
      ];
      for (const table of tables) {
        const column = table === 'organizations' ? 'id' : 'organization_id';
        const other = await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [orgB],
        );
        expect(other.rows[0].n, table).toBe(0);
        const own = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [
          orgA,
        ]);
        expect(own.rows[0].n, table).toBeGreaterThan(0);
      }
      // Writes into another organization are rejected by policy.
      await db.query('SAVEPOINT intruder');
      await expectPgError(
        db.query(`INSERT INTO roles (organization_id, name) VALUES ($1, 'Intruder')`, [orgB]),
        '42501',
      );
      await db.query('ROLLBACK TO SAVEPOINT intruder');
      const updated = await db.query(`UPDATE organizations SET name = 'Hijacked' WHERE id = $1`, [
        orgB,
      ]);
      expect(updated.rowCount).toBe(0);
    });
  });

  it('shows nothing tenant-scoped without a context', async () => {
    await asApp({}, async (db) => {
      for (const table of [
        'organizations',
        'memberships',
        'roles',
        'invitations',
        'audit_events',
      ]) {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it('lets a user see only their own memberships across organizations', async () => {
    const a = ctx.client();
    const { session: sa } = await a.register();
    await a.post('/organizations', { name: 'Second' });
    await asApp({ userId: sa.user.id }, async (db) => {
      const { rows } = await db.query('SELECT DISTINCT user_id FROM memberships');
      expect(rows).toEqual([{ user_id: sa.user.id }]);
      const orgs = await db.query('SELECT count(*)::int AS n FROM organizations');
      expect(orgs.rows[0].n).toBe(2);
    });
  });

  it('keeps the migration-only table inaccessible to the application role', async () => {
    await expectPgError(app.query('SELECT * FROM schema_migrations'), '42501');
    await expectPgError(app.query('CREATE TABLE should_fail (id int)'), '42501');
  });
});
