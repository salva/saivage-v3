import type { SaivageConfig, AgentRole } from '../agents/index.js';

export const REQUIRED_ROLES = ['planner', 'executor', 'reviewer', 'analyst'] as const satisfies readonly AgentRole[];

export type ValidateModelRolesResult =
  | { ok: true; configuredRoles: Record<AgentRole, string[]> }
  | { ok: false; missingRoles: AgentRole[]; configuredRoles: Partial<Record<AgentRole, string[]>> };

export function validateModelRoles(config: SaivageConfig): ValidateModelRolesResult {
  const models = config.models;
  const defaultList = Array.isArray(models.default) && models.default.length > 0 ? models.default : null;
  const profiles = models.profiles ?? {};
  const routing = models.routing ?? {};

  const configuredRoles: Partial<Record<AgentRole, string[]>> = {};
  const missingRoles: AgentRole[] = [];

  for (const role of REQUIRED_ROLES) {
    const direct = (models as Record<string, unknown>)[role];
    if (Array.isArray(direct) && direct.length > 0) {
      configuredRoles[role] = direct as string[];
      continue;
    }
    const profileName = routing[role];
    const profile = profileName ? profiles[profileName] : undefined;
    if (profile) {
      const merged = [...profile.preferred, ...profile.allowed];
      if (merged.length > 0) {
        configuredRoles[role] = merged;
        continue;
      }
    }
    if (defaultList) {
      configuredRoles[role] = defaultList;
      continue;
    }
    missingRoles.push(role);
  }

  if (missingRoles.length > 0) return { ok: false, missingRoles, configuredRoles };
  return { ok: true, configuredRoles: configuredRoles as Record<AgentRole, string[]> };
}
