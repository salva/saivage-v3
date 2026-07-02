import type { SaivageConfig } from '../agents/config-api.js';
import { operationalAgentRoleValues } from '../schemas/index.js';
import type { OperationalAgentRole } from '../schemas/index.js';
import { resolveModelListForRole } from './model-role-resolution.js';

export const REQUIRED_ROLES = operationalAgentRoleValues;

export type ValidateModelRolesResult =
  | { ok: true; configuredRoles: Record<OperationalAgentRole, string[]> }
  | { ok: false; missingRoles: OperationalAgentRole[]; configuredRoles: Partial<Record<OperationalAgentRole, string[]>> };

export function validateModelRoles(config: SaivageConfig): ValidateModelRolesResult {
  const configuredRoles: Partial<Record<OperationalAgentRole, string[]>> = {};
  const missingRoles: OperationalAgentRole[] = [];

  for (const role of REQUIRED_ROLES) {
    const models = resolveModelListForRole(config, role);
    if (models) {
      configuredRoles[role] = models;
      continue;
    }
    missingRoles.push(role);
  }

  if (missingRoles.length > 0) return { ok: false, missingRoles, configuredRoles };
  return { ok: true, configuredRoles: configuredRoles as Record<OperationalAgentRole, string[]> };
}
