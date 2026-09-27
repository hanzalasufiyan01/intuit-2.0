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

export interface SessionState {
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
  csrfToken: string;
}

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  status: 'active' | 'disabled';
  isOwner: boolean;
  roles: { id: string; name: string; isOwner: boolean }[];
  joinedAt: string;
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
