import type { SaivageConfig } from '../agents/config-api.js';

export function resolveModelListForRole(config: SaivageConfig, role: string): string[] | null {
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
