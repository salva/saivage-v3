import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { publishInitialProjectRuntime } from '../../../src/boot/project-runtime-bootstrap.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { cardConversationVersionFile, cardHeadFile } from '../../../src/persistence/layout.js';
import { ACTIVITY_ROW_POLICY, toolCallRowPolicy } from '../../helpers/row-policy-fixtures.js';
import { MODEL_RECOVERY_NOTICE_TEXT, type CardConversationSessionId } from '../../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-initialization-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  const runtimeStatusChanged = jest.fn();
  const runtime = createSupervisorRuntimeApi({
    actorStore: cards, projectRoot, conversations: { projectRoot }, workflows: TEST_RUNTIME_WORKFLOWS,
    processIdentity: { pid: 42, startedAt: '2026-08-10T00:00:00.000Z' },
    runtimeGate: new RuntimeGate(), runtimeStatusChanged, fatalPort: testApplicationFatalPort,
  } as never);
  return { cards, runtime, runtimeStatusChanged };
}

const interventionError = 'Analyst mutation requires an intervention-ready stopped or settled paused runtime.';

function seedInterruptedSession(root: string, sessionId: CardConversationSessionId, state: 'pending_call' | 'pending_provider'): void {
  const input = '11111111-1111-4111-8111-111111111111';
  const agentName = sessionId.split(':')[1]!;
  const cardId = sessionId.split(':')[2]!;
  const timestamp = '2026-08-10T00:00:00.000Z';
  const marker = {
    id: `${input}:activation:${agentName}`, session_id: sessionId, role: 'system' as const, kind: 'activity' as const,
    content: JSON.stringify({ event: 'activation_open', agent_name: agentName, card_id: cardId, input_id: input, timestamp }),
    context_policy: ACTIVITY_ROW_POLICY, round_id: `r-pre-${'1'.repeat(32)}`,
    message_index: 0, block_index: 0, timestamp,
  };
  appendConversationBatch({ projectRoot: root }, [marker]);
  if (state === 'pending_call') appendConversationBatch({ projectRoot: root }, [{
    id: `${input}:tool-call:pending`, session_id: sessionId, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'pending',
    context_policy: toolCallRowPolicy(),
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
    round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp,
  }]);
}

