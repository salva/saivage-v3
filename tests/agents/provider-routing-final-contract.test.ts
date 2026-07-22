import { describe, expect, it } from '@jest/globals';

import { saivageConfigSchema, getModelParamsForRole } from '../../src/schemas/saivage-config.js';
import { Account, Provider, ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { buildProviderRoutingReadModel } from '../../src/agents/provider-routing-read-model.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

function config() {
  return saivageConfigSchema.parse({
    models: { planner: ['m1', 'm2'], default: ['m1'], temperature: { default: 0.2, planner: 0.1 }, max_tokens: { default: 100, planner: 200 }, equivalents: [['m1', 'm1-equivalent']], failover: { m2: ['m3'] } },
    providers: {
      first: { priority: 10, models: ['m1', 'm2'], capabilities: { contextWindowTokens: 1000 }, accounts: { primary: { priority: 10 }, secondary: { priority: 20, models: ['m2'] } }, modelCapabilities: { m1: { maxOutputTokens: 300 } } },
      second: { priority: 20, models: ['m1-equivalent', 'm3'] },
    },
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'first', account: 'primary', model: 'm1' } },
    card_processes: DEFAULT_CARD_PROCESSES,
  });
}

describe('final provider/model routing authority', () => {
  it('keeps candidate identity, provider/account/model precedence, and route order singular', async () => {
    const cfg = config();
    const registry = new ProviderRegistry(cfg);
    const route = await new ModelRouter(cfg, registry).resolve('planner');
    expect(route).toEqual([
      { provider: 'first', account: 'primary', model: 'm1' },
      { provider: 'second', account: null, model: 'm1-equivalent' },
      { provider: 'first', account: 'primary', model: 'm2' },
      { provider: 'first', account: 'secondary', model: 'm2' },
      { provider: 'second', account: null, model: 'm3' },
    ]);
    expect(registry.getEffectiveCapabilities(route[0]!)).toMatchObject({ contextWindowTokens: 1000, maxOutputTokens: 300 });
    expect(getModelParamsForRole(cfg, 'planner')).toEqual({ temperature: 0.1, maxTokens: 200 });
  });

  it('keeps implicit and sentinel-shaped explicit accounts distinct with slash-bearing models', () => {
    const implicit = new Provider('implicit', { models: ['org/summary/model'] });
    expect(implicit.getCandidatesForModel('org/summary/model')).toEqual([{ provider: 'implicit', account: null, model: 'org/summary/model' }]);
    const explicit = new Provider('explicit', { models: ['org/summary/model'], accounts: { _implicit: {}, _: {} } });
    expect(explicit.getCandidatesForModel('org/summary/model')).toEqual([
      { provider: 'explicit', account: '_implicit', model: 'org/summary/model' },
      { provider: 'explicit', account: '_', model: 'org/summary/model' },
    ]);
    const availability = new MemoryCandidateAvailability();
    const [implicitCandidate] = implicit.getCandidatesForModel('org/summary/model');
    const [namedImplicit, namedUnderscore] = explicit.getCandidatesForModel('org/summary/model');
    availability.markFailed(implicitCandidate!, { state: 'COOLING', untilMs: Date.now() + 1000, reason: 'implicit' });
    availability.markFailed(namedImplicit!, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 2000, reason: 'named' });
    availability.markSucceeded(namedUnderscore!);
    expect(availability.getEntry(implicitCandidate!)).toMatchObject({ reason: 'implicit' });
    expect(availability.getEntry(namedImplicit!)).toMatchObject({ reason: 'named' });
    expect(availability.getEntry(namedUnderscore!)).toMatchObject({ state: 'HEALTHY' });
  });

  it('enforces account model subsets and rejects unknown provider/account authority', () => {
    const account = new Account('only-m2', { models: ['m2'] });
    expect(account.canServe('m1', new Set(['m1', 'm2']))).toBe(false);
    expect(account.canServe('m2', new Set(['m1', 'm2']))).toBe(true);
    const provider = new Provider('p', { models: ['m1'], accounts: { a: {} } });
    expect(provider.getCandidatesForModel('m1')).toEqual([{ provider: 'p', account: 'a', model: 'm1' }]);
    expect(provider.getCandidatesForModel('m2')).toEqual([]);
    const registry = new ProviderRegistry(config());
    expect(() => registry.getEffectiveCapabilities({ provider: 'missing', account: null, model: 'm1' })).toThrow(/unknown provider/);
    expect(() => registry.getEffectiveCapabilities({ provider: 'first', account: 'missing', model: 'm1' })).toThrow(/unknown account/);
  });

  it('projects process-local availability without changing configured routing authority', async () => {
    const cfg = config();
    const registry = new ProviderRegistry(cfg);
    const route = await new ModelRouter(cfg, registry).resolve('planner');
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(route[0]!, { state: 'COOLING', untilMs: Date.now() + 60_000, reason: 'quota' });
    expect((await new ModelRouter(cfg, registry).resolve('planner'))[0]).toEqual(route[0]);
    const readModel = buildProviderRoutingReadModel({ registry, availability });
    expect(JSON.stringify(readModel)).toContain('COOLING');
  });

  it('rejects removed autonomous round limits and unknown provider capability fields', () => {
    expect(saivageConfigSchema.safeParse({ models: { default: ['m'] }, runtime: { max_review_retries: 3 } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models: { default: ['m'] }, providers: { p: { models: ['m'], capabilities: { contextWindowTokens: 1000, invented: true } } } }).success).toBe(false);
  });
});
