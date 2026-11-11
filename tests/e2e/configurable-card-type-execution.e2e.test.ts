import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
} from '../../src/runtime/card-process/card-process-config.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { CardService as ProductionCardService } from '../../src/cards/card-service.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { createObservedCollections } from '../../src/retrieval/index.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import {
  scriptedAdmissionProvider,
  testAutonomousCompaction,
} from '../helpers/llm-test-helpers.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function tool(id: string, name: string, args: object) {
  return {
    result: {
      kind: 'tool_calls' as const,
      tool_calls: [
        { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    provider_exchanges: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('custom card type execution admission', () => {
  it('compiles, creates, activates, and enters a custom execute node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'custom-card-execution-'));
    roots.push(root);
    initProjectTree(root);
    const config: SaivageConfig = structuredClone(TEST_SAIVAGE_CONFIG);
    const project = structuredClone(config.card_types.project!);
    project.permitted_child_types = ['initiative'];
    const initiative = structuredClone(config.card_types.goal!);
    initiative.permitted_child_types = ['task'];
    const task = structuredClone(config.card_types.code!);
    task.permitted_child_types = [];
    config.card_types = { project, initiative, task };
    const structural = compileProjectWorkflows(config);
    const providerRegistry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(
      structural,
      new ModelRouter(providerRegistry),
      providerRegistry,
      config.compaction.context_utilization_fraction, { internalAnalystEnabled: true },
    );
    const cards = new ProductionCardService(root, structural);
    const initiativeCard = cards.create({
      type: 'initiative',
      parent: 'project',
      title: 'Initiative',
      bootstrap_content: 'plan',
      created_by: 'planner', bootstrap_author: { kind: 'agent', agent: 'planner' },
      depends_on: [],
    });
    const taskCard = cards.create({
      type: 'task',
      parent: initiativeCard.id,
      title: 'Task',
      bootstrap_content: 'execute',
      created_by: 'planner', bootstrap_author: { kind: 'agent', agent: 'planner' },
      depends_on: [],
    });
    const sibling = cards.create({
      type: 'task', parent: initiativeCard.id, title: 'Unselected sibling', bootstrap_content: 'remain inactive',
      created_by: 'planner', bootstrap_author: { kind: 'agent', agent: 'planner' }, depends_on: [],
    });
    expect([initiativeCard.type, taskCard.type]).toEqual(['initiative', 'task']);
    const admitted = deferred<LlmInvocationInput>();
    let initiativeTurns = 0;
    const provider = scriptedAdmissionProvider(
      jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
        if (input.sessionId === 'agent:planner:project')
          return tool('activate-initiative', 'activate_card', { instructions: 'Complete the scoped child task with current evidence.', card_id: initiativeCard.id });
        if (input.sessionId === `agent:planner:${initiativeCard.id}`) {
          if (++initiativeTurns === 1) return tool('reorder-tasks', 'reorder_child', { orderedChildIds: [sibling.id, taskCard.id] });
          return tool('activate-task', 'activate_card', { instructions: 'Complete the scoped child task with current evidence.', card_id: taskCard.id });
        }
        if (input.sessionId === `agent:executor:${taskCard.id}`) {
          admitted.resolve(input);
          return new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        }
        throw new Error(`Unexpected session '${input.sessionId}'.`);
      }),
    );
    const registry = new ManagedProcessGroupRegistry();
    const processRunner = new ProcessRunner(root, registry, testApplicationFatalPort);
    const runtimeProcessRootScope = registry.createContainerScope(
      registry.rootScope,
      'runtime-cards',
    );
    const supervisor = createSupervisorRuntimeApi({
      retrieval: createObservedCollections(root),
      ...testAutonomousCompaction,
      workflows,
      projectRoot: root,
      actorStore: cards,
      provider,
      conversations: { projectRoot: root },
      freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
      processRunner,
      runtimeProcessRootScope,
      promptTemplates: createPromptTemplateRegistry(workflows),
      runtimeGate: new RuntimeGate(),
      fatalPort: testApplicationFatalPort,
    });
    const started = await supervisor.startProject();
    expect(started.started).toBe(true);
    const input = await admitted.promise;
    expect(input.sessionId).toBe(`agent:executor:${taskCard.id}`);
    expect(cards.listChildren(initiativeCard.id)).toEqual([sibling.id, taskCard.id]);
    expect(cards.read(taskCard.id)!.lifecycle.status).toBe('running');
    expect(cards.read(sibling.id)!.lifecycle.status).toBe('backlog');
    for (const value of [cards.read(taskCard.id)!, cards.read(sibling.id)!]) {
      expect(value).not.toHaveProperty('priority'); expect(value).not.toHaveProperty('urgency');
    }
    expect(input.tools.map((definition) => definition.function.name)).toContain('emit_result');
    await supervisor.stopProject();
    expect(supervisor.getStatus().status).toBe('stopped');
  });
});
