import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { CardService } from '../helpers/canonical-project.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const REVIEW_SUMMARY = 'Add explicit remediation evidence before approval.';
const FEEDBACK = 'Previous process node: review\nAccepted outcome: revision_required\nSummary: Add explicit remediation evidence before approval.\nRecords:\n- record:///review.md?card=project&v=1\n\ntest process prompt: review-to-plan';
const REVISED_EVIDENCE = 'Revised remediation evidence addressing the concrete review.';
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}

describe('reviewer rework completion E2E', () => {
  it('delivers durable review feedback through ordinary planner projection and completes after one rework', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-rework-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Completed child', bootstrap_content: 'Complete the child.', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(child.id, 'running');
    cards.commitActivationOutcome(child.id, { status: 'done', summary: 'Child complete.', result: workflowResult('DONE','Child complete.') }, '2026-07-17T00:00:00.000Z');

    let plannerCalls = 0;
    let reviewerCalls = 0;
    let remediationProjection: LlmInvocationInput['providerConversation'] | null = null;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.agentName === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1) return complete(tool('planner-write-initial', 'write', { path: 'record:///status.md?v=next', content: 'Initial completion evidence.' }));
          if (plannerCalls === 2) return complete(tool('planner-done-initial', 'emit_result', { outcome: 'admit_review', summary: 'Initial submission.' }));
          if (plannerCalls === 3) {
            remediationProjection = input.providerConversation;
            const feedbackRows = input.providerConversation.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK);
            if (feedbackRows.length !== 1) throw new Error(`Expected one projected reviewer feedback row, received ${feedbackRows.length}.`);
            return complete(tool('planner-write-revised', 'write', { path: 'record:///status.md?v=next', content: REVISED_EVIDENCE }));
          }
          if (plannerCalls === 4) return complete(tool('planner-done-revised', 'emit_result', { outcome: 'admit_review', summary: 'Concrete remediation complete.' }));
          throw new Error(`Unexpected planner provider call ${plannerCalls}.`);
        }

        reviewerCalls += 1;
        if (reviewerCalls === 1) return complete(tool('reviewer-write-rework', 'write', { path: 'record:///review.md?v=next', content: 'Rework required: add explicit remediation evidence.' }));
        if (reviewerCalls === 2) return complete(tool('reviewer-request-rework', 'emit_result', { outcome: 'revision_required', summary: REVIEW_SUMMARY }));
        if (reviewerCalls === 3) {
          if (cards.readRecord('project', 'status.md', 'latest').artifact.content !== REVISED_EVIDENCE) throw new Error('Reviewer did not observe revised remediation evidence.');
          return complete(tool('reviewer-write-done', 'write', { path: 'record:///review.md?v=next', content: 'Approved after concrete remediation.' }));
        }
        if (reviewerCalls === 4) return complete(tool('reviewer-done', 'emit_result', { outcome: 'approved', summary: 'Approved after concrete remediation.' }));
        throw new Error(`Unexpected reviewer provider call ${reviewerCalls}.`);
      }),
    };
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
    const runtime = new SupervisorRuntimeApi({
      ...testAutonomousCompaction,
      projectRoot,
      actorStore: cards,
      interventionBinding: new RuntimeInterventionBinding(),
      provider,
      conversations: { projectRoot },
      freshness: { runtimeChanged() {}, agentsChanged() {}, conversationChanged() {} },
      processRunner: new ProcessRunner(projectRoot, processRegistry),
      runtimeProcessRootScope,
      promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await runtime.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    runtime.launchStartedProject(prepared.launch);
    await waitUntil(() => runtime.getStatus().status === 'stopped');

    expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(runtime.getRuntimeState()).toBeNull();
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { kind: 'workflow-result', summary: 'Approved after concrete remediation.' } } });
    expect(plannerCalls).toBe(4);
    expect(reviewerCalls).toBe(4);
    expect(provider.completeTurn).toHaveBeenCalledTimes(8);

    expect(remediationProjection).not.toBeNull();
    expect(remediationProjection!.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK)).toHaveLength(1);
    const plannerRows = readConversation(projectRoot, 'agent:planner:project').physicalRows;
    expect(plannerRows.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK)).toHaveLength(1);
    expect(cards.readRecord('project', 'status.md', 2).artifact.content).toBe(REVISED_EVIDENCE);
    expect(cards.readRecord('project', 'review.md', 1)).toMatchObject({ recordUrl: 'record:///review.md?card=project&v=1', artifact: { content: 'Rework required: add explicit remediation evidence.' } });
    expect(cards.readRecord('project', 'review.md', 2)).toMatchObject({ recordUrl: 'record:///review.md?card=project&v=2', artifact: { content: 'Approved after concrete remediation.' } });
  });
});
