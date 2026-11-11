import { expect } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import {
  compileProjectWorkflows,
  bindRuntimeWorkflows,
} from '../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { CardService } from '../../src/cards/card-service.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createObservedCollections } from '../../src/retrieval/index.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { CardActivationOwner } from '../../src/runtime/actors/card-activation-owner.js';
import { TEST_SAIVAGE_CONFIG } from './test-saivage-config.js';
import { createTestProcessRunner } from './test-process-runner.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from './llm-test-helpers.js';
import { testApplicationFatalPort } from './test-application-fatal-port.js';
import { publishTestProjectRuntime } from './initial-project-fixture.js';

export type Step = {
  node: string;
  tool: string;
  args: object;
  card?: string;
  before?: (input: PreparedLlmInvocationInput, signal: AbortSignal) => void | Promise<void>;
};
export const verdict = (node: string, outcome: string, card = 'project'): Step => ({
  node,
  card,
  tool: 'emit_result',
  args: { outcome, summary: `${card}/${node}: ${outcome}` },
});
export const author = (
  node: string,
  content: string,
  card = 'project',
  record = [
    'alignment',
    'integrated-acceptance',
    'debt-assessment',
    'component-review',
    'system-review',
  ].includes(node)
    ? 'review.md'
    : 'status.md',
): Step => ({
  node,
  card,
  tool: 'write',
  args: { path: `record:///${record}?card=${card}`, content },
});
export const decision = (
  node: string,
  outcome: string,
  content: string,
  card = 'project',
): Step[] => [author(node, content, card), verdict(node, outcome, card)];
export function selectedNode(input: PreparedLlmInvocationInput) {
  const card = JSON.parse(input.preparedContext.stableBlocks[0]!.content).cardId as string;
  const block = input.providerConversation.messages.find(
    (message) =>
      'block_identity' in message && message.block_identity.startsWith(`node-activation:${card}:`),
  );
  if (!block || !('block_identity' in block))
    throw new Error('Missing actual current-node context');
  return { card, node: block.block_identity.slice(`node-activation:${card}:`.length) };
}

export interface Newloop2Fixture {
  root: string;
  config: ReturnType<typeof effectiveSaivageConfigSchema.parse>;
  compiled: ReturnType<typeof compileProjectWorkflows>;
  cards: CardService;
  supervisor: ReturnType<typeof createSupervisorRuntimeApi>;
  requests: PreparedLlmInvocationInput[];
  launch(): Promise<CardActivationOwner>;
  readonly atEnd: Promise<void>;
  script(next: Step[]): void;
  record(
    name: string,
    card?: string,
  ): import('../../src/persistence/index.js').CurrentRecordProjection | null;
  child(type: string, parent?: string, brief?: string): ReturnType<CardService['create']>;
  cleanup(): Promise<void>;
}

export function newloop2Fixture(initial: Step[] = []): Newloop2Fixture {
  const root = mkdtempSync(join(tmpdir(), 'newloop2-flow-'));
  const template = resolveSystemTemplate('newloop2');
  const config = effectiveSaivageConfigSchema.parse({
    ...structuredClone(template.config),
    models: structuredClone(TEST_SAIVAGE_CONFIG.models),
    providers: structuredClone(TEST_SAIVAGE_CONFIG.providers),
    compaction: structuredClone(TEST_SAIVAGE_CONFIG.compaction),
  });
  config.providers.test!.capabilities = {
    ...config.providers.test!.capabilities,
    transportProtocol: 'openai-responses',
    imageInput: true,
  };
  const compiled = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot });
  publishTestProjectRuntime(root, compiled);
  const cards = new CardService(root, compiled);
  cards.acceptRecord(
    'project',
    'brief.md',
    'Publish a concise accurate operating guide for the finite widget procedure. Complete functional acceptance and scoped structural assessment; no continuing work.',
    { kind: 'agent', agent: 'analyst' },
  );
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(
    compiled,
    new ModelRouter(registry),
    registry,
    config.compaction.context_utilization_fraction,
    { internalAnalystEnabled: true },
  );
  const processes = createTestProcessRunner(root);
  const requests: PreparedLlmInvocationInput[] = [];
  let steps = initial,
    cursor = 0,
    serial = 0;
  let parked!: () => void;
  let atEnd = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    workflows,
    projectRoot: root,
    actorStore: cards,
    retrieval: createObservedCollections(root),
    fatalPort: testApplicationFatalPort,
    runtimeGate: new RuntimeGate(),
    provider: scriptedAdmissionProvider(
      async (input: PreparedLlmInvocationInput, signal: AbortSignal) => {
        requests.push(input);
        const directory = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
        if (directory) {
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, `${root.split('/').at(-1)}-${requests.length}.json`),
            JSON.stringify(input, null, 2),
          );
        }
        const step = steps[cursor++];
        if (!step) {
          parked();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
          throw new Error('Unreachable aborted request');
        }
        expect(selectedNode(input)).toEqual({ card: step.card ?? 'project', node: step.node });
        await step.before?.(input, signal);
        return {
          result: {
            kind: 'tool_calls',
            tool_calls: [
              {
                id: `newloop2-${++serial}`,
                type: 'function',
                function: { name: step.tool, arguments: JSON.stringify(step.args) },
              },
            ],
          },
          provider_exchanges: [],
        };
      },
    ),
    conversations: { projectRoot: root },
    freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
    processRunner: processes.processRunner,
    runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createPromptTemplateRegistry(compiled),
  });
  let started = false;
  const launch = async () => {
    if (!started) {
      await supervisor.start();
      started = true;
    }
    const internal = supervisor as unknown as {
      beginStartProject(): Promise<{ accepted: boolean; launch: { owner: CardActivationOwner } }>;
      launchStartedProject(plan: unknown): void;
    };
    const prepared = await internal.beginStartProject();
    if (!prepared.accepted) throw new Error('Rejected project launch');
    void prepared.launch.owner.settlement.promise.catch(() => undefined);
    internal.launchStartedProject(prepared.launch);
    return prepared.launch.owner;
  };
  return {
    root,
    config,
    compiled,
    cards,
    supervisor,
    requests,
    launch,
    get atEnd() {
      return atEnd;
    },
    script(next: Step[]) {
      steps = next;
      cursor = 0;
      atEnd = new Promise<void>((resolve) => {
        parked = resolve;
      });
    },
    record(name: string, card = 'project') {
      const result = cards.readRecordCurrent(card, name);
      if (result.kind !== 'found') throw new Error('Missing card');
      return result.value.projection;
    },
    child(type: string, parent = 'project', brief = `Finite ${type} assignment.`) {
      return cards.create({
        type,
        parent,
        title: `Useful ${type}`,
        bootstrap_content: brief,
        created_by: 'planner',
        bootstrap_author: { kind: 'agent', agent: 'planner' },
        depends_on: [],
      });
    },
    async cleanup() {
      if (started) await supervisor.stopProject();
      await processes.processRunner.terminateScopeTree({
        rootScope: processes.runtimeProcessRootScope,
        categories: ['runtime_card'],
        reason: 'test cleanup',
        graceMs: 50,
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
