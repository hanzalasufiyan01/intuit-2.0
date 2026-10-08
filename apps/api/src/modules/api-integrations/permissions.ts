import type { PermissionDefinition } from '../access-control/index.js';

/**
 * The frozen v1 Public API permission keys (ADR 0011, D2 and section 19.3). There is no settings
 * permission and no per-organization API policy in v1. Managing integrations and tokens always
 * also needs a recent password confirmation (and MFA step-up where the organization's MFA policy
 * applies to the actor).
 */
export const ApiIntegrationPermissions = {
  TokensView: 'api_tokens.view',
  TokensManage: 'api_tokens.manage',
  WebhooksView: 'webhooks.view',
  WebhooksManage: 'webhooks.manage',
} as const;

/** The view keys a Member receives (Member stays view-only). */
export const apiIntegrationViewPermissions = [
  ApiIntegrationPermissions.TokensView,
  ApiIntegrationPermissions.WebhooksView,
] as const;

export const apiIntegrationPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: ApiIntegrationPermissions.TokensView,
    module: 'api_integrations',
    description: 'View API integrations and their tokens',
  },
  {
    key: ApiIntegrationPermissions.TokensManage,
    module: 'api_integrations',
    description: 'Create, change and revoke API integrations and tokens',
  },
  {
    key: ApiIntegrationPermissions.WebhooksView,
    module: 'api_integrations',
    description: 'View webhook endpoints and delivery history',
  },
  {
    key: ApiIntegrationPermissions.WebhooksManage,
    module: 'api_integrations',
    description: 'Create, change and disable webhook endpoints',
  },
];
