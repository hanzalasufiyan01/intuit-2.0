/** API response shapes (mirrors apps/api responses). */

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
  emailVerified: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  membershipId: string;
}

export interface ActiveOrganization extends OrganizationSummary {
  isOwner: boolean;
  permissions: string[];
}

export type MfaRequirementReason = 'owner' | 'privileged_permission' | 'organization_policy';

/** How the session stands with two-step verification (S7-24). */
export interface SessionMfa {
  enrolled: boolean;
  method: 'totp' | 'recovery_code' | 'trusted_device' | null;
  stepUpValidUntil: string | null;
  recoveryCodesRemaining: number | null;
  activeOrganization: {
    required: boolean;
    reasons: MfaRequirementReason[];
    satisfied: boolean;
    trustedDevicesAllowed: boolean;
  } | null;
}

/** A sign-in waiting for its verification code (S7-14): nothing else is available yet. */
export interface PendingMfaSession {
  authentication: 'mfa_required';
  user: { email: string; displayName: string };
  methods: ('totp' | 'recovery_code')[];
  expiresAt: string;
  csrfToken: string;
}

export interface SessionState {
  authentication: 'complete';
  user: UserProfile;
  session: {
    id: string;
    createdAt: string;
    expiresAt: string;
    idleExpiresAt: string;
    reauthenticatedAt: string;
    reauthenticationValidUntil: string;
  };
  organizations: OrganizationSummary[];
  activeOrganization: ActiveOrganization | null;
  mfa: SessionMfa;
  csrfToken: string;
}

export type AnySession = SessionState | PendingMfaSession;

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  status: 'active' | 'disabled';
  isOwner: boolean;
  roles: { id: string; name: string; isOwner: boolean }[];
  joinedAt: string;
  /** Present only for members.manage holders (S7-39). */
  mfa?: { enrolled: boolean; required: boolean };
}

export interface Role {
  id: string;
  name: string;
  description: string;
  templateKey: string | null;
  isSystem: boolean;
  isOwner: boolean;
  permissionKeys: string[];
  memberCount?: number;
}

export interface Invitation {
  id: string;
  email: string;
  roleId: string;
  roleName?: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  roleName: string | null;
  invitedBy: string | null;
  status: Invitation['status'];
  expiresAt: string;
  accountExists: boolean;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
}

export interface MfaStatus {
  factors: {
    id: string;
    type: 'totp';
    label: string | null;
    createdAt: string;
    activatedAt: string | null;
    lastUsedAt: string | null;
  }[];
  recoveryCodes: { remaining: number; issuedAt: string | null };
  requiredBy: { organizationId: string; name: string; reasons: MfaRequirementReason[] }[];
  canDisable: boolean;
}

export interface MfaEnrollment {
  enrollmentId: string;
  secret: string;
  otpauthUri: string;
  qrCode: string;
  issuer: string;
  account: string;
  expiresAt: string;
}

export interface TrustedDevice {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface SecurityPolicy {
  requireMfaForAllMembers: boolean;
  allowTrustedDevices: boolean;
  version: number;
  updatedAt: string | null;
  members?: { total: number; enrolled: number; requiredNotEnrolled: number };
}
