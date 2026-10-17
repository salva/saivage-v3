import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import {
  ProviderTurnFailure,
  type LlmCompleteResult,
  type ProviderTurnCompletion,
} from '../../src/contracts/index.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { createResolvedConfigAuthority } from '../../src/config/index.js';
import { CardService } from '../../src/cards/card-service.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import {
  bindRuntimeWorkflows,
  describeNodeResultContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { parseActivationOpenPayload } from '../../src/schemas/index.js';
import { parseConversationSessionId } from '../../src/schemas/conversation-session-id.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { foldConversation } from '../../src/application/read-models/agent-conversation-read-model.js';
import { specializedConfig } from './specialized-config.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from './llm-test-helpers.js';
import { testApplicationFatalPort } from './test-application-fatal-port.js';
import {
  productionTestConfig,
  writeProductionConfig,
  initializeProject,
  startProductionApp,
  appOrigin,
  listen,
  closeServer,
  waitFor,
} from './production-composition-e2e.js';

export type InstructionScene = 'code' | 'architecture' | 'cancelled' | 'failed';
export const instructionFlowToken = 'synthetic-instruction-flow-reader';
const instructionFlowDeadlineMs = 30_000;

// A finite test join, not runtime recovery. The caller retains cleanup ownership.
async function instructionFlowDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Instruction fixture deadline: ${label}`)),
          instructionFlowDeadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const complete = (result: LlmCompleteResult): ProviderTurnCompletion => ({
  result,
  provider_exchanges: [],
});
const tool = (id: string, name: string, args: object): LlmCompleteResult => ({
  kind: 'tool_calls',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

export async function createInstructionFlow(scene: InstructionScene) {
  const root = mkdtempSync(join(tmpdir(), 'conversation-instruction-flow-'));
  const unexpectedProviderRequests: string[] = [];
  const sink = createServer((request, response) => {
    unexpectedProviderRequests.push(`${request.method} ${request.url}`);
    response.writeHead(400);
    response.end('Unexpected network provider work');
  });
  let supervisor: ReturnType<typeof createSupervisorRuntimeApi> | undefined;
  let app: Awaited<ReturnType<typeof startProductionApp>> | undefined;
  const cleanup = async () => {
    try {
      if (app) await instructionFlowDeadline(app.stop(), 'read app stop');
      if (supervisor) await instructionFlowDeadline(supervisor.stopProject(), 'actor containment');
    } finally {
      await instructionFlowDeadline(closeServer(sink), 'sink close');
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const port = await instructionFlowDeadline(listen(sink), 'sink listen');
    const config = productionTestConfig(port, (config) => {
      config.card_types = specializedConfig().card_types;
      config.oversight.enabled = false;
      config.mcpServers = {};
    });
    writeProductionConfig(root, config);
    // The real typed template closure, not handcrafted prompt files or classic's
    // default closure. CLI init and the later read app compile these same inputs.
    cpSync(
      resolveSystemTemplate('classic-typed').promptRoot,
      join(root, '.saivage/config/prompts'),
      { recursive: true },
    );
    initializeProject(root);
    const structural = createResolvedConfigAuthority({
      path: join(root, '.saivage/saivage.yaml'),
      projectRoot: root,
      interpolationEnvironment: {},
    }).loadEffective().workflows;
    const cards = new CardService(root, structural);
    const type = scene === 'architecture' ? 'architecture' : 'code';
    const child = cards.create({
      type,
      parent: 'project',
      title: `${scene} instruction flow`,
      bootstrap_content: `Synthetic ${scene} acceptance.`,
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
    });
    const starts: Array<{
      session: ReturnType<typeof parseConversationSessionId>;
      node: string;
      ordinal: number;
      inputId: string;
      role: string;
      nodeText: string;
      contract: string;
    }> = [];
    const calls: Array<{
      session: string;
      inputId: string;
      ordinal: number;
      node: string;
      contextIds: string[];
    }> = [];
    let plannerCalls = 0;
    let childCalls = 0;
    let cancellationObserved = false;
    let classifiedFailureObserved = false;
    let announcePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      announcePending = resolve;
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(
      structural,
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
    );
    const groups = new ManagedProcessGroupRegistry();
    supervisor = createSupervisorRuntimeApi({
      ...testAutonomousCompaction,
      workflows,
      projectRoot: root,
      actorStore: cards,
      provider: scriptedAdmissionProvider(async (input: LlmInvocationInput, signal) => {
        if (input.sessionId === 'agent:planner:project') {
          plannerCalls += 1;
          const actions = [
            tool('activate-child', 'activate_card', { instructions: 'Complete the scoped child task with current evidence.', card_id: child.id }),
            tool('parent-write', 'write', {
              path: 'record:///status.md?card=project',
              content: `Synthetic ${scene} child settled.`,
            }),
            tool('parent-result', 'emit_result', {
              outcome: scene === 'failed' ? 'failed' : 'complete_direct',
              summary: `Synthetic ${scene} parent settled.`,
            }),
          ];
          assert(actions[plannerCalls - 1], 'unexpected parent provider callback');
          return complete(actions[plannerCalls - 1]!);
        }
        const position = supervisor!
          .getActorRuntimeReadModel()
          .cards.find((card) => card.cardId === child.id)?.processState;
        assert(position?.kind === 'node', 'missing actual actor position');
        const session = parseConversationSessionId(input.sessionId);
        calls.push({
          session,
          inputId: input.inputId,
          ordinal: position.executionOrdinal,
          node: position.nodeId,
          contextIds: input.providerConversation.messages.flatMap((row) =>
            row.role === 'user' && row.kind === 'text' ? [row.id] : [],
          ),
        });
        if (!starts.some((start) => start.ordinal === position.executionOrdinal)) {
          const contract = describeNodeResultContract(
            structural.cardTypes.get(type)!,
            `node:${position.nodeId}`,
          );
          assert(
            input.systemPrompt.includes(contract),
            'actual role lacks the compiled outcome contract',
          );
          assert(input.preparedContext, 'provider input lacks frozen preparation');
          const nodeText = input.preparedContext.stableBlocks[1]!.content;
          assert.equal(
            input.providerConversation.messages.filter((row) => row.content === nodeText).length,
            1,
          );
          starts.push({
            session,
            node: position.nodeId,
            ordinal: position.executionOrdinal,
            inputId: input.inputId,
            role: redactTextForOutbound(input.systemPrompt),
            nodeText: redactTextForOutbound(nodeText),
            contract,
          });
        }
        const start = starts.find((start) => start.ordinal === position.executionOrdinal)!;
        assert.equal(redactTextForOutbound(input.systemPrompt), start.role);
        assert.equal(
          redactTextForOutbound(input.preparedContext!.stableBlocks[1]!.content),
          start.nodeText,
        );
        assert.equal(
          input.providerConversation.messages.filter(
            (row) => row.content === input.preparedContext!.stableBlocks[1]!.content,
          ).length,
          1,
        );
        childCalls += 1;
        if (scene === 'cancelled') {
          announcePending();
          return new Promise<never>((_, reject) => {
            const abort = () => {
              cancellationObserved = true;
              reject(signal.reason);
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        if (scene === 'failed') {
          assert.equal(childCalls, 1, 'classified permanent failure must not be retried');
          classifiedFailureObserved = true;
          // A classified pre-provider auth failure has no exchange receipt. This
          // deliberately makes no claim that a remote request was sent/received.
          throw new ProviderTurnFailure({
            failure_phase: 'pre_provider',
            provider_exchanges: [],
            candidate: null,
            originalFailure: new LlmRequestError({
              kind: 'auth_permanent',
              provider: 'fixture',
              status: 401,
              message: 'Synthetic permanent provider authentication failure',
            }),
          });
        }
        const write = (id: string, name: string, content: string) =>
          tool(id, 'write', { path: `record:///${name}?card=${child.id}`, content });
        const actions =
          scene === 'code'
            ? [
                {
                  kind: 'message' as const,
                  content: 'Plain prose is not an accepted workflow outcome.',
                },
                tool('invalid-result', 'emit_result', {
                  outcome: 'not_a_declared_outcome',
                  summary: 'Reject this invalid outcome.',
                }),
                write('red-write', 'status.md', 'Defect reproduced.'),
                tool('red-result', 'emit_result', {
                  outcome: 'red_confirmed',
                  summary: 'Defect reproduced.',
                }),
                write('green-one-write', 'status.md', 'First repair remains red.'),
                tool('green-one-result', 'emit_result', {
                  outcome: 'still_red',
                  summary: 'First repair remains red.',
                }),
                write('green-two-write', 'status.md', 'Second repair is green.'),
                tool('green-two-result', 'emit_result', {
                  outcome: 'green',
                  summary: 'Focused check passes.',
                }),
                write('refactor-write', 'status.md', 'No further structural cleanup justified.'),
                tool('refactor-result', 'emit_result', {
                  outcome: 'done',
                  summary: 'Repair complete.',
                }),
              ]
            : [
                write('draft-write', 'status.md', 'Initial architecture draft.'),
                tool('draft-result', 'emit_result', {
                  outcome: 'ready_for_component_review',
                  summary: 'Initial draft ready.',
                }),
                write('component-write', 'review.md', 'Component review approved.'),
                tool('component-result', 'emit_result', {
                  outcome: 'approved',
                  summary: 'Component scope approved.',
                }),
                write('system-write', 'review.md', 'System review approved.'),
                tool('system-result', 'emit_result', {
                  outcome: 'approved',
                  summary: 'System scope approved.',
                }),
              ];
        assert(actions[childCalls - 1], 'unexpected child provider callback');
        return complete(actions[childCalls - 1]!);
      }),
      conversations: { projectRoot: root },
      freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
      processRunner: new ProcessRunner(root, groups, testApplicationFatalPort),
      runtimeProcessRootScope: groups.createContainerScope(groups.rootScope, 'runtime-cards'),
      promptTemplates: createPromptTemplateRegistry(workflows),
      runtimeGate: new RuntimeGate(),
      fatalPort: testApplicationFatalPort,
    });
    assert.equal(
      (await instructionFlowDeadline(supervisor.startProject(), 'synthetic start')).started,
      true,
    );
    if (scene === 'cancelled') {
      await instructionFlowDeadline(pending, 'actual pending provider turn');
      assert.deepEqual(await instructionFlowDeadline(supervisor.stopProject(), 'actual Stop'), {
        status: 'stopped',
        contained: true,
      });
      assert(cancellationObserved);
    } else
      await instructionFlowDeadline(
        waitFor(() => supervisor!.getStatus().status === 'stopped', 'normal actor settlement'),
        'normal actor settlement',
      );
    assert.equal(supervisor.getStatus().status, 'stopped');
    assert.equal(
      cards.read(child.id)!.lifecycle.status,
      scene === 'cancelled' ? 'running' : scene === 'failed' ? 'failed' : 'done',
    );
    // Ordinary containment is complete before the independently owned read app.
    await instructionFlowDeadline(supervisor.stopProject(), 'final actor containment');
    supervisor = undefined;
    const sessions = [...new Set(starts.map((start) => start.session))].map((session) => {
      const rows = readConversation(root, session).physicalRows;
      const publicRows = foldConversation(root, session).entries;
      const expected = starts.filter((start) => start.session === session);
      const markers = rows.filter(
        (row) =>
          row.kind === 'activity' &&
          parseActivationOpenPayload(row.content, session, row.timestamp),
      );
      assert.equal(markers.length, expected.length);
      const activations = expected.map((start, index) => {
        const marker = markers[index]!;
        const instructions = parseActivationOpenPayload(
          publicRows.find((row) => row.id === marker.id)!.content,
          session,
          marker.timestamp,
        )!.instructions;
        assert.equal(instructions.kind, 'prepared');
        if (instructions.kind !== 'prepared') throw new Error('Expected actual preparation.');
        assert.deepEqual({ kind: instructions.kind, role_text: instructions.role_text, node: instructions.node }, {
          kind: 'prepared',
          role_text: start.role,
          node: { node_id: start.node, text: start.nodeText },
        });
        assert.equal(JSON.parse(marker.content).input_id, start.inputId);
        const from = rows.indexOf(marker);
        const until = index + 1 < markers.length ? rows.indexOf(markers[index + 1]!) : rows.length;
        return {
          ...start,
          markerId: marker.id,
          rowIds: rows.slice(from, until).map((row) => row.id),
        };
      });
      return { session, rows, publicRows, activations };
    });
    const settledCallbackCount = plannerCalls + childCalls;
    const containedLifecycle = cards.read(child.id)!.lifecycle;
    app = await instructionFlowDeadline(
      startProductionApp(root, instructionFlowToken),
      'read app startup',
    );
    assert.deepEqual(unexpectedProviderRequests, []);
    return {
      root,
      childId: child.id,
      origin: appOrigin(app),
      sessions,
      calls,
      childCalls,
      cancellationObserved,
      classifiedFailureObserved,
      containedLifecycle,
      readLifecycle: cards.read(child.id)!.lifecycle,
      unexpectedProviderRequests,
      settledCallbackCount,
      callbackCount: () => plannerCalls + childCalls,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
