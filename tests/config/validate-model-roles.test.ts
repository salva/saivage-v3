import { describe, it, expect } from '@jest/globals';
import { validateModelRoles, REQUIRED_ROLES } from '../../src/config/validate-model-roles.js';
import { getModelListForRole } from '../../src/config/model-role-resolution.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';

function makeConfig(models: Record<string, unknown>): SaivageConfig {
  return { models, providers: {}, runtime: {} } as unknown as SaivageConfig;
}

describe('validateModelRoles', () => {
  it('returns ok with configuredRoles when every role is directly populated', () => {
    const res = validateModelRoles(makeConfig({
      planner: ['gpt-4.1'],
      executor: ['gpt-4.1-mini'],
      reviewer: ['gpt-4o'],
      analyst: ['gpt-4o-mini'],
    }));
    expect(res).toEqual({
      ok: true,
      configuredRoles: {
        planner: ['gpt-4.1'],
        executor: ['gpt-4.1-mini'],
        reviewer: ['gpt-4o'],
        analyst: ['gpt-4o-mini'],
      },
    });
  });

  it('returns missingRoles for every required role when models is empty', () => {
    const res = validateModelRoles(makeConfig({}));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missingRoles).toEqual(['analyst', 'planner', 'executor', 'reviewer']);
    expect(res.configuredRoles).toEqual({});
  });

  it('uses models.default as fallback to satisfy every role', () => {
    const res = validateModelRoles(makeConfig({ default: ['gpt-4.1'] }));
    expect(res).toEqual({
      ok: true,
      configuredRoles: {
        planner: ['gpt-4.1'],
        executor: ['gpt-4.1'],
        reviewer: ['gpt-4.1'],
        analyst: ['gpt-4.1'],
      },
    });
  });

  it('uses the same precedence as getModelListForRole', () => {
    const config = makeConfig({
      default: ['default-model'],
      planner: ['direct-model'],
      profiles: { heavy: { preferred: ['profile-preferred'], allowed: ['profile-allowed'] } },
      routing: { planner: 'heavy', executor: 'heavy' },
    });

    const res = validateModelRoles(config);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.configuredRoles.planner).toEqual(['direct-model']);
    expect(getModelListForRole(config, 'planner')).toEqual(['direct-model']);
    expect(res.configuredRoles.executor).toEqual(['profile-preferred', 'profile-allowed']);
    expect(getModelListForRole(config, 'executor')).toEqual(['profile-preferred', 'profile-allowed']);
    expect(res.configuredRoles.reviewer).toEqual(['default-model']);
    expect(getModelListForRole(config, 'reviewer')).toEqual(['default-model']);
  });

  it('treats an empty direct array as unset', () => {
    const res = validateModelRoles(makeConfig({
      planner: [],
      executor: ['x'],
      reviewer: ['x'],
      analyst: ['x'],
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missingRoles).toEqual(['planner']);
  });

  it('satisfies a role via routing profile preferred', () => {
    const res = validateModelRoles(makeConfig({
      planner: ['p'],
      reviewer: ['r'],
      analyst: ['a'],
      profiles: { fast: { preferred: ['gpt-5'], allowed: [] } },
      routing: { executor: 'fast' },
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.configuredRoles.executor).toEqual(['gpt-5']);
  });

  it('keeps a role missing when routing profile has empty preferred and allowed', () => {
    const res = validateModelRoles(makeConfig({
      planner: ['p'],
      reviewer: ['r'],
      analyst: ['a'],
      profiles: { empty: { preferred: [], allowed: [] } },
      routing: { executor: 'empty' },
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missingRoles).toEqual(['executor']);
  });

  it('reports only the unsatisfied roles when one is directly set and no default exists', () => {
    const res = validateModelRoles(makeConfig({ planner: ['gpt-4.1'] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missingRoles).toEqual(['analyst', 'executor', 'reviewer']);
    expect(res.configuredRoles).toEqual({ planner: ['gpt-4.1'] });
  });

  it('exposes the four required roles in a stable order', () => {
    expect([...REQUIRED_ROLES]).toEqual(['analyst', 'planner', 'executor', 'reviewer']);
  });
});
