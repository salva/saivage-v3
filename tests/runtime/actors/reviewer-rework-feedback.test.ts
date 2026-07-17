import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../../src/cards/card-service.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import type { AgentMessage } from '../../../src/schemas/index.js';
import { PlanningCardProcessorActor } from '../../../src/runtime/actors/planning-card-processor-actor.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';

const CHILD = '11111111-1111-4111-8111-111111111111';
const REVIEW_SUMMARY = 'Add explicit remediation evidence before approval.';
const FEEDBACK = 'Reviewer requested rework at record:///review.md?card=project&v=1. Read it for required changes, update or create the necessary child cards, activate the rework, write record:///status.md?v=next, then call emit_result again when ready for review. Reviewer summary: Add explicit remediation evidence before approval.';
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function complete(result: LlmCompleteResult): ProviderTurnCompletion {
  return { result, provider_exchanges: [] };
}

function tool(id: string, name: string, args: object): LlmCompleteResult {
  return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

describe('accepted reviewer rework feedback', () => {
  it('durably hands one closed-review message to the next planner activation before finite remediation completes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-rework-feedback-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot, undefined, undefined, () => CHILD);
    const child = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Completed child', brief: 'Complete the child.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    store.setStatus(child.id, 'running');
    store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'Child complete.' }, error: null, completed_at: '2026-07-17T00:00:00.000Z' } });

    let plannerCalls = 0;
    let reviewerCalls = 0;
    let secondPlannerProjection: LlmInvocationInput['providerConversation'] | null = null;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.role === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1) return complete(tool('planner-write-1', 'write', { path: 'record:///status.md?v=next', content: 'Initial completion evidence.' }));
          if (plannerCalls === 2) return complete(tool('planner-done-1', 'emit_result', { status: 'done', summary: 'Initial submission.' }));
          if (plannerCalls === 3) {
            secondPlannerProjection = input.providerConversation;
            const feedback = input.providerConversation.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK);
            if (feedback.length !== 1) throw new Error(`Expected exactly one reviewer feedback row, received ${feedback.length}.`);
            return complete(tool('planner-write-2', 'write', { path: 'record:///status.md?v=next', content: 'Revised remediation evidence addressing the review.' }));
          }
          if (plannerCalls === 4) return complete(tool('planner-done-2', 'emit_result', { status: 'done', summary: 'Remediation complete.' }));
          throw new Error(`Unexpected planner provider call ${plannerCalls}.`);
        }

        reviewerCalls += 1;
        if (reviewerCalls === 1) return complete(tool('reviewer-write-1', 'write', { path: 'record:///review.md?v=next', content: 'Rework required: add explicit remediation evidence.' }));
        if (reviewerCalls === 2) return complete(tool('reviewer-rework', 'emit_result', { status: 'rework', summary: REVIEW_SUMMARY }));
        if (reviewerCalls === 3) {
          expect(store.readRecord('project', 'status.md', 'latest').artifact.content).toBe('Revised remediation evidence addressing the review.');
          return complete(tool('reviewer-write-2', 'write', { path: 'record:///review.md?v=next', content: 'Approved after remediation.' }));
        }
        if (reviewerCalls === 4) return complete(tool('reviewer-done', 'emit_result', { status: 'done', summary: 'Approved after remediation.' }));
        throw new Error(`Unexpected reviewer provider call ${reviewerCalls}.`);
      }),
    };
    const publishedRows: AgentMessage[] = [];
    const entryAppended = jest.fn((row: AgentMessage) => { publishedRows.push(row); });
    const actor = new PlanningCardProcessorActor({
      projectRoot,
      cardId: 'project',
      store,
      children: { get: () => null },
      cancelCard: async () => { throw new Error('unused'); },
      provider,
      conversations: { projectRoot },
      appLogs: testAppLogs(projectRoot),
      promptTemplates: createTestPromptTemplateRegistry(),
      runtimeProjectionChanged: () => undefined,
      conversationPublisher: { entryAppended },
    });
    actor.start();
    const claimResult = jest.fn();

    await expect(actor.activate({
      activationId: 'activation',
      card: store.read('project')!,
      caller: { kind: 'root' },
      notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined },
      claimResult,
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'done', result: { kind: 'done', summary: 'Approved after remediation.' } });

    expect(plannerCalls).toBe(4);
    expect(reviewerCalls).toBe(4);
    expect(provider.completeTurn).toHaveBeenCalledTimes(8);
    expect(claimResult).toHaveBeenCalledTimes(1);

    expect(secondPlannerProjection).not.toBeNull();
    expect(secondPlannerProjection!.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK)).toHaveLength(1);

    const plannerRows = readConversation(projectRoot, 'planner:project').physicalRows;
    const feedbackRows = plannerRows.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK);
    expect(feedbackRows).toHaveLength(1);
    const feedbackIndex = plannerRows.findIndex((row) => row.id === feedbackRows[0]!.id);
    const nextActivationIndex = plannerRows.findIndex((row, index) => index > feedbackIndex && row.kind === 'activity' && JSON.parse(row.content).event === 'activation_open');
    expect(nextActivationIndex).toBeGreaterThan(feedbackIndex);
    expect(publishedRows.filter((row) => row.id === feedbackRows[0]!.id && row.content === FEEDBACK)).toHaveLength(1);

    expect(store.readRecord('project', 'status.md', 1).artifact.content).toBe('Initial completion evidence.');
    expect(store.readRecord('project', 'status.md', 2).artifact.content).toBe('Revised remediation evidence addressing the review.');
    expect(store.readRecord('project', 'review.md', 1)).toMatchObject({ recordUrl: 'record:///review.md?card=project&v=1', artifact: { content: 'Rework required: add explicit remediation evidence.' } });
    expect(store.readRecord('project', 'review.md', 2)).toMatchObject({ recordUrl: 'record:///review.md?card=project&v=2', artifact: { content: 'Approved after remediation.' } });
    expect(store.read('project')).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'Approved after remediation.' } } });
  });
});