describe('Supervisor initialization lifecycle', () => {
  it('settles configured multi-agent sessions of a deep chain in card order, without touching an unrelated sibling or launching work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-configured-recovery-')); roots.push(root);
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents['quality-inspector'] = structuredClone(config.agents.reviewer!);
    config.card_types.goal!.workflow.nodes.review!.agent = 'quality-inspector';
    const compiled = compileProjectWorkflows(config);
    publishInitialProjectRuntime(root, compiled);
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
    const cards = new (await import('../../../src/cards/card-service.js')).CardService(root, compiled);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const middle = cards.create({ type: 'goal', parent: parent.id, title: 'Middle', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const leaf = cards.create({ type: 'code', parent: middle.id, title: 'Leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const sibling = cards.create({ type: 'code', parent: 'project', title: 'Untouched', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const chain = ['project', parent.id, middle.id, leaf.id];
    chain.forEach((id) => cards.setStatus(id, 'running'));
    seedInterruptedSession(root, `agent:planner:${middle.id}`, 'pending_call');
    seedInterruptedSession(root, `agent:executor:${leaf.id}`, 'pending_provider');
    const beforeSibling = readFileSync(cardHeadFile(root, sibling.id));
    const events: string[] = [];
    const originalStop = cards.stopRunning.bind(cards);
    jest.spyOn(cards, 'stopRunning').mockImplementation((id) => { events.push(`stop:${id}`); return originalStop(id); });
    const status = jest.fn();
    const runtime = createSupervisorRuntimeApi({
      actorStore: cards, projectRoot: root, workflows, runtimeGate: new RuntimeGate(),
      processIdentity: { pid: 42, startedAt: '2026-08-10T00:00:00.000Z' }, fatalPort: testApplicationFatalPort,
      runtimeStatusChanged: status,
      conversations: { projectRoot: root, changes: {
        conversationChanged({ session_id }: { session_id: string }) { events.push(`conversation:${session_id}`); },
        agentMembershipChanged() {},
      } },
    } as never);
    await runtime.start();
    expect(events).toEqual([
      `conversation:agent:executor:${leaf.id}`, `stop:${leaf.id}`,
      `conversation:agent:planner:${middle.id}`, `conversation:agent:planner:${middle.id}`, `stop:${middle.id}`,
      `stop:${parent.id}`, 'stop:project',
    ]);
    expect(readConversation(root, `agent:quality-inspector:${middle.id}`).physicalRows).toHaveLength(0);
    expect(readConversation(root, `agent:planner:${middle.id}`).physicalRows.map((row) => row.kind).slice(-2)).toEqual(['tool_result', 'model_recovered']);
    expect(readConversation(root, `agent:executor:${leaf.id}`).physicalRows.at(-1)).toMatchObject({ kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT });
    expect(readFileSync(cardHeadFile(root, sibling.id))).toEqual(beforeSibling);
    expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(runtime.getActorRuntimeReadModel().cards).toEqual([]);
    expect(runtime.captureAutonomousExecutingLlmSnapshots().size).toBe(0);
    expect(status).toHaveBeenCalledTimes(1);
    const bytes = chain.map((id) => readFileSync(cardHeadFile(root, id)));
    const sessionBytes = readConversation(root, `agent:planner:${middle.id}`).physicalRows;
    const second = createSupervisorRuntimeApi({ actorStore: cards, workflows, conversations: { projectRoot: root }, runtimeGate: new RuntimeGate(), fatalPort: testApplicationFatalPort } as never);
    await second.start();
    expect(events).toHaveLength(7);
    expect(chain.map((id) => readFileSync(cardHeadFile(root, id)))).toEqual(bytes);
    expect(readConversation(root, `agent:planner:${middle.id}`).physicalRows).toEqual(sessionBytes);
  });

  it.each(['pending_call', 'pending_provider'] as const)('rejects a malformed complete %s session before its card or any ancestor is stopped', async (state) => {
    const { cards, runtime, runtimeStatusChanged } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const sessionId = `agent:executor:${child.id}` as const;
    seedInterruptedSession(roots.at(-1)!, sessionId, state);
    const segment = readCurrentConversationSegment(roots.at(-1)!, sessionId)!;
    const path = cardConversationVersionFile(roots.at(-1)!, child.id, 'executor', segment.entry.filename);
    appendFileSync(path, '{"version":5,"type":"conversation-segment","rows":[{}]}\n');
    const before = readFileSync(path);
    const stop = jest.spyOn(cards, 'stopRunning');
    await expect(runtime.start()).rejects.toThrow(`Startup interrupted-card settlement: configured session '${sessionId}' failed.`);
    expect(stop).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
    expect(runtimeStatusChanged).not.toHaveBeenCalled();
  });

  it('rejects a wrong-card activation association without correcting that card or its ancestor', async () => {
    const { cards, runtime, runtimeStatusChanged } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const root = roots.at(-1)!;
    const session = `agent:executor:${child.id}` as const;
    seedInterruptedSession(root, session, 'pending_provider');
    const segment = readCurrentConversationSegment(root, session)!;
    const path = cardConversationVersionFile(root, child.id, 'executor', segment.entry.filename);
    writeFileSync(path, readFileSync(path, 'utf8').replace(`\\\"card_id\\\":\\\"${child.id}\\\"`, '\\\"card_id\\\":\\\"project\\\"'));
    const stop = jest.spyOn(cards, 'stopRunning');
    await expect(runtime.start()).rejects.toThrow(`Startup interrupted-card settlement: configured session 'agent:executor:${child.id}' failed.`);
    expect(stop).not.toHaveBeenCalled();
    expect(runtimeStatusChanged).not.toHaveBeenCalled();
  });

  it('a separate Supervisor consumes a committed stopped suffix after an ordinary later failure without duplicating its notice', async () => {
    const { cards, runtime } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    seedInterruptedSession(roots.at(-1)!, `agent:executor:${child.id}`, 'pending_provider');
    const originalStop = cards.stopRunning.bind(cards);
    const failure = new Error('injected known failure');
    const stop = jest.spyOn(cards, 'stopRunning').mockImplementation((id) => {
      if (id === 'project') throw failure;
      return originalStop(id);
    });
    await expect(runtime.start()).rejects.toMatchObject({ cause: failure });
    expect(cards.read(child.id)?.lifecycle.status).toBe('stopped');
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    const noticeRows = readConversation(roots.at(-1)!, `agent:executor:${child.id}`).physicalRows;
    expect(noticeRows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
    const childBytes = readFileSync(cardHeadFile(roots.at(-1)!, child.id));
    stop.mockRestore();
    const next = createSupervisorRuntimeApi({ actorStore: cards, workflows: TEST_RUNTIME_WORKFLOWS, conversations: { projectRoot: roots.at(-1)! }, runtimeGate: new RuntimeGate(), fatalPort: testApplicationFatalPort } as never);
    await next.start();
    expect(cards.read('project')?.lifecycle.status).toBe('stopped');
    expect(readFileSync(cardHeadFile(roots.at(-1)!, child.id))).toEqual(childBytes);
    expect(readConversation(roots.at(-1)!, `agent:executor:${child.id}`).physicalRows).toEqual(noticeRows);
  });
  it('rejects intervention and public status before successful initialization', () => {
    const { runtime } = fixture();
    expect(() => runtime.assertInterventionReady()).toThrow(interventionError);
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
    expect(runtime.getRuntimeState()).toBeNull();
  });

  it('settles a linked running chain leaf-to-root before publishing stopped and leaves no owner', async () => {
    const { cards, runtime, runtimeStatusChanged } = fixture();
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const leaf = cards.create({ type: 'code', parent: goal.id, title: 'Leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    for (const id of ['project', goal.id, leaf.id]) cards.setStatus(id, 'running');
    const operations: string[] = [];
    const originalStop = cards.stopRunning.bind(cards);
    jest.spyOn(cards, 'stopRunning').mockImplementation((id) => {
      expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
      expect(() => runtime.assertInterventionReady()).toThrow(interventionError);
      expect(runtimeStatusChanged).not.toHaveBeenCalled();
      operations.push(id);
      return originalStop(id);
    });

    await runtime.start();
    expect(operations).toEqual([leaf.id, goal.id, 'project']);
    expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(runtime.getRuntimeState()).toBeNull();
    expect(runtime.captureAutonomousExecutingLlmSnapshots().size).toBe(0);
    expect(runtimeStatusChanged).toHaveBeenCalledTimes(1);
    for (const id of operations) expect(cards.read(id)?.lifecycle.status).toBe('stopped');
    await runtime.start();
    expect(operations).toHaveLength(3);
    const second = createSupervisorRuntimeApi({
      actorStore: cards, conversations: { projectRoot: roots.at(-1)! }, workflows: TEST_RUNTIME_WORKFLOWS,
      processIdentity: { pid: 43, startedAt: '2026-08-11T00:00:00.000Z' },
      runtimeGate: new RuntimeGate(), fatalPort: testApplicationFatalPort,
    } as never);
    await second.start();
    expect(operations).toHaveLength(3);
  });

  it('rejects a broken linked topology before any correction and keeps status unavailable', async () => {
    const { cards, runtime, runtimeStatusChanged } = fixture();
    const left = cards.create({ type: 'goal', parent: 'project', title: 'Left', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const right = cards.create({ type: 'goal', parent: 'project', title: 'Right', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    for (const id of ['project', left.id, right.id]) cards.setStatus(id, 'running');
    const stop = jest.spyOn(cards, 'stopRunning');
    await expect(runtime.start()).rejects.toThrow('Startup interrupted-card settlement: linked-chain selection failed.');
    expect(stop).not.toHaveBeenCalled();
    expect(runtimeStatusChanged).not.toHaveBeenCalled();
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
  });

  it('routes an uncertain stopped publication unchanged to fatal without another read, write, or status callback', async () => {
    const { cards } = fixture();
    cards.setStatus('project', 'running');
    const uncertainty = new PublicationOutcomeUnknownError();
    const read = jest.spyOn(cards, 'read');
    const stop = jest.spyOn(cards, 'stopRunning').mockImplementation(() => { throw uncertainty; });
    const runtimeStatusChanged = jest.fn();
    const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => { expect(error).toBe(uncertainty); throw testApplicationFatalDelivery; });
    const runtime = createSupervisorRuntimeApi({ actorStore: cards, conversations: { projectRoot: roots.at(-1)! }, workflows: TEST_RUNTIME_WORKFLOWS,
      runtimeGate: new RuntimeGate(), fatalPort: { publicationOutcomeUnknown: fatal }, runtimeStatusChanged } as never);
    const cleanup = jest.spyOn(runtime, 'cleanupForApplicationStop');
    await expect(runtime.start()).rejects.toBe(testApplicationFatalDelivery);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith(uncertainty);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(runtimeStatusChanged).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });


  it('keeps a known stopped-publication failure local to startup with a safe cause-bearing diagnostic', async () => {
    const { cards, runtime, runtimeStatusChanged } = fixture();
    cards.setStatus('project', 'running');
    const failure = new Error('untrusted persistence detail');
    jest.spyOn(cards, 'stopRunning').mockImplementation(() => { throw failure; });
    await expect(runtime.start()).rejects.toMatchObject({
      message: "Startup interrupted-card settlement: card 'project' stopped publication failed.", cause: failure,
    });
    expect(runtimeStatusChanged).not.toHaveBeenCalled();
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
  });
});
