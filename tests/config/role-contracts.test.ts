import { describe, expect, it } from '@jest/globals';

import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { agentRoleSchema, agentRoleValues, skillTargetRoleSchema, skillTargetRoleValues } from '../../src/schemas/index.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

const sourceConfig = { providers: { test: { models: ['test/model'] } }, compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test/model' } }, card_processes: DEFAULT_CARD_PROCESSES };

describe('current role contracts', () => {
  it('keeps one exact four-role Agent authority and the independent three-role skill target subset', () => {
    expect(agentRoleValues).toEqual(['analyst', 'planner', 'executor', 'reviewer']);
    expect(agentRoleSchema.safeParse('content_supervisor').success).toBe(false);
    expect(skillTargetRoleValues).toEqual(['executor', 'reviewer', 'analyst']);
    expect(skillTargetRoleSchema.safeParse('planner').success).toBe(false);
  });

  it('preserves explicit valid direct keys equal to default and rejects unknown model role keys', () => {
    const parsed = saivageConfigSchema.parse({ ...sourceConfig, models: { default: ['test/model'], analyst: ['test/model'], planner: ['test/model'], executor: ['test/model'], reviewer: ['test/model'], max_tokens: { analyst: 200 } } });
    expect(parsed.models.analyst).toEqual(['test/model']);
    expect(saivageConfigSchema.safeParse({ ...sourceConfig, models: { default: ['test/model'], unknown_role: ['test/model'] } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ ...sourceConfig, models: { default: ['test/model'], routing: { content_supervisor: 'profile' } } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ ...sourceConfig, models: { default: ['test/model'], temperature: { unknown_role: 0.2 } } }).success).toBe(false);
  });
});
