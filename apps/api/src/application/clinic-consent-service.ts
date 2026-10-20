import type { Transaction } from '../database/client.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  ClinicPermissions,
  getClinicSettings,
  getPatient,
  insertConsentEvent,
  listConsentEvents,
  listPatientsPastRetention,
  saveClinicSettings,
  type ConsentEvent,
} from '../modules/clinic/index.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { requireAccountingSettings } from './accounting-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Consent register and retention review for the clinic module (migration 0086, ADR 0013
 * addendum). Decisions of the business owner (2026-10-19): the organization enters its own consent
 * wording; recording consent changes nothing else; the organization enters its own retention
 * period (no default is assumed) and the system only LISTS patients past it, never removes
 * anything. Audit metadata carries the patient number and counts, never names or wording.
 */

const MODULE = 'clinic' as const;
const isDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export class ClinicConsentService {
  constructor(private readonly deps: AppDependencies) {}

  private run<T>(
    principal: Principal,
    permission: string,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
  ) {
    return withOrganization(this.deps, principal, { permission, module: MODULE }, work);
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.deps.clock.now(),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'clinic_patient',
      resourceId,
      metadata,
      origin,
    });
  }

  /** The current state per purpose (latest event wins) plus the full history, oldest first. */
  private view(events: ConsentEvent[]) {
    const current = new Map<string, ConsentEvent>();
    for (const e of events) current.set(e.purpose, e);
    const toView = (e: ConsentEvent) => ({
      id: e.id,
      purpose: e.purpose,
      wording: e.wording,
      action: e.action,
      effectiveDate: e.effectiveDate,
      recordedAt: e.recordedAt.toISOString(),
    });
    return {
      current: [...current.values()].map((e) => ({
        purpose: e.purpose,
        status: e.action,
        effectiveDate: e.effectiveDate,
        wording: e.action === 'granted' ? e.wording : '',
      })),
      history: events.map(toView),
    };
  }

  /** Reading a patient's consent is a patient-record read, so it is audited like one. */
  list(principal: Principal, patientId: string, origin: EventOrigin) {
    return this.run(principal, ClinicPermissions.PatientsView, async (tx, ctx) => {
      const patient = await getPatient(tx, ctx.organizationId, patientId);
      if (!patient) throw new NotFoundError('Patient not found.');
      await this.audit(tx, ctx, 'clinic.consent_viewed', patientId, origin, {
        number: patient.number,
      });
      return this.view(await listConsentEvents(tx, ctx.organizationId, patientId));
    });
  }

  record(
    principal: Principal,
    patientId: string,
    input: {
      purpose: string;
      wording?: string | undefined;
      action: 'granted' | 'withdrawn';
      effectiveDate?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      const patient = await getPatient(tx, ctx.organizationId, patientId);
      if (!patient) throw new NotFoundError('Patient not found.');
      if (patient.status === 'ANONYMIZED') {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'Consent cannot be recorded for an anonymized patient.',
        );
      }
      const now = this.deps.clock.now();
      const today = now.toISOString().slice(0, 10);
      const purpose = input.purpose.trim();
      const wording = (input.wording ?? '').trim();
      const effectiveDate = input.effectiveDate ?? today;
      const issues = [];
      if (!purpose) issues.push({ path: 'purpose', message: 'Enter the purpose.' });
      if (input.action === 'granted' && !wording) {
        issues.push({ path: 'wording', message: 'Enter the consent wording that was shown.' });
      }
      if (!isDate(effectiveDate) || effectiveDate > today) {
        issues.push({
          path: 'effectiveDate',
          message: 'Enter a valid date that is not in the future.',
        });
      }
      if (issues.length) throw new ValidationError(issues);
      const events = await listConsentEvents(tx, ctx.organizationId, patientId);
      const latest = [...events].reverse().find((e) => e.purpose === purpose);
      if (input.action === 'withdrawn' && latest?.action !== 'granted') {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'There is no consent on file for this purpose to withdraw.',
        );
      }
      if (
        input.action === 'granted' &&
        latest?.action === 'granted' &&
        latest.wording === wording
      ) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'This consent is already on file with the same wording.',
        );
      }
      await requireAccountingSettings(tx, ctx.organizationId);
      await insertConsentEvent(tx, {
        organizationId: ctx.organizationId,
        patientId,
        purpose,
        wording: input.action === 'granted' ? wording : '',
        action: input.action,
        effectiveDate,
        recordedByUserId: ctx.userId,
        recordedAt: now,
      });
      await this.audit(tx, ctx, 'clinic.consent_recorded', patientId, origin, {
        number: patient.number,
        action: input.action,
      });
      return this.view(await listConsentEvents(tx, ctx.organizationId, patientId));
    });
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  getSettings(principal: Principal) {
    return this.run(principal, ClinicPermissions.PatientsView, async (tx, ctx) => {
      const s = await getClinicSettings(tx, ctx.organizationId);
      return { retentionYears: s?.retentionYears ?? null, version: s?.version ?? 0 };
    });
  }

  /** `version` 0 creates the row. The organization chooses the period; null clears it. */
  setSettings(
    principal: Principal,
    input: { retentionYears: number | null; version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      await requireAccountingSettings(tx, ctx.organizationId);
      const before = await getClinicSettings(tx, ctx.organizationId);
      const saved = await saveClinicSettings(tx, {
        organizationId: ctx.organizationId,
        retentionYears: input.retentionYears,
        version: input.version,
        userId: ctx.userId,
        at: this.deps.clock.now(),
      });
      if (!saved) {
        throw new ConflictError(
          'VERSION_CONFLICT',
          'The clinic settings changed; reload them and try again.',
        );
      }
      await this.audit(tx, ctx, 'clinic.retention_set', ctx.organizationId, origin, {
        before: before?.retentionYears ?? null,
        after: saved.retentionYears,
      });
      return { retentionYears: saved.retentionYears, version: saved.version };
    });
  }

  /**
   * Patients with no activity for longer than the organization's retention period. A review list
   * only: anonymizing is a separate, deliberate action on each patient. Audited (it names
   * patients).
   */
  retentionReview(principal: Principal, origin: EventOrigin) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      const settings = await getClinicSettings(tx, ctx.organizationId);
      const years = settings?.retentionYears ?? null;
      if (years === null) return { retentionYears: null, cutoff: null, items: [] };
      const cutoff = new Date(this.deps.clock.now());
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
      const items = await listPatientsPastRetention(tx, ctx.organizationId, cutoff, 200);
      await this.audit(tx, ctx, 'clinic.retention_reviewed', ctx.organizationId, origin, {
        retentionYears: years,
        returned: items.length,
      });
      return { retentionYears: years, cutoff: cutoff.toISOString().slice(0, 10), items };
    });
  }
}
