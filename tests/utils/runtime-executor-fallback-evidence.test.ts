import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendMessage, createSession, getSessionMessages } from '../../src/agents/session-persistence.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/contracts/index.js';
import type { CardRecord, HandoffSummary } from '../../src/schemas/types.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

class StubAgentRuntime implements AgentRuntime {
  constructor(
    private readonly plannerResult: PlannerResult,
    private readonly executorResult: ExecutorResult,
    private readonly reviewerResult: ReviewerResult,
  ) {}
  invokePlanner(): Promise<PlannerResult> { return Promise.resolve(this.plannerResult); }
  invokeExecutor(): Promise<ExecutorResult> { return Promise.resolve(this.executorResult); }
  invokeReviewer(): Promise<ReviewerResult> { return Promise.resolve(this.reviewerResult); }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

function createHarness(projectRoot: string, agentRuntime: AgentRuntime): RuntimeCoreTestContainer {
  return createRuntimeCoreTestContainer({
    config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
    agentRuntime,
  });
}

describe('Runtime executor fallback evidence persistence', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-fallback-'));
    initProjectTree(projectRoot);
    materializeProjectCard(projectRoot);
    mkdirSync(join(projectRoot, 'generated'), { recursive: true });
    mkdirSync(join(projectRoot, 'logs'), { recursive: true });
    writeFileSync(join(projectRoot, 'generated', 'output.txt'), 'generated output\n', 'utf8');
    writeFileSync(join(projectRoot, 'logs', 'command-tail.txt'), 'tail output\n', 'utf8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stores fallback result evidence and does not silently complete the parent goal', async () => {
    const plannerResult: PlannerResult = {
      status: 'done',
      summary: 'done',
    };
    const store = new (await import('../../src/cards/card-store.js')).CardStore(projectRoot);
    const createdCard = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Generate output', description: 'Create output file and verify it', status: 'backlog', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const executorResult: ExecutorResult = {
      card_id: createdCard.id,
      status: 'failed',
      status_text: 'Executor fallback evidence preserved',
      error: 'Executor final response was malformed or missing required status; preserved tool evidence via fallback result.',
      summary: 'fallback preserved tool evidence',
      fallback_with_evidence: { reason: 'parse_failure' },
      artifacts: [
        { type: 'other', description: 'Generated file: generated/output.txt', retain: true, path: 'generated/output.txt' },
      ],
      attachments: [
        { mime: 'text/plain', title: 'command output', path: 'logs/command-tail.txt' },
      ],
      result: {
        generated_files: ['generated/output.txt'],
        verification_commands: [{ command: 'npm test -- result-parser', process_id: 'proc-55', status: 'exited', exit_code: 0, timed_out: false }],
        artifact_paths: [],
        tool_errors: [],
        parse_failure: {
          message: 'Executor final response was malformed or missing required status; preserved tool evidence via fallback result.',
          raw_response: JSON.stringify({ card_id: createdCard.id }),
        },
      },
    };
    const reviewerResult: ReviewerResult = {
      assessment: {
        result: 'needs_corrections',
        summary: 'Executor failed as expected for malformed final JSON fallback evidence test',
        achieved: ['Fallback evidence persisted on the card.'],
        issues: [],
        evidence_card_ids: [createdCard.id],
      },
    };

    const parentSession = createSession(join(projectRoot, '.saivage'), 'planner', 'project', 'project');
    appendMessage(join(projectRoot, '.saivage'), parentSession.id, { role: 'assistant', kind: 'tool_call', tool: 'activate_card', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'activate-project-card-1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: createdCard.id }) } }] }) }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    const parentRun = appendRuntimeRun(projectRoot, { run_id: 'test-parent-run', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: parentSession.id });
    const childRun = appendRuntimeRun(projectRoot, { run_id: 'test-child-run', kind: 'child', ownership: { kind: 'activation', activation_id: 'act-test', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-test' }, card_id: createdCard.id, parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'pending', runtime_status: 'running', session_id: null });
    upsertRuntimeActivation(projectRoot, { idempotency_key: `test-parent-run:activate-project-card-1:${createdCard.id}`, parent_card_id: 'project', parent_run_id: parentRun.run_id, parent_session_id: parentSession.id, parent_tool_call_id: 'activate-project-card-1', child_card_id: createdCard.id, status: 'pending', precondition: 'accepted', runtime_run_id: childRun.run_id, error: null });
    const harness = createHarness(projectRoot, new StubAgentRuntime(plannerResult, executorResult, reviewerResult));
    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');
    await harness.api.shutdown();

    const codeCard = harness.cardTestTools.read(createdCard.id) as CardRecord;
    expect(codeCard.status).toBe('needs_verification');
    expect(codeCard.lifecycle.error).toBeNull();
    expect(codeCard.lifecycle.completed_at).toBeNull();
    expect(harness.cardTestTools.read('project')?.status).not.toBe('done');
    expect(codeCard.lifecycle.result).toEqual(expect.objectContaining({
      kind: 'executor_needs_verification',
      preserved_result: expect.objectContaining({
        generated_files: ['generated/output.txt'],
        verification_commands: [expect.objectContaining({ command: 'npm test -- result-parser', process_id: 'proc-55', status: 'exited', exit_code: 0, timed_out: false })],
        artifact_paths: [],
        parse_failure: expect.objectContaining({ raw_response: JSON.stringify({ card_id: createdCard.id }) }),
        evidence_registration_ignored: expect.objectContaining({
          artifacts: expect.arrayContaining([expect.stringContaining('generated/output.txt')]),
          attachments: expect.arrayContaining([expect.stringContaining('logs/command-tail.txt')]),
        }),
      }),
    }));
    expect(codeCard.artifacts).toEqual([]);
    expect(codeCard.attachments).toEqual([]);

    const toolResult = getSessionMessages(join(projectRoot, '.saivage'), parentSession.id).find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-project-card-1');
    expect(toolResult).toBeUndefined();
    const activation = readRuntimeState(projectRoot)?.runtime_activations?.find((record) => record.child_card_id === createdCard.id);
    expect(activation?.status).not.toBe('completed');
  });

  it('ignores project-file artifact claims without failing a done executor result', async () => {
    const plannerResult: PlannerResult = {
      status: 'done',
      summary: 'done',
    };
    const store = new (await import('../../src/cards/card-store.js')).CardStore(projectRoot);
    const createdCard = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Generate output', description: 'Create output file and verify it', status: 'backlog', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const executorResult: ExecutorResult = {
      card_id: createdCard.id,
      status: 'done',
      status_text: 'Generated project file and verified it',
      summary: 'generated output file',
      fallback_with_evidence: null,
      artifacts: [
        { type: 'other', description: 'Generated project file', retain: true, path: 'generated/output.txt' },
        { type: 'other', description: 'Generated project directory', retain: true, path: 'generated' },
      ],
      attachments: [
        { mime: 'text/plain', title: 'command output', path: 'logs/command-tail.txt' },
      ],
      result: {
        generated_files: ['generated/output.txt'],
        verification_commands: [{ command: 'npm test -- result-parser', process_id: 'proc-55', status: 'exited', exit_code: 0, timed_out: false }],
      },
    };
    const reviewerResult: ReviewerResult = {
      assessment: {
        result: 'pass',
        summary: 'Executor result evidence is enough; project files were not registered as artifacts.',
        achieved: ['Project file change was recorded in result metadata.'],
        issues: [],
        evidence_card_ids: [createdCard.id],
      },
    };

    const parentSession = createSession(join(projectRoot, '.saivage'), 'planner', 'project', 'project');
    appendMessage(join(projectRoot, '.saivage'), parentSession.id, { role: 'assistant', kind: 'tool_call', tool: 'activate_card', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'activate-project-card-1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: createdCard.id }) } }] }) }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    const parentRun = appendRuntimeRun(projectRoot, { run_id: 'test-parent-run', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: parentSession.id });
    const childRun = appendRuntimeRun(projectRoot, { run_id: 'test-child-run', kind: 'child', ownership: { kind: 'activation', activation_id: 'act-test', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-test' }, card_id: createdCard.id, parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'pending', runtime_status: 'running', session_id: null });
    upsertRuntimeActivation(projectRoot, { idempotency_key: `test-parent-run:activate-project-card-1:${createdCard.id}`, parent_card_id: 'project', parent_run_id: parentRun.run_id, parent_session_id: parentSession.id, parent_tool_call_id: 'activate-project-card-1', child_card_id: createdCard.id, status: 'pending', precondition: 'accepted', runtime_run_id: childRun.run_id, error: null });
    const harness = createHarness(projectRoot, new StubAgentRuntime(plannerResult, executorResult, reviewerResult));
    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');
    await harness.api.shutdown();

    const codeCard = harness.cardTestTools.read(createdCard.id) as CardRecord;
    expect(codeCard.status).toBe('done');
    expect(codeCard.lifecycle.error).toBeNull();
    expect(codeCard.artifacts).toEqual([]);
    expect(codeCard.attachments).toEqual([]);
    expect(codeCard.lifecycle.result).toEqual(expect.objectContaining({
      kind: 'executor_success',
      generated_files: ['generated/output.txt'],
      executor: expect.objectContaining({
        generated_files: ['generated/output.txt'],
        evidence_registration_ignored: expect.objectContaining({
          artifacts: expect.arrayContaining([expect.stringContaining('generated/output.txt'), expect.stringContaining('generated')]),
          attachments: expect.arrayContaining([expect.stringContaining('logs/command-tail.txt')]),
        }),
      }),
    }));

    const toolResult = getSessionMessages(join(projectRoot, '.saivage'), parentSession.id).find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-project-card-1');
    expect(toolResult).toBeDefined();
    const completion = JSON.parse(toolResult!.content) as { outcome: string; artifacts: unknown[]; attachments: unknown[] };
    expect(completion.outcome).toBe('done');
    expect(completion.artifacts).toEqual([]);
    expect(completion.attachments).toEqual([]);
  });


  it('resumes an already-active pending terminal activation before executor finish', async () => {
    const plannerResult: PlannerResult = {
      status: 'done',
      summary: 'done',
    };
    const store = new (await import('../../src/cards/card-store.js')).CardStore(projectRoot);
    const createdCard = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Already active terminal card', description: 'Complete an already-active pending activation', status: 'backlog', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const executorResult: ExecutorResult = {
      card_id: createdCard.id,
      status: 'done',
      status_text: 'Active pending activation completed',
      summary: 'completed active pending activation',
      fallback_with_evidence: null,
      artifacts: [],
      attachments: [],
      result: { evidence: 'active pending activation completed' },
    };
    const reviewerResult: ReviewerResult = {
      assessment: {
        result: 'pass',
        summary: 'Active pending activation completed and reviewed.',
        achieved: ['Active pending activation completed.'],
        issues: [],
        evidence_card_ids: [createdCard.id],
      },
    };

    const parentSession = createSession(join(projectRoot, '.saivage'), 'planner', 'project', 'project');
    appendMessage(join(projectRoot, '.saivage'), parentSession.id, { role: 'assistant', kind: 'tool_call', tool: 'activate_card', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'activate-project-card-1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: createdCard.id }) } }] }) }, { round_id: 'r-user-00000000000000000000000000000002', message_index: 0, block_index: 0 });
    store.setStatus(createdCard.id, 'running');
    const parentRun = appendRuntimeRun(projectRoot, { run_id: 'test-parent-run-active', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: parentSession.id });
    const childRun = appendRuntimeRun(projectRoot, { run_id: 'test-child-run-active', kind: 'child', ownership: { kind: 'activation', activation_id: 'act-test', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-test' }, card_id: createdCard.id, parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'pending', runtime_status: 'running', session_id: null });
    upsertRuntimeActivation(projectRoot, { idempotency_key: `test-parent-run-active:activate-project-card-1:${createdCard.id}`, parent_card_id: 'project', parent_run_id: parentRun.run_id, parent_session_id: parentSession.id, parent_tool_call_id: 'activate-project-card-1', child_card_id: createdCard.id, status: 'pending', precondition: 'accepted', runtime_run_id: childRun.run_id, error: null });

    const harness = createHarness(projectRoot, new StubAgentRuntime(plannerResult, executorResult, reviewerResult));
    await harness.dispatchTestTools.dispatchGoal('project');
    await harness.api.shutdown();

    const codeCard = harness.cardTestTools.read(createdCard.id) as CardRecord;
    expect(codeCard.status).toBe('done');
    expect(codeCard.lifecycle.completed_at).toEqual(expect.any(String));
    expect(Date.parse(codeCard.lifecycle.completed_at!)).not.toBeNaN();
    expect(codeCard.lifecycle.result).toEqual(expect.objectContaining({
      kind: 'executor_success',
      executor: expect.objectContaining({ evidence: 'active pending activation completed' }),
      latest_self_report: expect.objectContaining({ outcome: 'done' }),
    }));
    const activation = readRuntimeState(projectRoot)?.runtime_activations?.find((record) => record.child_card_id === createdCard.id);
    expect(activation?.status).toBe('completed');
    const toolResult = getSessionMessages(join(projectRoot, '.saivage'), parentSession.id).find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-project-card-1');
    expect(toolResult).toBeDefined();
    expect(JSON.parse(toolResult!.content)).toEqual(expect.objectContaining({ outcome: 'done' }));
  });
});
