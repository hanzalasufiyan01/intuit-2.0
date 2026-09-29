/** Party master and organization profile API shapes (S4). */

export type PartyKind = 'organization' | 'individual';
export type PartyRole = 'customer' | 'vendor' | 'employee' | 'other';
export const PARTY_ROLES: PartyRole[] = ['customer', 'vendor', 'employee', 'other'];
export const ROLE_LABELS: Record<PartyRole, string> = {
  customer: 'Customer',
  vendor: 'Vendor',
  employee: 'Employee',
  other: 'Other',
};

export interface Country {
  code: string;
  name: string;
  isActive: boolean;
}

export interface PartySummary {
  id: string;
  kind: PartyKind;
  displayName: string;
  companyName: string | null;
  reference: string | null;
  tin: string | null;
  email: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  roles: PartyRole[];
  version: number;
}

export interface PartyContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  receivesDocuments: boolean;
}

export interface PartyAddress {
  id: string;
  kind: 'billing' | 'delivery';
  label: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
}

export interface DuplicateWarning {
  code: 'POSSIBLE_DUPLICATE';
  message: string;
  matches: { partyId: string; matchedOn: ('tin' | 'email' | 'name')[] }[];
}

export interface PartyDetail extends PartySummary {
  firstName: string | null;
  lastName: string | null;
  website: string | null;
  notes: string | null;
  contacts: PartyContact[];
  addresses: PartyAddress[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  warnings?: DuplicateWarning[];
}

export interface OrganizationAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

export interface OrganizationProfile {
  version: number;
  legalName: string | null;
  tradingName: string | null;
  tin: string | null;
  gstRegistered: boolean;
  gstRegistrationNumber: string | null;
  gstRegisteredFrom: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  identifiers: { scheme: string; value: string }[];
  registeredAddress: OrganizationAddress | null;
  businessAddress: OrganizationAddress | null;
  updatedAt: string | null;
  /** S5-12: managed through the logo endpoints. */
  logo: { fileId: string } | null;
}
