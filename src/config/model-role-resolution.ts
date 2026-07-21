import type { SaivageConfig } from '../agents/config-api.js';
import type { AgentRole } from '../schemas/index.js';

export function resolveModelListForRole(config: SaivageConfig, role: AgentRole): string[] | null {
  const models = config.models;
  const direct = (models as Record<string, unknown>)[role];
  if (Array.isArray(direct) && direct.length > 0) return direct as string[];

  const profileName = models.routing?.[role];
  const profile = profileName ? models.profiles?.[profileName] : undefined;
  if (profile) {
    const merged = [...profile.preferred, ...profile.allowed];
    if (merged.length > 0) return merged;
  }

  const fallback = models.default;
  if (Array.isArray(fallback) && fallback.length > 0) return fallback;
  return null;
}

export function getModelListForRole(config: SaivageConfig, role: AgentRole): string[] {
  const resolved = resolveModelListForRole(config, role);
  if (resolved) return resolved;

  throw new Error(`No model list configured for role '${role}' and no default.`);
}
