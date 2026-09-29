/**
 * Domain / application errors. The HTTP layer maps these to the platform error format;
 * their messages are safe to show to clients and must never contain internal details.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'CSRF_REJECTED'
  | 'NO_ACTIVE_ORGANIZATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_UNAVAILABLE'
  | 'ALREADY_MEMBER'
  | 'LOGIN_REQUIRED'
  | 'PROTECTED_RESOURCE'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_TOKEN'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_NOT_PENDING'
  | 'INVITATION_EMAIL_MISMATCH'
  | 'TOO_MANY_ATTEMPTS'
  // Phase 2 — accounting and approvals
  | 'ACCOUNTING_NOT_SET_UP'
  | 'ACCOUNTING_ALREADY_SET_UP'
  | 'ACCOUNT_IN_USE'
  | 'INVALID_JOURNAL'
  | 'INVALID_STATE_TRANSITION'
  | 'PERIOD_CLOSED'
  | 'PERIOD_NOT_FOUND'
  | 'EXCHANGE_RATE_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'SELF_APPROVAL_PROHIBITED'
  | 'NOT_ELIGIBLE_APPROVER'
  | 'ALREADY_DECIDED'
  | 'IDEMPOTENCY_CONFLICT'
  // Phase 3A
  | 'ACCOUNT_DESIGNATED'
  | 'SYSTEM_JOURNAL'
  | 'FISCAL_YEAR_NOT_FOUND'
  | 'DESIGNATION_REQUIRED'
  | 'VERSION_CONFLICT'
  // Phase 3A S5
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'LEGAL_HOLD'
  // Phase 3A S6
  | 'IMPORT_NOT_READY'
  | 'IMPORT_LIMIT_REACHED'
  | 'EXPORT_TOO_LARGE'
  // Phase 3A S7 (S7-32)
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'MFA_VERIFICATION_REQUIRED'
  | 'MFA_STEP_UP_REQUIRED'
  | 'INVALID_MFA_CODE'
  | 'MFA_CHALLENGE_FAILED'
  | 'MFA_UNAVAILABLE';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: { issues?: ValidationIssue[]; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(issues: ValidationIssue[], message = 'The request is invalid.') {
    super('VALIDATION_FAILED', 400, message, { issues });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super('UNAUTHENTICATED', 401, message);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('PERMISSION_DENIED', 403, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'This action is not allowed.') {
    super('FORBIDDEN', 403, message);
  }
}

export class ReauthenticationRequiredError extends AppError {
  constructor() {
    super('REAUTHENTICATION_REQUIRED', 403, 'Please confirm your password to continue.');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super('NOT_FOUND', 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(
    code: ErrorCode = 'CONFLICT',
    message = 'The request conflicts with the current state.',
  ) {
    super(code, 409, message);
  }
}

export class ProtectedResourceError extends AppError {
  constructor(message: string) {
    super('PROTECTED_RESOURCE', 409, message);
  }
}

export class TooManyAttemptsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super('TOO_MANY_ATTEMPTS', 429, 'Too many attempts. Please wait and try again.', {
      retryAfterSeconds,
    });
  }
}

/** A session waiting for its second factor used any route other than the challenge (S7-15). */
export class MfaRequiredError extends AppError {
  constructor() {
    super('MFA_REQUIRED', 401, 'Enter your verification code to finish signing in.');
  }
}

/** The organization requires MFA for this user, who has not set it up yet (S7-27 B/C). */
export class MfaEnrollmentRequiredError extends AppError {
  constructor(
    message = 'This organization requires two-step verification. Set it up to continue.',
  ) {
    super('MFA_ENROLLMENT_REQUIRED', 403, message);
  }
}

/** MFA is required and set up, but this session has not satisfied it for the organization. */
export class MfaVerificationRequiredError extends AppError {
  constructor() {
    super(
      'MFA_VERIFICATION_REQUIRED',
      403,
      'Enter a verification code to continue in this organization.',
    );
  }
}

/** MFA management and security actions need a code entered within the step-up window (S7-33). */
export class MfaStepUpRequiredError extends AppError {
  constructor() {
    super('MFA_STEP_UP_REQUIRED', 403, 'Enter a verification code to confirm this change.');
  }
}

/** Deliberately generic: never says whether the code was expired, reused or wrong. */
export class InvalidMfaCodeError extends AppError {
  constructor() {
    super('INVALID_MFA_CODE', 400, 'That code is not valid. Check it and try again.');
  }
}

export class MfaChallengeFailedError extends AppError {
  constructor() {
    super('MFA_CHALLENGE_FAILED', 401, 'Too many incorrect codes. Sign in again.');
  }
}

export class MfaUnavailableError extends AppError {
  constructor() {
    super(
      'MFA_UNAVAILABLE',
      503,
      'Verification codes cannot be checked right now. Use a recovery code or try again later.',
    );
  }
}
