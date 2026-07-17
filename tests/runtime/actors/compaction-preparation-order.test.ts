import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlanningCardProcessorActor } from '../../../src/runtime/actors/planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from '../../../src/runtime/actors/terminal-card-processor-actor.js';
import type { AutonomousCompactionPolicy } from '../../../src/runtime/actors/compaction/compactor.js';
import { initProjectTree, CardService } from '../../helpers/canonical-project.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import type { CardActivationInput } from '../../../src/runtime/actors/card-actor.js';
import type { InvocationSurface } from '../../../src/tools/invocation.js';
import { testCompactor, unusedSummarizerProvider } from '../../helpers/llm-test-helpers.js';

const roots: string[] = [];
const tooSmall: AutonomousCompactionPolicy = { input_budget_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('autonomous compaction preparation ordering', () => {
  it('fails planner and reviewer preparation before conversation I/O', () => {
    const { projectRoot, store } = project();
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider: { completeTurn: jest.fn() as never }, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged() {}, compactionConfig: tooSmall, compactor: testCompactor, summarizerProvider: unusedSummarizerProvider });
    const activation = input(store, 'project');
    const internal = actor as unknown as {
      buildLlmInput(input: CardActivationInput, surface: InvocationSurface): unknown;
      buildReviewerLlmInput(input: CardActivationInput, sessionId: string, currentness: unknown, surface: InvocationSurface): unknown;
    };

    expect(() => internal.buildLlmInput(activation, surface('planner'))).toThrow(/does not fit the compaction budget/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toEqual([]);
    expect(() => internal.buildReviewerLlmInput(activation, 'reviewer:project', {}, surface('reviewer'))).toThrow(/does not fit the compaction budget/);
    expect(readConversation(projectRoot, 'reviewer:project').physicalRows).toEqual([]);
  });

  it('fails executor preparation before conversation I/O', () => {
    const { projectRoot, store } = project();
    const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', brief: 'Implement', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const actor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, store, provider: { completeTurn: jest.fn() as never }, processRunner: createTestProcessRunner(projectRoot), conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged() {}, compactionConfig: tooSmall, compactor: testCompactor, summarizerProvider: unusedSummarizerProvider });
    const internal = actor as unknown as { buildLlmInput(input: CardActivationInput, surface: InvocationSurface): unknown };

    expect(() => internal.buildLlmInput(input(store, card.id), surface('executor'))).toThrow(/does not fit the compaction budget/);
    expect(readConversation(projectRoot, `executor:${card.id}`).physicalRows).toEqual([]);
  });
});

function project(): { projectRoot: string; store: CardService } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-prepare-order-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return { projectRoot, store: new CardService(projectRoot) };
}

function input(store: CardService, cardId: string): CardActivationInput {
  return { activationId: 'activation', card: store.read(cardId)!, caller: { kind: 'root' }, notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined }, claimResult: () => undefined };
}

function surface(role: InvocationSurface['role']): InvocationSurface {
  return { role, tools: new Map(), providers: [] };
}
