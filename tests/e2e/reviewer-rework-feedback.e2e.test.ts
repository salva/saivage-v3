import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { CardService } from '../helpers/canonical-project.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import type { AgentMembershipFreshnessTarget } from '../../src/application/freshness-effects.js';

const REVIEW_SUMMARY = 'Add explicit remediation evidence before approval.';
const FEEDBACK = 'Previous process node: review\nAccepted outcome: revision_required\nSummary: Add explicit remediation evidence before approval.\nRecords:\n- record:///review.md?card=project&v=3\n\nThe Reviewer requires revision. Address the immediately preceding findings and update the `project` card evidence before selecting the next route.\n';
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
    const providerTurn = jest.fn(async (input: LlmInvocationInput) => {
        if (input.agentName === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1) return complete(tool('planner-write-initial', 'write', { path: 'record:///status.md?card=project', content: 'Initial completion evidence.' }));
          if (plannerCalls === 2) return complete(tool('planner-done-initial', 'emit_result', { outcome: 'admit_review', summary: 'Initial submission.' }));
          if (plannerCalls === 3) {
            remediationProjection = input.providerConversation;
            const feedbackRows = input.providerConversation.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK);
            if (feedbackRows.length !== 1) throw new Error(`Expected one projected reviewer feedback row, received ${feedbackRows.length}.`);
            return complete(tool('planner-write-revised', 'write', { path: 'record:///status.md?card=project', content: REVISED_EVIDENCE }));
          }
          if (plannerCalls === 4) return complete(tool('planner-done-revised', 'emit_result', { outcome: 'admit_review', summary: 'Concrete remediation complete.' }));
          throw new Error(`Unexpected planner provider call ${plannerCalls}.`);
        }

        reviewerCalls += 1;
        if (reviewerCalls === 1) return complete(tool('reviewer-write-rework', 'write', { path: 'record:///review.md?card=project', content: 'Rework required: add explicit remediation evidence.' }));
        if (reviewerCalls === 2) return complete(tool('reviewer-request-rework', 'emit_result', { outcome: 'revision_required', summary: REVIEW_SUMMARY }));
        if (reviewerCalls === 3) {
          const status=cards.readRecordCurrent('project','status.md');if(status.kind!=='found'||status.value.projection?.artifact.accepted?.content !== REVISED_EVIDENCE) throw new Error('Reviewer did not observe revised remediation evidence.');
          return complete(tool('reviewer-write-free-notes', 'write', { path: 'record:///review-notes-1.md?card=project', content: 'Initial wildcard note.' }));
        }
        if (reviewerCalls === 4) return complete(tool('reviewer-edit-free-notes', 'edit', { path: 'record:///review-notes-1.md?card=project', old_string: 'Initial wildcard note.', new_string: 'Repeatedly edited wildcard note.' }));
        if (reviewerCalls === 5) return complete(tool('reviewer-write-done', 'write', { path: 'record:///review.md?card=project', content: 'Approved after concrete remediation.' }));
        if (reviewerCalls === 6) return complete(tool('reviewer-done', 'emit_result', { outcome: 'approved', summary: 'Approved after concrete remediation.' }));
        throw new Error(`Unexpected reviewer provider call ${reviewerCalls}.`);
      });
    const provider: LLMProviderPort = scriptedAdmissionProvider(providerTurn);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
    const membershipRecords: Array<{ target: AgentMembershipFreshnessTarget; liveIds: string[] }> = [];
    let runtime!: ReturnType<typeof createSupervisorRuntimeApi>;
    runtime = createSupervisorRuntimeApi({
      fatalPort: testApplicationFatalPort,
      ...testAutonomousCompaction,
      runtimeGate: new RuntimeGate(),
      projectRoot,
      actorStore: cards,
      provider,
      conversations: { projectRoot },
      freshness: {
        runtimeChanged() {},
        agentMembershipChanged(target) {
          membershipRecords.push({
            target,
            liveIds: [...runtime.captureAutonomousExecutingLlmSnapshots().keys()],
          });
        },
      },
      processRunner: new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort),
      runtimeProcessRootScope,
      promptTemplates: { render: () => 'test prompt' },
    });

    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    await waitUntil(() => runtime.getStatus().status === 'stopped');

    expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(runtime.getRuntimeState()).toBeNull();
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { kind: 'workflow-result', summary: 'Approved after concrete remediation.' } } });
    expect(plannerCalls).toBe(4);
    expect(reviewerCalls).toBe(6);
    expect(providerTurn).toHaveBeenCalledTimes(10);
    expect(membershipRecords.length).toBeGreaterThan(0);
    expect(new Set(membershipRecords.map(({ target }) => target.scope))).toEqual(new Set(['card']));
    expect(new Set(membershipRecords.map(({ target }) => target.scope === 'card' ? target.cardId : target.sessionId))).toEqual(new Set(['project']));
    expect(membershipRecords.some(({ liveIds }) => liveIds.includes('agent:planner:project'))).toBe(true);
    expect(membershipRecords.some(({ liveIds }) => liveIds.includes('agent:reviewer:project'))).toBe(true);
    expect(membershipRecords.some(({ liveIds }) => liveIds.length === 0)).toBe(true);

    expect(remediationProjection).not.toBeNull();
    expect(remediationProjection!.messages.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK)).toHaveLength(1);
    const plannerRows = readConversation(projectRoot, 'agent:planner:project').physicalRows;
    expect(plannerRows.filter((row) => row.role === 'user' && row.kind === 'text' && row.content === FEEDBACK)).toHaveLength(1);
    expect(cards.readRecordVersion('project','status.md',6)).toMatchObject({kind:'found',value:{projection:{artifact:{accepted:{content:REVISED_EVIDENCE}}}}});
    expect(cards.readRecordVersion('project','review.md',2)).toMatchObject({kind:'found',value:{projection:{versionUrl:'record:///review.md?card=project&v=2',artifact:{draft:{content:'Rework required: add explicit remediation evidence.'}}}}});
    expect(cards.readRecordVersion('project','review.md',6)).toMatchObject({kind:'found',value:{projection:{artifact:{accepted:{content:'Approved after concrete remediation.'}}}}});
    expect(cards.readRecordCurrent('project','review-notes-1.md')).toMatchObject({kind:'found',value:{projection:{artifact:{state:'closed',accepted:{content:'Repeatedly edited wildcard note.',writer_agent:'reviewer'}}}}});
  });

  it('lets the owning goal Planner reopen the same completed child for reviewed correction', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-child-reopen-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'Reviewed goal', bootstrap_content: 'Deliver the implementation and correct review findings.', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const implementation = cards.create({ type: 'code', parent: goal.id, title: 'Implementation', bootstrap_content: 'Implement the reviewed behavior.', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const correction = 'Correction required: preserve the explicit cleanup guarantee when finalization throws.';
    const firstReview = 'Revision required: prove cleanup still closes the resource when finalization throws.';
    const approvedReview = 'Approved: corrected implementation demonstrates the required cleanup guarantee.';

    let rootPlannerCalls = 0;
    let goalPlannerCalls = 0;
    let executorCalls = 0;
    let reviewerCalls = 0;
    let rootGrandchildReopenResult: unknown;
    let goalReviewContext: string | undefined;
    let correctedExecutorInput: LlmInvocationInput | undefined;
    const observedImplementationStatuses: string[] = [];
    const plannerToolMenus: string[][] = [];
    const implementationInputs: LlmInvocationInput[] = [];

    const providerTurn = jest.fn(async (input: LlmInvocationInput) => {
      if (input.sessionId === 'agent:planner:project') {
        rootPlannerCalls += 1;
        plannerToolMenus.push(input.tools.map((definition) => definition.function.name));
        if (rootPlannerCalls === 1) return complete(tool('root-activate-goal', 'activate_card', { card_id: goal.id }));
        if (rootPlannerCalls === 2) return complete(tool('root-reopen-grandchild', 'reopen_card', { card_id: implementation.id }));
        if (rootPlannerCalls === 3) {
          const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'root-reopen-grandchild');
          rootGrandchildReopenResult = row ? JSON.parse(row.content) : null;
          return complete(tool('root-status', 'write', { path: 'record:///status.md?card=project', content: 'Reviewed goal and corrected implementation are complete.' }));
        }
        if (rootPlannerCalls === 4) return complete(tool('root-complete', 'emit_result', { outcome: 'complete_direct', summary: 'Project completed after owned correction.' }));
        throw new Error(`Unexpected root Planner call ${rootPlannerCalls}.`);
      }

      if (input.sessionId === `agent:planner:${goal.id}`) {
        goalPlannerCalls += 1;
        plannerToolMenus.push(input.tools.map((definition) => definition.function.name));
        if (goalPlannerCalls === 1) return complete(tool('goal-activate-initial', 'activate_card', { card_id: implementation.id }));
        if (goalPlannerCalls === 2) return complete(tool('goal-status-initial', 'write', { path: `record:///status.md?card=${goal.id}`, content: 'Initial implementation is ready for review.' }));
        if (goalPlannerCalls === 3) return complete(tool('goal-review-initial', 'emit_result', { outcome: 'admit_review', summary: 'Review the initial implementation.' }));
        if (goalPlannerCalls === 4) {
          goalReviewContext = input.providerConversation.messages.find((message) => message.role === 'user' && message.kind === 'text' && message.content.includes(firstReview))?.content;
          observedImplementationStatuses.push(cards.read(implementation.id)!.lifecycle.status);
          return complete(tool('goal-reopen-child', 'reopen_card', { card_id: implementation.id }));
        }
        if (goalPlannerCalls === 5) {
          observedImplementationStatuses.push(cards.read(implementation.id)!.lifecycle.status);
          return complete(tool('goal-queue-correction', 'queue_notification', { card_id: implementation.id, kind: 'review_correction', body: correction }));
        }
        if (goalPlannerCalls === 6) return complete(tool('goal-activate-correction', 'activate_card', { card_id: implementation.id }));
        if (goalPlannerCalls === 7) return complete(tool('goal-status-corrected', 'write', { path: `record:///status.md?card=${goal.id}`, content: 'The same implementation child completed the requested correction.' }));
        if (goalPlannerCalls === 8) return complete(tool('goal-review-corrected', 'emit_result', { outcome: 'admit_review', summary: 'Review the corrected implementation.' }));
        throw new Error(`Unexpected goal Planner call ${goalPlannerCalls}.`);
      }

      if (input.sessionId === `agent:executor:${implementation.id}`) {
        executorCalls += 1;
        implementationInputs.push(input);
        if (executorCalls === 1) return complete(tool('implementation-status-initial', 'write', { path: `record:///status.md?card=${implementation.id}`, content: 'Initial implementation completed without explicit exceptional cleanup evidence.' }));
        if (executorCalls === 2) return complete(tool('implementation-complete-initial', 'emit_result', { outcome: 'done', summary: 'Initial implementation complete.' }));
        if (executorCalls === 3) {
          correctedExecutorInput = input;
          observedImplementationStatuses.push(cards.read(implementation.id)!.lifecycle.status);
          return complete(tool('implementation-status-corrected', 'write', { path: `record:///status.md?card=${implementation.id}`, content: 'Corrected implementation closes the resource even when finalization throws.' }));
        }
        if (executorCalls === 4) return complete(tool('implementation-complete-corrected', 'emit_result', { outcome: 'done', summary: 'Reviewed correction complete.' }));
        throw new Error(`Unexpected implementation Executor call ${executorCalls}.`);
      }

      if (input.sessionId === `agent:reviewer:${goal.id}`) {
        reviewerCalls += 1;
        if (reviewerCalls === 1) return complete(tool('goal-review-write-revision', 'write', { path: `record:///review.md?card=${goal.id}`, content: firstReview }));
        if (reviewerCalls === 2) return complete(tool('goal-review-revision', 'emit_result', { outcome: 'revision_required', summary: firstReview }));
        if (reviewerCalls === 3) return complete(tool('goal-review-write-approved', 'write', { path: `record:///review.md?card=${goal.id}`, content: approvedReview }));
        if (reviewerCalls === 4) return complete(tool('goal-review-approved', 'emit_result', { outcome: 'approved', summary: approvedReview }));
        throw new Error(`Unexpected goal Reviewer call ${reviewerCalls}.`);
      }

      throw new Error(`Unexpected provider session '${input.sessionId}'.`);
    });
    const provider: LLMProviderPort = scriptedAdmissionProvider(providerTurn);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
    const runtime = createSupervisorRuntimeApi({
      fatalPort: testApplicationFatalPort,
      ...testAutonomousCompaction,
      runtimeGate: new RuntimeGate(),
      projectRoot,
      actorStore: cards,
      provider,
      conversations: { projectRoot },
      freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
      processRunner: new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort),
      runtimeProcessRootScope,
      promptTemplates: { render: () => 'test prompt' },
    });

    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    await waitUntil(() => runtime.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Project completed after owned correction.' } } });
    expect(cards.read(goal.id)).toMatchObject({ lifecycle: { status: 'done', result: { summary: approvedReview } } });
    expect(cards.read(implementation.id)).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Reviewed correction complete.' } } });
    expect(cards.getCardChildren(goal.id)).toMatchObject({ kind: 'found', value: { activeChildren: [{ id: implementation.id }] } });
    expect(rootGrandchildReopenResult).toEqual({ success: false, error: `reopen_card can target only immediate children of 'project'.` });

    const configuredPlannerMenu = testAutonomousCompaction.workflows.agents.get('planner')!.tools.map(({ name }) => name).concat('emit_result');
    expect(plannerToolMenus.length).toBeGreaterThan(0);
    expect(plannerToolMenus.every((menu) => JSON.stringify(menu) === JSON.stringify(configuredPlannerMenu))).toBe(true);
    expect(configuredPlannerMenu).toContain('reopen_card');
    expect(configuredPlannerMenu).toContain('queue_notification');

    expect(observedImplementationStatuses).toEqual(['done', 'changed', 'running']);
    const versions = cards.listCardVersions(implementation.id);
    if (versions.kind !== 'found') throw new Error('Implementation version history is missing.');
    const statusHistory = versions.value.map(({ version }) => {
      const artifact = cards.readCardVersion(implementation.id, version);
      if (artifact.kind !== 'found' || artifact.value.kind !== 'card-version') throw new Error(`Implementation version ${version} is missing.`);
      return artifact.value.card.lifecycle.status;
    });
    expect(statusHistory.filter((status, index) => index === 0 || status !== statusHistory[index - 1])).toEqual(['backlog', 'running', 'done', 'changed', 'running', 'done']);

    expect(correctedExecutorInput?.episodeContext.cardId).toBe(implementation.id);
    expect(implementationInputs).toHaveLength(4);
    expect(new Set(implementationInputs.map(({ episodeContext }) => episodeContext.cardId))).toEqual(new Set([implementation.id]));
    expect(new Set(implementationInputs.map(({ sessionId }) => sessionId))).toEqual(new Set([`agent:executor:${implementation.id}`]));
    expect(correctedExecutorInput?.providerConversation.messages.filter((message) => message.role === 'user' && message.kind === 'text' && message.content === correction)).toHaveLength(1);
    const goalPlannerRows = readConversation(projectRoot, `agent:planner:${goal.id}`).physicalRows;
    expect(goalPlannerRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_call', tool: 'reopen_card', tool_call_id: 'goal-reopen-child' }),
      expect.objectContaining({ kind: 'tool_call', tool: 'queue_notification', tool_call_id: 'goal-queue-correction' }),
      expect.objectContaining({ kind: 'tool_call', tool: 'activate_card', tool_call_id: 'goal-activate-correction' }),
    ]));
    expect(goalReviewContext).toContain(`record:///review.md?card=${goal.id}&v=3`);
    expect(cards.readRecordVersion(goal.id, 'review.md', 3)).toMatchObject({ kind: 'found', value: { projection: { artifact: { accepted: { content: firstReview, writer_agent: 'reviewer' } } } } });
    expect(cards.readRecordVersion(goal.id, 'review.md', 6)).toMatchObject({ kind: 'found', value: { projection: { artifact: { accepted: { content: approvedReview, writer_agent: 'reviewer' } } } } });
    expect(rootPlannerCalls).toBe(4);
    expect(goalPlannerCalls).toBe(8);
    expect(executorCalls).toBe(4);
    expect(reviewerCalls).toBe(4);
  });
});
