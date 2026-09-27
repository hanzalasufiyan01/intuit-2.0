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
  | 'TOO_MANY_ATTEMPTS';

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
