import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';

import { cardProcessesSchema, type CardProcessesSource } from '../../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../../src/agents/default-card-processes.js';
import { cardProcessEntryForStatus, compileCardProcesses } from '../../../src/runtime/card-process/card-process-config.js';
import type { CardStatus } from '../../../src/schemas/index.js';
import { createProcessPromptRegistry } from '../../../src/runtime/card-process/process-prompt-registry.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function source(): CardProcessesSource {
  return cardProcessesSchema.parse(structuredClone(DEFAULT_CARD_PROCESSES));
}

function expectCompileFailure(change: (value: CardProcessesSource) => void, message: RegExp): void {
  const value = source();
  change(value);
  expect(() => compileCardProcesses(value)).toThrow(message);
}

describe('card process source and compilation', () => {
  it.each([
    ['backlog', 'BACKLOG'],
    ['running', null],
    ['blocked', 'BLOCKED'],
    ['changed', 'CHANGED'],
    ['stopped', 'STOPPED'],
    ['done', null],
    ['failed', null],
    ['cancelled', null],
  ] satisfies Array<[CardStatus, 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED' | null]>)('maps %s to its pre-running process entry', (status, entry) => {
    expect(cardProcessEntryForStatus(status)).toBe(entry);
  });

  it('compiles the authoritative graph with distinct entry and terminal BLOCKED namespaces', () => {
    const compiled = compileCardProcesses(source());
    expect(compiled.planning.states.get('entry:BLOCKED')).toEqual({ kind: 'entry', entry: 'BLOCKED' });
    expect(compiled.planning.states.get('terminal:BLOCKED')).toEqual({ kind: 'terminal', terminal: 'BLOCKED' });
    expect(compiled.planning.definition.states.get('node:plan')!.on.get('result:blocked')).toEqual({ target: 'terminal:BLOCKED', reenter: false });
    expect([...compiled.planning.definition.states.get('node:plan')!.on.keys()]).toEqual(['result:complete_direct', 'result:admit_review', 'result:blocked', 'result:failed', 'execution:failed']);
    expect((compiled.planning.states as Map<unknown, unknown>).set).toBeUndefined();
    expect((compiled.planning.definition.states as Map<unknown, unknown>).set).toBeUndefined();
    expect(compiled.planning.states.get('node:plan')).not.toHaveProperty('outcomes');
    expect(compiled.planning.states.get('node:plan')).not.toHaveProperty('edges');
  });

  it('requires exactly both families, all entries, strict tagged edge objects, and a STOPPED prompt', () => {
    const valid = structuredClone(DEFAULT_CARD_PROCESSES) as Record<string, any>;
    for (const mutation of [
      (v: any) => { delete v.planning; },
      (v: any) => { v.other = v.planning; },
      (v: any) => { delete v.planning.entries.CHANGED; },
      (v: any) => { v.planning.entries.INTERRUPTED = { node: 'plan' }; },
      (v: any) => { delete v.planning.entries.STOPPED.prompt; },
      (v: any) => { v.terminal.nodes.execute.edges.done = 'DONE'; },
      (v: any) => { v.terminal.nodes.execute.edges.done.target = {}; },
      (v: any) => { v.terminal.nodes.execute.edges.done.target = { node: 'execute', terminal: 'DONE' }; },
      (v: any) => { v.terminal.nodes.execute.edges.done.target = { terminal: 'UNKNOWN' }; },
      (v: any) => { v.terminal.nodes.execute.edges.done.prompt = 'not-consumed'; },
      (v: any) => { v.terminal.nodes.execute.counter = 1; },
      (v: any) => { v.terminal.nodes.execute.edges.done.action = 'shell'; },
      (v: any) => { v.terminal.nodes.execute.prompt_path = '../escape'; },
    ]) {
      const candidate = structuredClone(valid);
      mutation(candidate);
      const parsed = cardProcessesSchema.safeParse(candidate);
      if (parsed.success) expect(() => compileCardProcesses(parsed.data)).toThrow();
      else expect(parsed.success).toBe(false);
    }
    for (const name of ['card.json', 'unknown.md']) {
      const candidate = structuredClone(valid);
      candidate.planning.nodes.plan.records = [{ name, updated: false }];
      expect(cardProcessesSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects duplicate YAML node and outcome keys at configuration parsing', () => {
    const duplicateNode = YAML.parseDocument('card_processes:\n  planning:\n    nodes:\n      plan: {}\n      plan: {}\n');
    const duplicateOutcome = YAML.parseDocument('card_processes:\n  terminal:\n    nodes:\n      execute:\n        edges:\n          done: {}\n          done: {}\n');
    expect(duplicateNode.errors[0]?.message).toMatch(/Map keys must be unique/);
    expect(duplicateOutcome.errors[0]?.message).toMatch(/Map keys must be unique/);
  });

  it('rejects invalid identities, role/writer mismatches, duplicate records, missing targets, and graph defects', () => {
    expectCompileFailure((v) => { v.terminal.nodes.execute.prompt = '../escape'; }, /identifier/);
    expectCompileFailure((v) => { v.terminal.nodes.execute.role = 'planner'; }, /incompatible/);
    expectCompileFailure((v) => { v.planning.nodes.plan.records.push({ name: 'status.md', updated: false }); }, /duplicate/);
    expectCompileFailure((v) => { v.planning.nodes.plan.records = [{ name: 'review.md', updated: true }]; }, /unsupported record/);
    const plannerBrief = source();
    plannerBrief.planning.nodes.plan.records = [{ name: 'brief.md', updated: true }];
    expect(() => compileCardProcesses(plannerBrief)).not.toThrow();
    expectCompileFailure((v) => { v.planning.entries.BACKLOG.node = 'missing'; }, /missing node/);
    expectCompileFailure((v) => { v.planning.nodes.plan.edges.admit_review.target = { node: 'missing' }; }, /missing node/);
    expectCompileFailure((v) => {
      v.planning.nodes.orphan = structuredClone(v.planning.nodes.plan);
    }, /unreachable/);
    expectCompileFailure((v) => {
      v.terminal.nodes.execute.edges = { loop: { target: { node: 'execute' } } };
    }, /no path to a terminal/);
  });

  it('accepts cycles with a terminal path and reusable prompt identities in every reference position', () => {
    const value = source();
    value.terminal.entries.STOPPED.prompt = 'shared';
    value.terminal.nodes.execute.prompt = 'shared';
    value.terminal.nodes.execute.correction_prompt = 'shared';
    value.terminal.nodes.verify = {
      role: 'executor', prompt: 'shared', correction_prompt: 'shared', records: [],
      edges: { again: { target: { node: 'execute' }, prompt: 'shared' }, done: { target: { terminal: 'DONE' } } },
    };
    value.terminal.nodes.execute.edges.done = { target: { node: 'verify' }, prompt: 'shared' };
    const compiled = compileCardProcesses(value);
    expect(compiled.terminal.definition.states.get('node:verify')!.on.get('result:again')).toEqual({ target: 'node:execute', reenter: false });
    expect(compiled.terminal.transitionPrompts.values().next().value).toBeDefined();
  });

  it('compiles same-node outcomes as explicit external reentry without prompt topology duplication', () => {
    const value = source();
    value.terminal.nodes.execute.edges.again = { target: { node: 'execute' }, prompt: 'implementation-to-verification' };
    const process = compileCardProcesses(value).terminal;
    expect(process.definition.states.get('node:execute')!.on.get('result:again')).toEqual({ target: 'node:execute', reenter: true });
    expect(process.transitionPrompts.get('12:node:executeresult:again')).toBe('implementation-to-verification');
    expect(process.transitionPrompts.get('12:node:executeresult:again')).not.toEqual(expect.objectContaining({ target: expect.anything() }));
  });
});

describe('ProcessPromptRegistry', () => {
  it('preloads exact bundled artifacts, uses an exact override, and caches reusable references', () => {
    const overrideRoot = mkdtempSync(join(tmpdir(), 'saivage-process-overrides-'));
    roots.push(overrideRoot);
    const path = join(overrideRoot, 'goal', 'process', 'plan.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'Project-specific plan instruction.');
    const registry = createProcessPromptRegistry(compileCardProcesses(source()), { defaultRoot: 'src/prompts', overrideRoot });
    expect(registry.get('goal', 'plan' as any)).toBe('Project-specific plan instruction.');
    expect(registry.get('project', 'plan' as any)).toContain('current planning step');
    expect(registry.get('goal', 'correct-plan-result' as any)).toBe(registry.get('goal', 'correct-plan-result' as any));
  });

  it('fails on a missing referenced artifact without scanning or accepting a configured path', () => {
    const value = source();
    value.terminal.nodes.execute.prompt = 'missing-artifact';
    expect(() => createProcessPromptRegistry(compileCardProcesses(value), { defaultRoot: 'src/prompts' })).toThrow(/architecture\/missing-artifact.*missing effective artifact/);
  });
});
