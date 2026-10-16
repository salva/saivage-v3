import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/contracts/index.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { CardService } from '../../src/cards/card-service.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
  describeNodeResultContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { specializedConfig } from '../helpers/specialized-config.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import {
  scriptedAdmissionProvider,
  testAutonomousCompaction,
} from '../helpers/llm-test-helpers.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import {
  readConversation,
  readConversationCatalog,
  readHistoricalConversationSegment,
} from '../../src/persistence/conversation-file.js';
import {
  cardAgentSessionId,
  parseConversationSessionId,
} from '../../src/schemas/conversation-session-id.js';
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { parseActivationOpenPayload } from '../../src/schemas/index.js';
import {
  foldConversation,
  foldHistoricalConversationRows,
} from '../../src/application/read-models/agent-conversation-read-model.js';

function assertRecordedNodeInstructions(
  root: string,
  starts: Array<{ node: string; input: LlmInvocationInput }>,
): void {
  const parentDirections = new Map<string, string>();
  for (const sessionId of new Set(
    starts.map(({ input }) => parseConversationSessionId(input.sessionId)),
  )) {
    const selected = starts.filter(({ input }) => input.sessionId === sessionId);
    const rows = readConversation(root, sessionId).physicalRows;
    const publicRows = foldConversation(root, sessionId).entries;
    const markers = rows.filter(
      (row) =>
        row.kind === 'activity' &&
        parseActivationOpenPayload(row.content, sessionId, row.timestamp) !== null,
    );
    expect(markers).toHaveLength(selected.length);
    selected.forEach(({ node, input }, index) => {
      const marker = markers[index]!;
      const nodeBlock = input.preparedContext!.stableBlocks[1]!;
      const instructions = parseActivationOpenPayload(
        marker.content,
        sessionId,
        marker.timestamp,
      )!.instructions;
      if (instructions.kind !== 'prepared') throw new Error('Expected actual prepared evidence.');
      expect(instructions.card).toEqual(
        JSON.parse(input.preparedContext!.stableBlocks[0]!.content),
      );
      const parentBlock = input.preparedContext!.stableBlocks.find((block) =>
        block.id.startsWith('parent-direction:'),
      );
      expect(instructions.parent_direction).toEqual(
        parentBlock ? { text: parentBlock.content } : null,
      );
      if (instructions.caller.kind === 'parent') {
        const caller = instructions.caller;
        const parentCall = readConversation(root, caller.sessionId).physicalRows.find(
          (row) =>
            row.kind === 'tool_call' &&
            row.tool_call_id === caller.toolCallId &&
            row.id.startsWith(`${caller.sourceInputId}:`),
        );
        expect(parentCall).toBeDefined();
        const args = JSON.parse(JSON.parse(parentCall!.content).tool_calls[0].function.arguments);
        expect(args.card_id).toBe(instructions.card!.cardId);
        expect(parentBlock!.content).toContain(JSON.stringify(args.instructions));
        const retained = parentDirections.get(instructions.activation_id!);
        if (retained !== undefined) expect(parentBlock!.content).toBe(retained);
        parentDirections.set(instructions.activation_id!, parentBlock!.content);
      } else {
        expect(instructions.caller).toEqual({ kind: 'root' });
        expect(instructions.card!.cardId).toBe('project');
      }
      expect(
        parseActivationOpenPayload(marker.content, sessionId, marker.timestamp)?.instructions,
      ).toMatchObject({
        kind: 'prepared',
        role_text: input.systemPrompt,
        node: { node_id: node, text: nodeBlock.content },
      });
      const publicMarker = publicRows.find((row) => row.id === marker.id)!;
      expect(
        parseActivationOpenPayload(publicMarker.content, sessionId, marker.timestamp)?.instructions,
      ).toEqual(
        parseActivationOpenPayload(marker.content, sessionId, marker.timestamp)?.instructions,
      );
      expect(
        input.providerConversation.messages.filter((row) => row.content === nodeBlock.content),
      ).toHaveLength(1);
      expect(
        input.providerConversation.messages.map((row) => row.content).join('\n'),
      ).not.toContain('instruction_origin');
    });
    const prompts = rows.filter((row) => row.instruction_origin === 'workflow_prompt');
    expect(prompts.length).toBeGreaterThan(0);
    for (const row of prompts)
      expect(publicRows.find((entry) => entry.id === row.id)?.instruction_origin).toBe(
        'workflow_prompt',
      );
    for (const row of rows.filter((row) => row.content.startsWith('Previous process node:')))
      expect(row.instruction_origin).toBeUndefined();
    const nonPromptNeighbors = rows.filter(
      (row) => row.role === 'assistant' || row.kind === 'tool_result' || row.kind === 'activity',
    );
    expect(nonPromptNeighbors.length).toBeGreaterThan(0);
    expect(nonPromptNeighbors.every((row) => row.instruction_origin === undefined)).toBe(true);
  }
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const complete = (result: LlmCompleteResult): ProviderTurnCompletion => ({
  result,
  provider_exchanges: [],
});
const tool = (id: string, name: string, args: object): LlmCompleteResult => ({
  kind: 'tool_calls',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}
function testConfig() {
  const config = specializedConfig();
  config.models = structuredClone(TEST_SAIVAGE_CONFIG.models);
  config.providers = structuredClone(TEST_SAIVAGE_CONFIG.providers);
  config.providers.test.capabilities = {
    ...config.providers.test.capabilities,
    transportProtocol: 'openai-responses',
    imageInput: true,
  };
  config.compaction = structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  return config;
}

function runtimeHarness(
  root: string,
  config: SaivageConfig,
  provider: (input: LlmInvocationInput, signal: AbortSignal) => Promise<ProviderTurnCompletion>,
  summary?: { calls: LlmInvocationInput[]; content: string },
) {
  const structural = compileProjectWorkflows(config, {
    defaultPromptRoot: resolveSystemTemplate('classic-typed').promptRoot,
  });
  initializeAndValidateCurrentGeneratedState(root, structural);
  const providerRegistry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(
    structural,
    new ModelRouter(providerRegistry),
    providerRegistry,
    config.compaction.context_utilization_fraction,
  );
  const cards = new CardService(root, structural);
  const registry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = registry.createContainerScope(
    registry.rootScope,
    'runtime-cards',
  );
  const summaryOverrides = summary
    ? {
        compactionConfig: {
          context_utilization_fraction: 0.8,
          trigger_fraction: 0.8,
          tail_fraction: 0.25,
          snap: 'compact_straddler' as const,
        },
        summarizerProvider: {
          materializeImage: async () => {
            throw new Error('Unexpected image.');
          },
          candidate: { provider: 'test', account: null, model: 'test-model' },
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
          serializeSummaryRequest: deterministicSummarySerialization,
          completeTurn: async (input: LlmInvocationInput) => {
            summary.calls.push(input);
            return complete({ kind: 'message', content: summary.content });
          },
          projectProviderExchanges: jest.fn(),
        },
      }
    : {};
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    ...summaryOverrides,
    workflows,
    projectRoot: root,
    actorStore: cards,
    provider: scriptedAdmissionProvider(jest.fn(provider)),
    conversations: { projectRoot: root },
    freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
    processRunner: new ProcessRunner(root, registry, testApplicationFatalPort),
    runtimeProcessRootScope,
    promptTemplates: createPromptTemplateRegistry(workflows),
    runtimeGate: new RuntimeGate(),
    fatalPort: testApplicationFatalPort,
  });
  return { root, cards, supervisor, workflows: structural };
}

function harness(
  type: 'code' | 'architecture' | 'data' | 'test',
  provider: (input: LlmInvocationInput, signal: AbortSignal) => Promise<ProviderTurnCompletion>,
  summary?: { calls: LlmInvocationInput[]; content: string },
  brief = `Exercise ${type}.`,
) {
  const root = mkdtempSync(join(tmpdir(), `specialized-${type}-flow-`));
  roots.push(root);
  createProjectIdentity(root, `Specialized ${type}`);
  const config = testConfig();
  if (summary) {
    const capabilities = config.providers.test?.capabilities;
    if (!capabilities) throw new Error('test provider capabilities are missing');
    capabilities.contextWindowTokens = 30_000;
    if (type === 'data') {
      config.card_types.data!.workflow.nodes.schema!.correction_prompt = {
        ...config.card_types.data!.workflow.nodes.schema!.correction_prompt,
        compactable: false,
        compaction_key: 'schema-correction',
      };
      config.card_types.data!.workflow.entries.BACKLOG!.prompt = {
        reference: 'specialized-recover',
        compactable: true,
      };
    }
  }
  const structural = compileProjectWorkflows(config, {
    defaultPromptRoot: resolveSystemTemplate('classic-typed').promptRoot,
  });
  publishInitialProjectRuntime(root, structural);
  const child = new CardService(root, structural).create({
    type,
    parent: 'project',
    title: `${type} flow`,
    bootstrap_content: brief,
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
  });
  return { ...runtimeHarness(root, config, provider, summary), child };
}

function transitionRows(input: LlmInvocationInput) {
  return input.providerConversation.messages.filter(
    (row) =>
      row.role === 'user' &&
      row.kind === 'text' &&
      row.content.startsWith('Previous process node:'),
  );
}
function latestToolResult(input: LlmInvocationInput) {
  const row = input.providerConversation.messages.filter(({ role }) => role === 'tool').at(-1);
  if (!row) throw new Error('expected a prior tool result');
  return JSON.parse(row.content) as {
    success: boolean;
    data?: { exit_code?: number | null; status?: string };
  };
}
function outcomeEnum(input: LlmInvocationInput) {
  const definition = input.tools.find(({ function: { name } }) => name === 'emit_result');
  if (!definition) throw new Error('emit_result is not installed');
  return (definition.function.parameters as { properties: { outcome: { enum: string[] } } })
    .properties.outcome.enum;
}
const passingSuite = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:assert/strict').equal(2 + 2, 4)")}`;
const addCoverageSuite = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 4)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const installFailingSuite = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 5)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const repairSuite = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 4)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const verifyInstalledSuite = `${JSON.stringify(process.execPath)} focused-test.cjs`;

// Optional task-local evidence: actual runtime provider inputs, not reconstructed prompts.
function captureTestComposition(name: string, input: LlmInvocationInput): void {
  const directory = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify(
      {
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        preparedContext: input.preparedContext,
        providerConversation: input.providerConversation,
      },
      null,
      2,
    ),
  );
}

describe('specialized production card-type flows', () => {
  it.each([
    {
      name: 'continues unfinished independent review in verify against fixed input',
      misrouted: false,
    },
    {
      name: 'returns misrouted coverage to the Planner and re-enters the same review',
      misrouted: true,
    },
  ])('$name', async ({ misrouted }) => {
    const brief =
      'Independently assess fixed A.cjs: item 1 arithmetic result and item 2 release/caller agreement. Existing arithmetic assertion is adequate and passing. Inspect source and caller for item 2; no missing assertion is assigned. Whole-product auditing is a non-goal. Return findings for another correction owner; do not author repairs.';
    const source = 'exports.sum = (a, b) => a + b;\nexports.release = () => true;\n';
    const caller = 'Caller contract: release() must return true before publishing.\n';
    const status = (id: string, content: string) =>
      tool(id, 'write', {
        path: `record:///status.md?card=${childId}`,
        content,
      });
    let childId = '';
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let plannerCalls = 0;
    let executorCalls = 0;
    const inputs: Array<{ node: string; input: LlmInvocationInput }> = [];
    const direction =
      'Assignment correction: coverage is adequate; independently resolve item 2 source/caller agreement on fixed A.cjs in verify. Retain accepted item 1; whole-product auditing remains a non-goal.';
    const run = harness(
      'test',
      async (input) => {
        if (input.agentName === 'planner') {
          plannerCalls++;
          if (plannerCalls === 1)
            return complete(
              tool('review-activate', 'activate_card', {
                card_id: childId,
                instructions:
                  'Assess the two agreed items on fixed A.cjs independently; retain the explicit non-goal.',
              }),
            );
          if (misrouted && plannerCalls === 2) {
            expect(run.cards.read(childId)!.lifecycle).toMatchObject({
              status: 'blocked',
              result: { node_id: 'add-coverage', outcome: 'blocked' },
            });
            expect(JSON.stringify(latestToolResult(input))).toContain(
              'Planner assignment correction',
            );
            expect(JSON.stringify(latestToolResult(input))).toContain('record:///status.md');
            captureTestComposition('misroute-parent-return', input);
            return complete(
              tool('correct-same-review', 'activate_card', {
                card_id: childId,
                instructions: direction,
              }),
            );
          }
          expect(latestToolResult(input).success).toBe(true);
          if (plannerCalls === (misrouted ? 3 : 2))
            return complete(
              tool('review-parent-status', 'write', {
                path: 'record:///status.md?card=project',
                content:
                  'Both agreed A review items accepted with source/caller evidence. Non-goal retained.',
              }),
            );
          if (plannerCalls === (misrouted ? 4 : 3))
            return complete(
              tool('review-parent-done', 'emit_result', {
                outcome: 'complete_direct',
                summary: 'Fixed-input independent review accepted.',
              }),
            );
          throw new Error(`Unexpected Planner call ${plannerCalls}`);
        }
        const position = supervisor
          .getActorRuntimeReadModel()
          .cards.find(({ cardId }) => cardId === childId)?.processState;
        if (position?.kind !== 'node') throw new Error('Missing review position');
        inputs.push({ node: position.nodeId, input });
        executorCalls++;
        const actions = [
          tool('review-baseline', 'run_command', { command: verifyInstalledSuite }),
          status(
            'review-diagnosed',
            'A arithmetic assertion passed: item 1 accepted. Item 2 source/caller inspection remains unperformed, not unavailable. No missing coverage identified; whole-product audit is a non-goal.',
          ),
          tool('review-classify', 'emit_result', {
            outcome: misrouted ? 'coverage_gap' : 'coverage_ready',
            summary: misrouted
              ? 'Historical erroneous classification: item 2 source/caller investigation remains.'
              : 'Adequate passing coverage; verify owns unfinished item 2 source/caller inspection.',
          }),
          ...(misrouted
            ? [
                tool('inspect-misroute', 'read', { path: 'A.cjs' }),
                status(
                  'misroute-status',
                  'No missing assertion or fixture to implement. Item 2 is unfinished source/caller verification. Need Planner assignment correction on this same independent-review child; no tests changed.',
                ),
                tool('misroute-return', 'emit_result', {
                  outcome: 'blocked',
                  summary:
                    'Need Planner assignment correction: item 2 belongs to verification, not coverage authoring; no missing assertion identified.',
                }),
                status(
                  'corrected-diagnose-status',
                  'Corrected direction retains passing A arithmetic evidence/item 1. Coverage remains adequate; item 2 goes to verify.',
                ),
                tool('corrected-ready', 'emit_result', {
                  outcome: 'coverage_ready',
                  summary:
                    'Adequate passing A coverage; corrected remaining source/caller review goes to verify.',
                }),
              ]
            : []),
          tool('inspect-fixed-source', 'read', { path: 'A.cjs' }),
          tool('find-caller-contract', 'grep', { pattern: 'release', path: 'caller.txt' }),
          tool('inspect-fixed-caller', 'read', { path: 'caller.txt' }),
          status(
            'review-accepted-status',
            'Fixed A.cjs: item 1 accepted from unchanged passing arithmetic assertion; item 2 accepted after source release() => true and caller requires true before publishing. Both required items resolved. Whole-product auditing is the agreed non-goal, not a missing gate. No source/test edits or new coverage.',
          ),
          tool('review-accepted', 'emit_result', {
            outcome: 'done',
            summary:
              'Both agreed A items accepted; source/caller agreement inspected, unchanged arithmetic evidence retained, non-goal preserved.',
          }),
        ];
        const verifyStart = misrouted ? 9 : 4;
        if (executorCalls === 2)
          expect(latestToolResult(input)).toMatchObject({
            success: true,
            data: { status: 'exited', exit_code: 0 },
          });
        if (executorCalls === verifyStart)
          captureTestComposition(`${misrouted ? 'misroute' : 'primary'}-first-verify`, input);
        if (executorCalls === verifyStart + 1) {
          expect(latestToolResult(input).success).toBe(true);
          expect(JSON.stringify(latestToolResult(input))).toContain('exports.release = () => true');
          captureTestComposition(
            `${misrouted ? 'misroute' : 'primary'}-verify-continuation`,
            input,
          );
        }
        if (executorCalls === verifyStart + 2 || executorCalls === verifyStart + 3) {
          expect(latestToolResult(input).success).toBe(true);
          expect(JSON.stringify(latestToolResult(input))).toContain(
            'must return true before publishing',
          );
        }
        if (executorCalls === verifyStart + 4)
          captureTestComposition(`${misrouted ? 'misroute' : 'primary'}-verify-verdict`, input);
        if (misrouted && executorCalls === 4) {
          expect(outcomeEnum(input)).toEqual([
            'coverage_passing',
            'repair_needed',
            'blocked',
            'failed',
          ]);
          captureTestComposition('misroute-add-coverage', input);
        }
        if (misrouted && executorCalls === 7) {
          expect(input.preparedContext!.stableBlocks.at(-1)!.content).toContain(
            JSON.stringify(direction),
          );
          captureTestComposition('misroute-blocked-reentry-fresh-direction', input);
        }
        const action = actions[executorCalls - 1];
        if (!action) throw new Error(`Unexpected review call ${executorCalls}`);
        return complete(action);
      },
      undefined,
      brief,
    );
    childId = run.child.id;
    supervisor = run.supervisor;
    writeFileSync(join(run.root, 'A.cjs'), source);
    writeFileSync(join(run.root, 'caller.txt'), caller);
    const assertion = "require('node:assert/strict').equal(require('./A.cjs').sum(2, 2), 4);\n";
    writeFileSync(join(run.root, 'focused-test.cjs'), assertion);
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(inputs.map(({ node }) => node)).toEqual([
      'diagnose',
      'diagnose',
      'diagnose',
      ...(misrouted
        ? ['add-coverage', 'add-coverage', 'add-coverage', 'diagnose', 'diagnose']
        : []),
      'verify',
      'verify',
      'verify',
      'verify',
      'verify',
    ]);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'verify', outcome: 'done' },
    });
    expect(readFileSync(join(run.root, 'A.cjs'), 'utf8')).toBe(source);
    expect(readFileSync(join(run.root, 'focused-test.cjs'), 'utf8')).toBe(assertion);
    assertRecordedNodeInstructions(
      run.root,
      inputs.filter((entry, index) => index === 0 || entry.node !== inputs[index - 1]!.node),
    );
  });

  it('returns independent findings for owner correction and adjudicates combined fixed B without restarting settled items', async () => {
    let childId = '';
    let implementationId = '';
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let plannerCalls = 0;
    let reviewCalls = 0;
    let authorCalls = 0;
    const nodes: string[] = [];
    const A = 'exports.sum = (a, b) => a + b;\nexports.release = () => false;\n';
    const B = 'exports.sum = (a, b) => a + b;\nexports.release = () => true;\n';
    const caller = 'Caller contract: release() must return true before publishing.\n';
    const ownerDirection =
      'Owner direction: return for reassignment when the release finding is established, even though further technical investigation is possible. Correction belongs to the original implementation owner; preserve settled arithmetic acceptance.';
    const finalDirection =
      'Combined fixed input B.cjs, integrated by the original implementation child, is ready for independent adjudication of item 2 release/caller agreement. Retain item 1 arithmetic acceptance: its source and assertion are unchanged. Author checks are not independent approval. A.cjs is historical evidence, not the review target.';
    const brief =
      'Independently assess item 1 arithmetic and item 2 release/caller agreement on the fixed input named by Planner. Initial input is A.cjs. Reserve all source/test correction and integration to the original implementation owner. Retain applicable settled items on repaired-input re-entry. Whole-product auditing is a non-goal. Both items require evidenced acceptance; an unavailable mandatory check cannot be waived.';
    const run = harness(
      'test',
      async (input) => {
        const cardId = JSON.parse(input.preparedContext!.stableBlocks[0]!.content).cardId as string;
        if (input.agentName === 'planner') {
          plannerCalls++;
          if (plannerCalls === 1)
            return complete(
              tool('original-author', 'activate_card', {
                card_id: implementationId,
                instructions:
                  'Deliver fixed A.cjs and record author arithmetic evidence; independent acceptance belongs to the review child.',
              }),
            );
          if (plannerCalls === 2) {
            expect(run.cards.read(implementationId)!.lifecycle.status).toBe('done');
            return complete(
              tool('independent-A', 'activate_card', {
                card_id: childId,
                instructions:
                  'Independently assess fixed A.cjs and caller.txt, two agreed items; source correction belongs to the original implementation owner.',
              }),
            );
          }
          if (plannerCalls === 3) {
            expect(run.cards.read(childId)!.lifecycle).toMatchObject({
              status: 'blocked',
              result: { node_id: 'verify', outcome: 'blocked' },
            });
            expect(JSON.stringify(latestToolResult(input))).toContain('owner reassignment');
            expect(JSON.stringify(latestToolResult(input))).toContain('record:///status.md');
            captureTestComposition('independent-parent-after-terminal-return', input);
            return complete(
              tool('reopen-original-owner', 'reopen_card', { card_id: implementationId }),
            );
          }
          if (plannerCalls === 4)
            return complete(
              tool('correct-original-owner', 'activate_card', {
                card_id: implementationId,
                instructions:
                  'Correct release false in A into combined fixed B.cjs; preserve sum and caller contract. Run author checks; do not claim independent acceptance.',
              }),
            );
          if (plannerCalls === 5) {
            expect(run.cards.read(implementationId)!.lifecycle.status).toBe('done');
            return complete(
              tool('independent-B', 'activate_card', {
                card_id: childId,
                instructions: finalDirection,
              }),
            );
          }
          if (plannerCalls === 6)
            return complete(
              tool('integrated-parent-status', 'write', {
                path: 'record:///status.md?card=project',
                content:
                  'Original implementation owner integrated B; author checks passed. Independent review reconciled item 2 on B and retained applicable item 1. Both accepted.',
              }),
            );
          if (plannerCalls === 7)
            return complete(
              tool('integrated-parent-done', 'emit_result', {
                outcome: 'complete_direct',
                summary: 'Combined B independently accepted against both agreed items.',
              }),
            );
          throw new Error(`Unexpected parent call ${plannerCalls}`);
        }
        if (cardId === implementationId) {
          authorCalls++;
          const authorStatus = (id: string, content: string) =>
            tool(id, 'write', { path: `record:///status.md?card=${implementationId}`, content });
          const actions = [
            tool('deliver-A', 'write', { path: 'A.cjs', content: A }),
            tool('author-check-A', 'run_command', { command: verifyInstalledSuite }),
            authorStatus(
              'author-status-A',
              'Fixed A.cjs delivered; arithmetic assertion passes. Author evidence only, release review is outstanding.',
            ),
            tool('author-done-A', 'emit_result', {
              outcome: 'done',
              summary:
                'A delivered; arithmetic author check passes, independent review outstanding.',
            }),
            tool('integrate-B', 'write', { path: 'B.cjs', content: B }),
            tool('author-check-B', 'run_command', {
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const a = require('node:assert/strict'); const b = require('./B.cjs'); a.equal(b.sum(2,2),4); a.equal(b.release(),true)")}`,
            }),
            authorStatus(
              'author-status-B',
              'Combined fixed B.cjs corrects release to true, retaining sum and caller contract. Both author assertions pass; independent adjudication of affected item 2 remains required.',
            ),
            tool('author-done-B', 'emit_result', {
              outcome: 'done',
              summary: 'B integrated and author checks pass, not independent acceptance.',
            }),
          ];
          if (authorCalls === 3 || authorCalls === 7)
            expect(latestToolResult(input)).toMatchObject({
              success: true,
              data: { exit_code: 0, status: 'exited' },
            });
          const action = actions[authorCalls - 1];
          if (!action) throw new Error(`Unexpected author call ${authorCalls}`);
          return complete(action);
        }
        expect(cardId).toBe(childId);
        const position = supervisor
          .getActorRuntimeReadModel()
          .cards.find(({ cardId }) => cardId === childId)?.processState;
        if (position?.kind !== 'node') throw new Error('Missing independent-review position');
        nodes.push(position.nodeId);
        reviewCalls++;
        const status = (id: string, content: string) =>
          tool(id, 'write', { path: `record:///status.md?card=${childId}`, content });
        const actions = [
          tool('independent-arithmetic', 'run_command', { command: verifyInstalledSuite }),
          status(
            'independent-diagnosed',
            'A item 1 accepted: actual arithmetic assertion passed. Coverage adequate; item 2 source/caller inspection unperformed, not unavailable.',
          ),
          tool('independent-ready', 'emit_result', {
            outcome: 'coverage_ready',
            summary:
              'Item 1 settled; adequate passing coverage, item 2 source/caller inspection belongs to verify.',
          }),
          tool('independent-read-A', 'read', { path: 'A.cjs' }),
          tool('independent-read-caller', 'read', { path: 'caller.txt' }),
          status(
            'independent-finding',
            `Fixed A.cjs item 1 accepted; item 2 concrete high-significance defect: release() returns false while caller.txt requires true before publishing. Correction/integration belongs to [[card:${implementationId}]]. No reviewed source/test edits. Work preserved; owner-requested reassignment, not unavailable tools; other investigation remains technically possible.`,
          ),
          tool('independent-owner-return', 'emit_result', {
            outcome: 'blocked',
            summary:
              'Independent finding and explicit owner reassignment: original implementation owner must correct release false versus required true and establish combined B; item 1 remains settled.',
          }),
          status(
            'independent-B-diagnosed',
            'Fresh B direction established. Item 1 source sum and assertion unchanged, prior arithmetic evidence retained. Coverage adequate; verify must independently reconcile affected item 2 on combined B.',
          ),
          tool('independent-B-ready', 'emit_result', {
            outcome: 'coverage_ready',
            summary:
              'B established; retained applicable item 1, affected item 2 requires independent adjudication.',
          }),
          tool('independent-read-B', 'read', { path: 'B.cjs' }),
          tool('independent-caller-B', 'read', { path: 'caller.txt' }),
          status(
            'independent-B-accepted',
            'Combined fixed B.cjs independently inspected: release true agrees with unchanged caller.txt; A item 2 defect is corrected in B. Item 1 sum and assertion unchanged: retain prior arithmetic acceptance. Author checks were evidence, not this independent verdict. Both required items accepted; whole-product audit remains non-goal.',
          ),
          tool('independent-B-done', 'emit_result', {
            outcome: 'done',
            summary:
              'B item 2 independently accepted from source/caller evidence; unchanged settled item 1 retained.',
          }),
        ];
        if (reviewCalls <= 7) expect(plannerCalls).toBe(2); // Delivered advice is not an activation return.
        if (reviewCalls === 1)
          expect(input.providerConversation.messages.map(({ content }) => content)).toContain(
            ownerDirection,
          );
        if (reviewCalls === 2)
          expect(latestToolResult(input)).toMatchObject({
            success: true,
            data: { exit_code: 0, status: 'exited' },
          });
        if (reviewCalls === 5)
          expect(JSON.stringify(latestToolResult(input))).toContain(
            'exports.release = () => false',
          );
        if (reviewCalls === 6 || reviewCalls === 12)
          expect(JSON.stringify(latestToolResult(input))).toContain(
            'must return true before publishing',
          );
        if (reviewCalls === 8) {
          expect(input.preparedContext!.stableBlocks.at(-1)!.content).toContain(
            JSON.stringify(finalDirection),
          );
          captureTestComposition('independent-blocked-reentry-B', input);
        }
        if (reviewCalls === 11) {
          expect(latestToolResult(input).success).toBe(true);
          expect(JSON.stringify(latestToolResult(input))).toContain('exports.release = () => true');
          captureTestComposition('independent-B-evidence-continuation', input);
        }
      if (reviewCalls === 7) captureTestComposition('independent-owner-return', input);
      if (reviewCalls === 13) captureTestComposition('independent-B-verdict', input);
        const action = actions[reviewCalls - 1];
        if (!action) throw new Error(`Unexpected independent call ${reviewCalls}`);
        return complete(action);
      },
      undefined,
      brief,
    );
    childId = run.child.id;
    supervisor = run.supervisor;
    implementationId = run.cards.create({
      type: 'ops',
      parent: 'project',
      title: 'Original implementation owner',
      bootstrap_content:
        'Deliver A.cjs; correct verified release defects into combined B.cjs when directed. Preserve arithmetic and caller semantics; run author checks. Independent acceptance belongs to the test child.',
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
    }).id;
    writeFileSync(join(run.root, 'caller.txt'), caller);
    const assertion = "require('node:assert/strict').equal(require('./A.cjs').sum(2, 2), 4);\n";
    writeFileSync(join(run.root, 'focused-test.cjs'), assertion);
    expect(
      supervisor.notifyCard(childId, {
        id: '11111111-1111-4111-8111-111111111111',
        content: ownerDirection,
        created_at: '2026-10-16T00:00:00.000Z',
        source: 'owner',
      }),
    ).toEqual({ ok: true, notificationId: '11111111-1111-4111-8111-111111111111' });
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(nodes).toEqual([
      'diagnose',
      'diagnose',
      'diagnose',
      'verify',
      'verify',
      'verify',
      'verify',
      'diagnose',
      'diagnose',
      'verify',
      'verify',
      'verify',
      'verify',
    ]);
    expect(authorCalls).toBe(8);
    expect(readFileSync(join(run.root, 'A.cjs'), 'utf8')).toBe(A);
    expect(readFileSync(join(run.root, 'B.cjs'), 'utf8')).toBe(B);
    expect(readFileSync(join(run.root, 'focused-test.cjs'), 'utf8')).toBe(assertion);
    const calls = readConversation(
      run.root,
      cardAgentSessionId('executor', childId),
    ).physicalRows.filter(({ kind }) => kind === 'tool_call');
    const invocations = calls.flatMap(({ content }) => JSON.parse(content).tool_calls) as Array<{
      function: { name: string; arguments: string };
    }>;
    expect(
      invocations
        .filter(({ function: fn }) => fn.name === 'write')
        .every(
          ({ function: fn }) =>
            JSON.parse(fn.arguments).path === `record:///status.md?card=${childId}`,
        ),
    ).toBe(true);
    expect(invocations.filter(({ function: fn }) => fn.name === 'run_command')).toHaveLength(1);
    expect(
      invocations
        .filter(({ function: fn }) => fn.name === 'read')
        .map(({ function: fn }) => JSON.parse(fn.arguments).path),
    ).toEqual(['A.cjs', 'caller.txt', 'B.cjs', 'caller.txt']);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'verify', outcome: 'done' },
    });
    expect(run.cards.read('project')!.lifecycle.status).toBe('done');
  });

  it('accepts a fresh adequately covered passing test baseline through diagnosis and verify-owned completion', async () => {
    let plannerCalls = 0;
    let executorCalls = 0;
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let childId = '';
    const nodeInputs: Array<{ node: string; input: LlmInvocationInput }> = [];
    const run = harness('test', async (input) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1)
          return complete(
            tool('activate-test', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: childId,
            }),
          );
        if (plannerCalls === 2) {
          expect(latestToolResult(input).success).toBe(true);
          return complete(
            tool('parent-status', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Test child completed through verification.',
            }),
          );
        }
        if (plannerCalls === 3)
          return complete(
            tool('parent-done', 'emit_result', {
              outcome: 'complete_direct',
              summary: 'Verified test baseline accepted.',
            }),
          );
        throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position = supervisor
        .getActorRuntimeReadModel()
        .cards.find(({ cardId }) => cardId === childId)?.processState;
      if (position?.kind !== 'node') throw new Error('missing test position');
      nodeInputs.push({ node: position.nodeId, input });
      executorCalls += 1;
      const actions = [
        tool('diagnose-suite', 'run_command', { command: passingSuite }),
        tool('diagnose-status', 'write', {
          path: `record:///status.md?card=${childId}`,
          content:
            'Target: arithmetic baseline. Command passed. Meaningful accepted-brief coverage is adequate. Classification: coverage_ready. Status: ready for verification.',
        }),
        tool('diagnose-ready', 'emit_result', {
          outcome: 'coverage_ready',
          summary: 'Meaningful coverage is adequate and focused tests pass.',
        }),
        tool('verify-suite', 'run_command', { command: passingSuite }),
        tool('verify-status', 'write', {
          path: `record:///status.md?card=${childId}`,
          content:
            'Verification reran the affected deterministic suite successfully and confirmed meaningful, stable, scoped coverage.',
        }),
        tool('verify-done', 'emit_result', {
          outcome: 'done',
          summary: 'Affected suite and coverage verified.',
        }),
      ];
      if (executorCalls === 2 || executorCalls === 5)
        expect(latestToolResult(input)).toMatchObject({
          success: true,
          data: { exit_code: 0, status: 'exited' },
        });
      if (position.nodeId === 'diagnose')
        expect(outcomeEnum(input)).toEqual([
          'coverage_ready',
          'coverage_gap',
          'failing_test',
          'blocked',
          'failed',
        ]);
      if (position.nodeId === 'verify')
        expect(outcomeEnum(input)).toEqual([
          'done',
          'coverage_gap',
          'repair_needed',
          'blocked',
          'failed',
        ]);
      return complete(actions[executorCalls - 1]!);
    });
    supervisor = run.supervisor;
    childId = run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(nodeInputs.map(({ node }) => node)).toEqual([
      'diagnose',
      'diagnose',
      'diagnose',
      'verify',
      'verify',
      'verify',
    ]);
    const firstVerify = nodeInputs.find(({ node }) => node === 'verify')!.input;
    const transition = transitionRows(firstVerify).at(-1)!.content;
    expect(transition).toContain(
      'Previous process node: diagnose\nAccepted outcome: coverage_ready',
    );
    expect(transition).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);
    const process = run.workflows.cardTypes.get('test')!;
    const verify = process.states.get('node:verify')!;
    if (verify.kind !== 'node') throw new Error('missing verify node');
    expect(firstVerify.providerConversation.messages).toContainEqual(
      expect.objectContaining({
        kind: 'synthetic_context',
        origin: 'dynamic',
        block_identity: `node-activation:${childId}:verify`,
        content: `Current workflow node 'verify':\n\n${process.processPrompts.get(verify.prompt.promptId)!.text}`,
      }),
    );
    expect(nodeInputs.some(({ node }) => node === 'add-coverage' || node === 'repair')).toBe(false);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'done',
      result: {
        kind: 'workflow-result',
        agent_name: 'executor',
        node_id: 'verify',
        outcome: 'done',
        summary: 'Affected suite and coverage verified.',
        records: [{ name: 'status.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
    expect(run.cards.read('project')!.lifecycle).toMatchObject({
      status: 'done',
      result: { outcome: 'complete_direct' },
    });
  });

  it('re-enters a genuinely blocked test from the retained old graph and completes through the new ready edge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'specialized-test-blocked-reentry-'));
    roots.push(root);
    createProjectIdentity(root, 'Blocked test re-entry');
    const oldConfig = testConfig();
    delete oldConfig.card_types.test!.workflow.nodes.diagnose!.edges.coverage_ready;
    const oldStructural = compileProjectWorkflows(oldConfig, {
      defaultPromptRoot: resolveSystemTemplate('classic-typed').promptRoot,
    });
    publishInitialProjectRuntime(root, oldStructural);
    const child = new CardService(root, oldStructural).create({
      type: 'test',
      parent: 'project',
      title: 'Blocked test',
      bootstrap_content: 'Confirm the supplied fixture with meaningful focused coverage.',
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
    });
    let oldPlannerCalls = 0;
    let oldExecutorCalls = 0;
    const oldRun = runtimeHarness(root, oldConfig, async (input) => {
      if (input.agentName === 'planner') {
        oldPlannerCalls += 1;
        if (oldPlannerCalls === 1)
          return complete(
            tool('old-activate', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: child.id,
            }),
          );
        if (oldPlannerCalls === 2)
          return complete(
            tool('old-parent-status', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Test child is blocked on the unavailable fixture.',
            }),
          );
        if (oldPlannerCalls === 3)
          return complete(
            tool('old-parent-blocked', 'emit_result', {
              outcome: 'blocked',
              summary: 'Required fixture unavailable.',
            }),
          );
        throw new Error(`Unexpected old Planner call ${oldPlannerCalls}`);
      }
      oldExecutorCalls += 1;
      if (oldExecutorCalls === 1)
        return complete(
          tool('old-child-status', 'write', {
            path: `record:///status.md?card=${child.id}`,
            content:
              'Target identified, but the required fixture is unavailable. Classification: blocked.',
          }),
        );
      if (oldExecutorCalls === 2)
        return complete(
          tool('old-child-blocked', 'emit_result', {
            outcome: 'blocked',
            summary: 'Required fixture unavailable.',
          }),
        );
      throw new Error(`Unexpected old Executor call ${oldExecutorCalls}`);
    });
    expect((await oldRun.supervisor.startProject()).started).toBe(true);
    await waitUntil(() => oldRun.supervisor.getStatus().status === 'stopped');
    expect(oldRun.cards.read(child.id)!.lifecycle.status).toBe('blocked');
    expect(oldRun.cards.read('project')!.lifecycle.status).toBe('blocked');
    const retained = oldRun.cards.readRecordCurrent(child.id, 'status.md');
    if (retained.kind !== 'found' || retained.value.projection?.acceptedVersionUrl == null)
      throw new Error('missing retained blocked evidence');
    const retainedUrl = retained.value.projection.acceptedVersionUrl;

    const currentConfig = testConfig();
    const resolvedInput = 'The required fixture is now available; rerun diagnosis against it.';
    let plannerCalls = 0;
    let executorCalls = 0;
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    const nodes: string[] = [];
    let firstExecutorInput: LlmInvocationInput | undefined;
    const resumed = runtimeHarness(root, currentConfig, async (input) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1)
          return complete(
            tool('resume-child', 'activate_card', {
              instructions: resolvedInput,
              card_id: child.id,
            }),
          );
        if (plannerCalls === 2)
          return complete(
            tool('resumed-parent-status', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Previously blocked test is now verified.',
            }),
          );
        if (plannerCalls === 3)
          return complete(
            tool('resumed-parent-done', 'emit_result', {
              outcome: 'complete_direct',
              summary: 'Resolved test accepted.',
            }),
          );
        throw new Error(`Unexpected resumed Planner call ${plannerCalls}`);
      }
      const position = supervisor
        .getActorRuntimeReadModel()
        .cards.find(({ cardId }) => cardId === child.id)?.processState;
      if (position?.kind !== 'node') throw new Error('missing resumed test position');
      nodes.push(position.nodeId);
      executorCalls += 1;
      if (!firstExecutorInput) firstExecutorInput = input;
      const actions = [
        tool('resumed-diagnose-suite', 'run_command', { command: passingSuite }),
        tool('resumed-diagnose-status', 'write', {
          path: `record:///status.md?card=${child.id}`,
          content:
            'Resolved fixture is available. Focused suite passes with meaningful adequate coverage. Classification: coverage_ready.',
        }),
        tool('resumed-ready', 'emit_result', {
          outcome: 'coverage_ready',
          summary: 'Resolved input confirms adequate passing coverage.',
        }),
        tool('resumed-verify-suite', 'run_command', { command: passingSuite }),
        tool('resumed-verify-status', 'write', {
          path: `record:///status.md?card=${child.id}`,
          content: 'Verification reran the affected suite and accepted its meaningful coverage.',
        }),
        tool('resumed-done', 'emit_result', {
          outcome: 'done',
          summary: 'Resolved test suite and coverage verified.',
        }),
      ];
      if (executorCalls === 2 || executorCalls === 5)
        expect(latestToolResult(input)).toMatchObject({
          success: true,
          data: { exit_code: 0, status: 'exited' },
        });
      return complete(actions[executorCalls - 1]!);
    });
    supervisor = resumed.supervisor;
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(nodes).toEqual(['diagnose', 'diagnose', 'diagnose', 'verify', 'verify', 'verify']);
    expect(
      firstExecutorInput?.preparedContext?.stableBlocks.filter(
        (block) =>
          block.id.startsWith('parent-direction:') &&
          block.content.includes(JSON.stringify(resolvedInput)),
      ),
    ).toHaveLength(1);
    const retainedVersion = Number(retainedUrl.match(/&v=(\d+)$/u)![1]);
    expect(resumed.cards.readRecordVersion(child.id, 'status.md', retainedVersion)).toMatchObject({
      kind: 'found',
      value: {
        projection: {
          versionUrl: retainedUrl,
          artifact: {
            accepted: {
              content:
                'Target identified, but the required fixture is unavailable. Classification: blocked.',
            },
          },
        },
      },
    });
    expect(resumed.cards.read(child.id)!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'verify', outcome: 'done' },
    });
    expect(resumed.cards.read('project')!.lifecycle.status).toBe('done');
  });

  it('re-enters retained STOPPED test state after a real abort-aware Supervisor Stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'specialized-test-stopped-reentry-'));
    roots.push(root);
    createProjectIdentity(root, 'Stopped test re-entry');
    const config = testConfig();
    const structural = compileProjectWorkflows(config, {
      defaultPromptRoot: resolveSystemTemplate('classic-typed').promptRoot,
    });
    publishInitialProjectRuntime(root, structural);
    const child = new CardService(root, structural).create({
      type: 'test',
      parent: 'project',
      title: 'Stopped test',
      bootstrap_content: 'Verify the already-covered baseline.',
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
    });
    let pendingResolve!: () => void;
    const pendingReached = new Promise<void>((resolve) => {
      pendingResolve = resolve;
    });
    let firstPlannerCalls = 0;
    let firstExecutorCalls = 0;
    const first = runtimeHarness(root, config, async (input, signal) => {
      if (input.agentName === 'planner') {
        firstPlannerCalls += 1;
        if (firstPlannerCalls === 1)
          return complete(
            tool('first-activate', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: child.id,
            }),
          );
        throw new Error(`Unexpected first Planner call ${firstPlannerCalls}`);
      }
      firstExecutorCalls += 1;
      if (firstExecutorCalls === 1)
        return complete(tool('first-suite', 'run_command', { command: passingSuite }));
      if (firstExecutorCalls === 2) {
        expect(latestToolResult(input)).toMatchObject({
          success: true,
          data: { exit_code: 0, status: 'exited' },
        });
        return complete(
          tool('accepted-before-stop', 'write', {
            path: `record:///status.md?card=${child.id}`,
            content: 'Accepted pre-stop evidence: focused suite passed with meaningful coverage.',
          }),
        );
      }
      if (firstExecutorCalls === 3)
        return complete(
          tool('ready-before-stop', 'emit_result', {
            outcome: 'coverage_ready',
            summary: 'Pre-stop diagnosis accepted adequate passing coverage.',
          }),
        );
      if (firstExecutorCalls === 4) {
        pendingResolve();
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      throw new Error(`Unexpected first Executor call ${firstExecutorCalls}`);
    });
    expect((await first.supervisor.startProject()).started).toBe(true);
    await pendingReached;
    const retained = first.cards.readRecordCurrent(child.id, 'status.md');
    if (retained.kind !== 'found' || retained.value.projection?.acceptedVersionUrl == null)
      throw new Error('missing accepted pre-stop evidence');
    const retainedUrl = retained.value.projection.acceptedVersionUrl;
    await expect(first.supervisor.stopProject()).resolves.toEqual({
      status: 'stopped',
      contained: true,
    });
    expect(first.supervisor.getStatus().status).toBe('stopped');

    let plannerCalls = 0;
    let executorCalls = 0;
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    const nodes: string[] = [];
    let firstResumedInput: LlmInvocationInput | undefined;
    const resumed = runtimeHarness(root, testConfig(), async (input) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1)
          return complete(
            tool('stopped-activate', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: child.id,
            }),
          );
        if (plannerCalls === 2)
          return complete(
            tool('stopped-parent-status', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Stopped test resumed and verified.',
            }),
          );
        if (plannerCalls === 3)
          return complete(
            tool('stopped-parent-done', 'emit_result', {
              outcome: 'complete_direct',
              summary: 'Resumed test accepted.',
            }),
          );
        throw new Error(`Unexpected resumed Planner call ${plannerCalls}`);
      }
      const position = supervisor
        .getActorRuntimeReadModel()
        .cards.find(({ cardId }) => cardId === child.id)?.processState;
      if (position?.kind !== 'node') throw new Error('missing stopped-reentry position');
      nodes.push(position.nodeId);
      executorCalls += 1;
      if (!firstResumedInput) {
        firstResumedInput = input;
        captureTestComposition('stopped-test-recovery-with-parent', input);
      }
      const actions = [
        tool('stopped-diagnose-suite', 'run_command', { command: passingSuite }),
        tool('stopped-diagnose-status', 'write', {
          path: `record:///status.md?card=${child.id}`,
          content:
            'After STOPPED re-entry, the focused suite passes with adequate meaningful coverage. Classification: coverage_ready.',
        }),
        tool('stopped-ready', 'emit_result', {
          outcome: 'coverage_ready',
          summary: 'Retained baseline remains adequately covered and passing.',
        }),
        tool('stopped-verify-suite', 'run_command', { command: passingSuite }),
        tool('stopped-verify-status', 'write', {
          path: `record:///status.md?card=${child.id}`,
          content: 'Post-stop verification accepted the affected suite and coverage.',
        }),
        tool('stopped-done', 'emit_result', {
          outcome: 'done',
          summary: 'Post-stop suite and coverage verified.',
        }),
      ];
      if (executorCalls === 2 || executorCalls === 5)
        expect(latestToolResult(input)).toMatchObject({
          success: true,
          data: { exit_code: 0, status: 'exited' },
        });
      return complete(actions[executorCalls - 1]!);
    });
    supervisor = resumed.supervisor;
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(nodes).toEqual(['diagnose', 'diagnose', 'diagnose', 'verify', 'verify', 'verify']);
    expect(firstResumedInput!.providerConversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'synthetic_context', origin: 'recovery_notice' }),
        expect.objectContaining({
          instruction_origin: 'workflow_prompt',
          content: resumed.workflows.cardTypes
            .get('test')!
            .processPrompts.get('stopped-recovery' as never)!.text,
        }),
      ]),
    );
    const retainedVersion = Number(retainedUrl.match(/&v=(\d+)$/u)![1]);
    expect(resumed.cards.readRecordVersion(child.id, 'status.md', retainedVersion)).toMatchObject({
      kind: 'found',
      value: {
        projection: {
          versionUrl: retainedUrl,
          artifact: {
            accepted: {
              content: 'Accepted pre-stop evidence: focused suite passed with meaningful coverage.',
            },
          },
        },
      },
    });
    const versions = resumed.cards.listCardVersions(child.id);
    if (versions.kind !== 'found') throw new Error('missing stopped child history');
    expect(versions.value.map(({ change }) => change?.change_reason)).toEqual(
      expect.arrayContaining(['recovery stopped lifecycle', 'STOPPED activation']),
    );
    expect(resumed.cards.read(child.id)!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'verify', outcome: 'done' },
    });
  });

  it.each([
    {
      name: 'coverage gap',
      branch: 'gap' as const,
      nodes: [
        'diagnose',
        'diagnose',
        'add-coverage',
        'add-coverage',
        'add-coverage',
        'verify',
        'verify',
        'verify',
      ],
    },
    {
      name: 'failing test',
      branch: 'failure' as const,
      nodes: [
        'diagnose',
        'diagnose',
        'diagnose',
        'repair',
        'repair',
        'repair',
        'verify',
        'verify',
        'verify',
      ],
    },
  ])(
    'preserves the $name branch through focused work and verification',
    async ({ branch, nodes: expectedNodes }) => {
      let plannerCalls = 0;
      let executorCalls = 0;
      let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
      let childId = '';
      const nodes: string[] = [];
      const run = harness('test', async (input) => {
        if (input.agentName === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1)
            return complete(
              tool(`${branch}-activate`, 'activate_card', {
                instructions: 'Complete the scoped child task with current evidence.',
                card_id: childId,
              }),
            );
          if (plannerCalls === 2)
            return complete(
              tool(`${branch}-parent-status`, 'write', {
                path: 'record:///status.md?card=project',
                content: `${branch} branch completed through verification.`,
              }),
            );
          if (plannerCalls === 3)
            return complete(
              tool(`${branch}-parent-done`, 'emit_result', {
                outcome: 'complete_direct',
                summary: `${branch} branch accepted.`,
              }),
            );
          throw new Error(`Unexpected ${branch} Planner call ${plannerCalls}`);
        }
        const position = supervisor
          .getActorRuntimeReadModel()
          .cards.find(({ cardId }) => cardId === childId)?.processState;
        if (position?.kind !== 'node') throw new Error(`missing ${branch} test position`);
        nodes.push(position.nodeId);
        executorCalls += 1;
        if (branch === 'gap') {
          const actions = [
            tool('gap-status', 'write', {
              path: `record:///status.md?card=${childId}`,
              content:
                'Required arithmetic behavior 2 + 2 = 4 has no assertion. Add focused-test.cjs asserting that exact result. Classification: coverage_gap.',
            }),
            tool('gap-result', 'emit_result', {
              outcome: 'coverage_gap',
              summary: 'Missing assertion: focused-test.cjs must assert 2 + 2 equals 4.',
            }),
            tool('gap-suite', 'run_command', { command: addCoverageSuite }),
            tool('gap-added-status', 'write', {
              path: `record:///status.md?card=${childId}`,
              content: 'Meaningful focused coverage was added and its deterministic suite passes.',
            }),
            tool('gap-covered', 'emit_result', {
              outcome: 'coverage_passing',
              summary: 'Added coverage passes.',
            }),
            tool('gap-verify-suite', 'run_command', { command: verifyInstalledSuite }),
            tool('gap-verify-status', 'write', {
              path: `record:///status.md?card=${childId}`,
              content:
                'Verification accepted the affected suite and the new coverage meaning and scope.',
            }),
            tool('gap-done', 'emit_result', {
              outcome: 'done',
              summary: 'Added coverage verified.',
            }),
          ];
          if (executorCalls === 4 || executorCalls === 7)
            expect(latestToolResult(input)).toMatchObject({
              success: true,
              data: { exit_code: 0, status: 'exited' },
            });
          return complete(actions[executorCalls - 1]!);
        }
        const actions = [
          tool('failure-suite', 'run_command', { command: installFailingSuite }),
          tool('failure-status', 'write', {
            path: `record:///status.md?card=${childId}`,
            content:
              'Focused deterministic fixture failed as observed. Classification: failing_test.',
          }),
          tool('failure-result', 'emit_result', {
            outcome: 'failing_test',
            summary: 'Focused fixture failure observed.',
          }),
          tool('repair-suite', 'run_command', { command: repairSuite }),
          tool('repair-status', 'write', {
            path: `record:///status.md?card=${childId}`,
            content: 'The bounded fixture repair is exercised by a passing deterministic suite.',
          }),
          tool('repair-passing', 'emit_result', {
            outcome: 'tests_passing',
            summary: 'Focused repair passes.',
          }),
          tool('repair-verify-suite', 'run_command', { command: verifyInstalledSuite }),
          tool('repair-verify-status', 'write', {
            path: `record:///status.md?card=${childId}`,
            content: 'Verification accepted the repaired suite and meaningful coverage.',
          }),
          tool('repair-done', 'emit_result', {
            outcome: 'done',
            summary: 'Repaired suite and coverage verified.',
          }),
        ];
        if (executorCalls === 4)
          captureTestComposition('ordinary-authorized-repair-handoff', input);
        if (executorCalls === 5)
          captureTestComposition('ordinary-authorized-repair-continuation', input);
        if (executorCalls === 2) {
          const result = latestToolResult(input);
          expect(result).toMatchObject({ success: true, data: { status: 'failed' } });
          expect(result.data?.exit_code).not.toBe(0);
        }
        if (executorCalls === 5 || executorCalls === 8)
          expect(latestToolResult(input)).toMatchObject({
            success: true,
            data: { exit_code: 0, status: 'exited' },
          });
        return complete(actions[executorCalls - 1]!);
      });
      supervisor = run.supervisor;
      childId = run.child.id;
      expect((await supervisor.startProject()).started).toBe(true);
      await waitUntil(() => supervisor.getStatus().status === 'stopped');
      expect(nodes).toEqual(expectedNodes);
      expect(run.cards.read(childId)!.lifecycle).toMatchObject({
        status: 'done',
        result: { node_id: 'verify', outcome: 'done' },
      });
    },
  );

  it('re-enters code green with increasing ordinals and versioned status evidence before refactor completion', async () => {
    let plannerCalls = 0;
    let executorCalls = 0;
    const ordinals: number[] = [];
    const transitions: string[] = [];
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let childId = '';
    const starts: Array<{ node: string; input: LlmInvocationInput }> = [];
    const run = harness('code', async (input) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1)
          return complete(
            tool('activate', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: childId,
            }),
          );
        if (plannerCalls === 2)
          return complete(
            tool('parent-write', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Code child complete.',
            }),
          );
        if (plannerCalls === 3)
          return complete(
            tool('parent-done', 'emit_result', {
              outcome: 'complete_direct',
              summary: 'Code child accepted.',
            }),
          );
        throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      executorCalls += 1;
      const position = supervisor
        .getActorRuntimeReadModel()
        .cards.find(({ cardId }) => cardId === childId)?.processState;
      if (position?.kind !== 'node') throw new Error('missing active code position');
      if (ordinals.at(-1) !== position.executionOrdinal) {
        starts.push({ node: position.nodeId, input });
        ordinals.push(position.executionOrdinal);
        transitions.push(
          ...transitionRows(input)
            .slice(-1)
            .map(({ content }) => content),
        );
      }
      const actions = [
        { kind: 'message' as const, content: 'Plain prose is not an accepted workflow outcome.' },
        tool('invalid-result', 'emit_result', {
          outcome: 'not_a_declared_outcome',
          summary: 'Reject this invalid outcome.',
        }),
        tool('red-write', 'write', {
          path: `record:///status.md?card=${childId}`,
          content: 'Defect reproduced.',
        }),
        tool('red-result', 'emit_result', {
          outcome: 'red_confirmed',
          summary: 'Defect reproduced.',
        }),
        tool('green-one-write', 'write', {
          path: `record:///status.md?card=${childId}`,
          content: 'First repair remains red.',
        }),
        tool('green-one-result', 'emit_result', {
          outcome: 'still_red',
          summary: 'First repair remains red.',
        }),
        tool('green-two-write', 'write', {
          path: `record:///status.md?card=${childId}`,
          content: 'Second repair is green.',
        }),
        tool('green-two-result', 'emit_result', {
          outcome: 'green',
          summary: 'Focused check passes.',
        }),
        tool('refactor-write', 'write', {
          path: `record:///status.md?card=${childId}`,
          content: 'No further structural cleanup justified.',
        }),
        tool('refactor-result', 'emit_result', { outcome: 'done', summary: 'Repair complete.' }),
      ];
      return complete(actions[executorCalls - 1]!);
    });
    supervisor = run.supervisor;
    childId = run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(ordinals).toEqual([0, 1, 2, 3]);
    expect(starts.map(({ node }) => node)).toEqual(['red', 'green', 'green', 'refactor']);
    assertRecordedNodeInstructions(run.root, starts);
    const rows = readConversation(run.root, `agent:executor:${childId}`).physicalRows;
    const red = run.workflows.cardTypes.get('code')!.states.get('node:red')!;
    if (red.kind !== 'node') throw new Error('Missing red correction owner.');
    const correction = run.workflows.cardTypes
      .get('code')!
      .processPrompts.get(red.correctionPrompt.promptId)!.text;
    const configuredCorrections = rows.filter((row) => row.content === correction);
    expect(
      configuredCorrections.map((row) => ({ kind: row.kind, origin: row.instruction_origin })),
    ).toEqual([
      { kind: 'model_repair', origin: 'workflow_prompt' },
      { kind: 'text', origin: 'workflow_prompt' },
    ]);
    expect(
      rows
        .filter((row) => row.kind === 'text' && row.content.includes('attempts remaining'))
        .every((row) => row.instruction_origin === undefined),
    ).toBe(true);
    expect(transitions.map((text) => text.match(/^Previous process node: ([^\n]+)/u)?.[1])).toEqual(
      ['red', 'green', 'green'],
    );
    expect(transitions[0]).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);
    expect(transitions[1]).toContain('Accepted outcome: still_red');
    expect(
      readConversation(run.root, `agent:executor:${childId}`).physicalRows.filter(
        (row) =>
          row.role === 'user' &&
          row.kind === 'text' &&
          row.content.includes('prior repair attempt remains red'),
      ),
    ).toHaveLength(1);
    expect(run.cards.read(run.child.id)!.lifecycle).toMatchObject({
      status: 'done',
      result: {
        kind: 'workflow-result',
        agent_name: 'executor',
        node_id: 'refactor',
        outcome: 'done',
        summary: 'Repair complete.',
        records: [{ name: 'status.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
  });

  // Durable multi-activation review/redraft cycles need headroom under parallel validation contention.
  it('cycles clean architecture reviews, redrafts after system revision, and promotes the latest draft while exporting final review evidence', async () => {
    let plannerCalls = 0;
    let executorCalls = 0;
    let reviewerCalls = 0;
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let childId = '';
    const nodeStarts: Array<{ node: string; input: LlmInvocationInput }> = [];
    let releasePendingApproval!: () => void;
    const pendingApprovalReleased = new Promise<void>((resolve) => {
      releasePendingApproval = resolve;
    });
    let announcePendingApproval!: () => void;
    const pendingApprovalAnnounced = new Promise<void>((resolve) => {
      announcePendingApproval = resolve;
    });
    const run = harness('architecture', async (input) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1)
          return complete(
            tool('activate', 'activate_card', {
              instructions: 'Complete the scoped child task with current evidence.',
              card_id: childId,
            }),
          );
        if (plannerCalls === 2)
          return complete(
            tool('parent-write', 'write', {
              path: 'record:///status.md?card=project',
              content: 'Architecture child complete.',
            }),
          );
        if (plannerCalls === 3)
          return complete(
            tool('parent-done', 'emit_result', {
              outcome: 'complete_direct',
              summary: 'Architecture child accepted.',
            }),
          );
        throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position = supervisor
        .getActorRuntimeReadModel()
        .cards.find(({ cardId }) => cardId === childId)?.processState;
      if (position?.kind !== 'node') throw new Error('missing architecture position');
      if (input.agentName === 'executor') {
        executorCalls += 1;
        if (executorCalls % 2 === 1) nodeStarts.push({ node: position.nodeId, input });
        const actions = [
          tool('draft-one-write', 'write', {
            path: `record:///status.md?card=${childId}`,
            content: 'Initial architecture draft.',
          }),
          tool('draft-one-result', 'emit_result', {
            outcome: 'ready_for_component_review',
            summary: 'Initial draft ready.',
          }),
          tool('draft-two-write', 'write', {
            path: `record:///status.md?card=${childId}`,
            content: 'Revised architecture draft cites system findings.',
          }),
          tool('draft-two-result', 'emit_result', {
            outcome: 'ready_for_component_review',
            summary: 'Revised draft ready.',
          }),
          tool('draft-three-write', 'write', {
            path: `record:///status.md?card=${childId}`,
            content: 'Notification-aware architecture draft.',
          }),
          tool('draft-three-result', 'emit_result', {
            outcome: 'ready_for_component_review',
            summary: 'Notification-aware draft ready.',
          }),
        ];
        return complete(actions[executorCalls - 1]!);
      }
      reviewerCalls += 1;
      if (reviewerCalls % 2 === 1) nodeStarts.push({ node: position.nodeId, input });
      const actions = [
        tool('component-one-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'Component review approved.',
        }),
        tool('component-one-result', 'emit_result', {
          outcome: 'approved',
          summary: 'Component scope approved.',
        }),
        tool('system-one-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'System revision required.',
        }),
        tool('system-one-result', 'emit_result', {
          outcome: 'revision_required',
          summary: 'Address integration invariant.',
        }),
        tool('component-two-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'Revised component review approved.',
        }),
        tool('component-two-result', 'emit_result', {
          outcome: 'approved',
          summary: 'Revised component scope approved.',
        }),
        tool('system-two-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'Final system review approved.',
        }),
        tool('system-two-result', 'emit_result', {
          outcome: 'approved',
          summary: 'System scope approved.',
        }),
        tool('component-three-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'Notification-aware component review approved.',
        }),
        tool('component-three-result', 'emit_result', {
          outcome: 'approved',
          summary: 'Notification-aware component scope approved.',
        }),
        tool('system-three-write', 'write', {
          path: `record:///review.md?card=${childId}`,
          content: 'Notification-aware system review approved.',
        }),
        tool('system-three-result', 'emit_result', {
          outcome: 'approved',
          summary: 'Notification-aware system scope approved.',
        }),
      ];
      if (reviewerCalls === 8) {
        announcePendingApproval();
        await pendingApprovalReleased;
      }
      return complete(actions[reviewerCalls - 1]!);
    });
    supervisor = run.supervisor;
    childId = run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);
    await pendingApprovalAnnounced;
    const draft = run.workflows.cardTypes.get('architecture')!.states.get('node:draft')!;
    if (draft.kind !== 'node') throw new Error('Missing draft instruction owner.');
    const notificationText = `Reconsider the accepted architecture against the new deployment boundary.\nRecorded workflow instruction:\n${run.workflows.cardTypes.get('architecture')!.processPrompts.get(draft.prompt.promptId)!.text}`;
    expect(
      supervisor.notifyCard(childId, {
        id: '11111111-1111-4111-8111-111111111111',
        content: notificationText,
        created_at: '2026-09-14T00:00:00.000Z',
        source: 'test',
      }),
    ).toEqual({ ok: true, notificationId: '11111111-1111-4111-8111-111111111111' });
    releasePendingApproval();
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(nodeStarts.map(({ node }) => node)).toEqual([
      'draft',
      'component-review',
      'system-review',
      'draft',
      'component-review',
      'system-review',
      'draft',
      'component-review',
      'system-review',
    ]);
    assertRecordedNodeInstructions(run.root, nodeStarts);
    const executorRows = readConversation(run.root, `agent:executor:${childId}`).physicalRows;
    expect(executorRows.filter((row) => row.content === notificationText)).toEqual([
      expect.objectContaining({ role: 'user', kind: 'text' }),
    ]);
    expect(
      executorRows.find((row) => row.content === notificationText)?.instruction_origin,
    ).toBeUndefined();
    const contexts = nodeStarts.slice(1).map(({ input }) => transitionRows(input).at(-1)!.content);
    expect(contexts.map((text) => text.match(/^Previous process node: ([^\n]+)/u)?.[1])).toEqual([
      'draft',
      'component-review',
      'system-review',
      'draft',
      'component-review',
      'system-review',
      'draft',
      'component-review',
    ]);
    for (const { node, input } of nodeStarts.slice(1)) {
      const messages = input.providerConversation.messages;
      let transitionIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const row = messages[index]!;
        if (
          row.role === 'user' &&
          row.kind === 'text' &&
          row.content.startsWith('Previous process node:')
        ) {
          transitionIndex = index;
          break;
        }
      }
      expect(transitionIndex).toBeGreaterThanOrEqual(0);
      expect(messages[transitionIndex]!.content).toMatch(
        /record:\/\/\/(status|review)\.md\?card=card-[a-z-]+&v=\d+/u,
      );
      const process = run.workflows.cardTypes.get('architecture')!;
      const compiledNode = process.states.get(`node:${node}`)!;
      if (compiledNode.kind !== 'node') throw new Error(`missing compiled node ${node}`);
      const selectedText = process.processPrompts.get(compiledNode.prompt.promptId)!.text;
      expect(
        messages.filter(
          (row) =>
            row.kind === 'synthetic_context' &&
            row.origin === 'dynamic' &&
            row.block_identity === `node-activation:${childId}:${node}` &&
            row.content === `Current workflow node '${node}':\n\n${selectedText}`,
        ),
      ).toHaveLength(1);
      expect(messages.slice(transitionIndex + 1).some((row) => row.content === selectedText)).toBe(
        false,
      );
    }
    const reviewUrls = contexts
      .filter((text) => text.includes('review.md?'))
      .map((text) => text.match(/record:\/\/\/review\.md\?card=[^\s]+&v=\d+/u)![0]);
    expect(new Set(reviewUrls).size).toBe(reviewUrls.length);
    for (const url of reviewUrls) {
      const version = Number(url.match(/&v=(\d+)$/u)![1]);
      const record = run.cards.readRecordVersion(childId, 'review.md', version);
      expect(record.kind === 'found' && record.value.projection.versionUrl).toBe(url);
    }
    expect(
      nodeStarts
        .filter(({ input }) => input.agentName === 'reviewer')
        .every(({ input }) => !JSON.stringify(input).includes('new deployment boundary')),
    ).toBe(true);
    expect(
      nodeStarts.find(
        ({ node, input }) =>
          node === 'draft' && JSON.stringify(input).includes('new deployment boundary'),
      ),
    ).toBeDefined();
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'done',
      result: {
        kind: 'workflow-result',
        agent_name: 'executor',
        node_id: 'draft',
        outcome: 'ready_for_component_review',
        summary: 'Notification-aware draft ready.',
        records: [{ name: 'review.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
    expect(run.cards.readRecordCurrent(childId, 'review.md')).toMatchObject({
      kind: 'found',
      value: {
        projection: { accepted: { content: 'Notification-aware system review approved.' } },
      },
    });
  }, 30_000);

  it('keeps the compiled data node authoritative across compaction and advances schema_ready to validate in one Executor session', async () => {
    const retainedHistory =
      'Owner constraint remains applicable. The runtime correction remains unresolved. An earlier implementation idea was proposed, not executed or accepted.';
    const summaryCalls: LlmInvocationInput[] = [];
    const nodeInputs: Array<{ node: string; input: LlmInvocationInput }> = [];
    let schemaCalls = 0;
    let validateCalls = 0;
    let plannerCalls = 0;
    let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
    let childId = '';
    let run!: ReturnType<typeof harness>;
    let schemaRowsBeforeResult: ReturnType<typeof readConversation>['physicalRows'] = [];
    run = harness(
      'data',
      async (input) => {
        if (input.agentName === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1)
            return complete(
              tool('activate-data', 'activate_card', {
                instructions: 'Complete the scoped child task with current evidence.',
                card_id: childId,
              }),
            );
          if (plannerCalls === 2)
            return complete(
              tool('parent-status', 'write', {
                path: 'record:///status.md?card=project',
                content: 'Data validation is blocked after schema admission.',
              }),
            );
          if (plannerCalls === 3)
            return complete(
              tool('parent-blocked', 'emit_result', {
                outcome: 'blocked',
                summary: 'Data validation requires external input.',
              }),
            );
          throw new Error(`Unexpected planner call ${plannerCalls}`);
        }
        const position = supervisor
          .getActorRuntimeReadModel()
          .cards.find(({ cardId }) => cardId === childId)?.processState;
        if (position?.kind !== 'node') throw new Error('missing data position');
        nodeInputs.push({ node: position.nodeId, input });
        if (position.nodeId === 'schema') {
          schemaCalls += 1;
          if (schemaCalls === 1) {
            const process = run.workflows.cardTypes.get('data')!;
            const implement = process.states.get('node:implement')!;
            if (implement.kind !== 'node') throw new Error('missing implement node');
            const oldText = process.processPrompts.get(implement.prompt.promptId)!.text;
            return complete({
              kind: 'message',
              content: `Current workflow node 'implement':\n\n${oldText}`,
            });
          }
          if (schemaCalls === 2)
            return complete(
              tool('schema-status', 'write', {
                path: `record:///status.md?card=${childId}`,
                content: `Draft schema with assumptions and representative evidence. ${'historical filler '.repeat(5000)}`,
              }),
            );
          if (schemaCalls === 3) {
            schemaRowsBeforeResult = readConversation(
              run.root,
              parseConversationSessionId(input.sessionId),
            ).physicalRows;
            return complete(
              tool('schema-ready', 'emit_result', {
                outcome: 'schema_ready',
                summary: 'Schema contract is ready for validation.',
              }),
            );
          }
        }
        if (position.nodeId === 'validate') {
          validateCalls += 1;
          if (validateCalls === 1)
            return complete(
              tool('validate-status', 'write', {
                path: `record:///status.md?card=${childId}`,
                content: 'Validation cannot finish without the external fixture.',
              }),
            );
          if (validateCalls === 2)
            return complete(
              tool('validate-blocked', 'emit_result', {
                outcome: 'blocked',
                summary: 'External fixture unavailable.',
              }),
            );
        }
        throw new Error(
          `Unexpected executor node/call ${position.nodeId}/${position.nodeId === 'schema' ? schemaCalls : validateCalls}`,
        );
      },
      { calls: summaryCalls, content: retainedHistory },
    );
    supervisor = run.supervisor;
    childId = run.child.id;
    run.cards.enqueueNotification(childId, {
      id: '11111111-1111-4111-8111-111111111111',
      content: 'Owner constraint: preserve the supplied field names.',
      created_at: '2026-09-11T00:00:00.000Z',
      source: 'owner',
    });

    expect((await supervisor.startProject()).started).toBe(true);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    if (summaryCalls.length === 0)
      throw new Error(
        `Expected compaction; observed nodes ${nodeInputs.map(({ node }) => node).join(',')}, project ${JSON.stringify(run.cards.read('project')!.lifecycle)}, and child ${JSON.stringify(run.cards.read(childId)!.lifecycle)}`,
      );
    expect(new Set(nodeInputs.map(({ input }) => input.sessionId))).toEqual(
      new Set([cardAgentSessionId('executor', childId)]),
    );
    const process = run.workflows.cardTypes.get('data')!;
    const summarizedSource = summaryCalls
      .flatMap(({ providerConversation }) =>
        providerConversation.messages.map(({ content }) => content),
      )
      .join('\n');
    const schemaForCorrection = process.states.get('node:schema')!;
    if (schemaForCorrection.kind !== 'node') throw new Error('missing schema correction owner');
    expect(summarizedSource).toContain('Owner constraint: preserve the supplied field names.');
    expect(summarizedSource).toContain(
      process.processPrompts.get(schemaForCorrection.correctionPrompt.promptId)!.text,
    );
    expect(summarizedSource).toContain("Current workflow node 'implement':");
    const parentDirection = nodeInputs[0]!.input.preparedContext!.stableBlocks.find((block) =>
      block.id.startsWith('parent-direction:'),
    )!;
    for (const request of summaryCalls)
      expect(
        request.providerConversation.messages.some((message) =>
          message.content.includes(parentDirection.content),
        ),
      ).toBe(true);
    for (const { node, input } of nodeInputs) {
      const compiled = process.states.get(`node:${node}`)!;
      if (compiled.kind !== 'node') throw new Error(`missing data node ${node}`);
      const text = process.processPrompts.get(compiled.prompt.promptId)!.text;
      const prepared = `Current workflow node '${node}':\n\n${text}`;
      expect(
        input.providerConversation.messages.filter(
          (row) =>
            row.kind === 'synthetic_context' &&
            row.origin === 'dynamic' &&
            row.block_identity === `node-activation:${childId}:${node}` &&
            row.content === prepared,
        ),
      ).toHaveLength(1);
      expect(
        input.providerConversation.messages.reduce(
          (count, row) => count + row.content.split(text).length - 1,
          0,
        ),
      ).toBe(1);
      const contract = describeNodeResultContract(process, `node:${node}`);
      expect(input.systemPrompt.split(contract)).toHaveLength(2);
      if (!input.preparedContext) throw new Error(`missing prepared context for data node ${node}`);
      expect(input.preparedContext.stableBlocks).toHaveLength(3);
      expect(
        input.preparedContext.stableBlocks.find((block) =>
          block.id.startsWith('parent-direction:'),
        ),
      ).toEqual(parentDirection);
    }
    const firstValidate = nodeInputs.find(({ node }) => node === 'validate')!.input;
    expect(
      firstValidate.providerConversation.messages.filter(
        (row) =>
          row.kind === 'synthetic_context' &&
          row.origin === 'history_summary' &&
          row.content.endsWith(`\n${retainedHistory}`),
      ),
    ).toHaveLength(1);
    const transitionSession = cardAgentSessionId('executor', childId);
    const recordedTransitions = new Map(
      readConversationCatalog(run.root, transitionSession).versions.flatMap(({ version }) =>
        readHistoricalConversationSegment(run.root, transitionSession, version)
          .rows.filter(
            (row) =>
              row.role === 'user' &&
              row.kind === 'text' &&
              row.content.startsWith(
                'Previous process node: schema\nAccepted outcome: schema_ready',
              ),
          )
          .map((row) => [row.id, row.content] as const),
      ),
    );
    expect(recordedTransitions.size).toBe(1);
    const transition = [...recordedTransitions.values()][0]!;
    expect(transition).toContain('Previous process node: schema\nAccepted outcome: schema_ready');
    expect(transition).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);
    const schemaState = process.states.get('node:schema')!;
    if (schemaState.kind !== 'node') throw new Error('missing schema node');
    const schemaText = process.processPrompts.get(schemaState.prompt.promptId)!.text;
    const validateState = process.states.get('node:validate')!;
    if (validateState.kind !== 'node') throw new Error('missing validate node');
    const validateText = process.processPrompts.get(validateState.prompt.promptId)!.text;
    expect(
      schemaRowsBeforeResult.some(
        (row) =>
          row.content === `Current workflow node 'schema':\n\n${schemaText}` ||
          row.content === schemaText,
      ),
    ).toBe(false);
    const finalConversation = readConversation(run.root, cardAgentSessionId('executor', childId));
    if (globalThis.process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE) {
      const evidence = globalThis.process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, 'typed-data-whole-compositions.json'), JSON.stringify({
        basis: 'Synthetic offline production Supervisor/node/LLM/supplier/compactor composition; no provider transport or model comprehension claim',
        primary: nodeInputs.map(({ node, input }) => ({ node, systemPrompt: input.systemPrompt, tools: input.tools, preparedContext: input.preparedContext, providerConversation: input.providerConversation })),
        summary: summaryCalls.map(input => ({ systemPrompt: input.systemPrompt, tools: input.tools, providerConversation: input.providerConversation })),
        inheritedHistory: finalConversation.effectiveCompactedHistory,
        effectiveRequiredFacts: finalConversation.effectiveRequiredModelFacts,
      }, null, 2));
    }
    expect(
      finalConversation.physicalRows.some(
        (row) =>
          row.content === `Current workflow node 'validate':\n\n${validateText}` ||
          row.content === validateText,
      ),
    ).toBe(false);
    const historicalRows = readHistoricalConversationSegment(
      run.root,
      cardAgentSessionId('executor', childId),
      1,
    ).rows;
    expect(
      historicalRows.some(
        (row) =>
          row.role === 'assistant' && row.content.startsWith("Current workflow node 'implement':"),
      ),
    ).toBe(true);
    expect(
      historicalRows.some(
        (row) =>
          row.content === `Current workflow node 'schema':\n\n${schemaText}` ||
          row.content === schemaText ||
          row.content === `Current workflow node 'validate':\n\n${validateText}` ||
          row.content === validateText,
      ),
    ).toBe(false);
    const originalMarker = historicalRows.find(
      (row) =>
        row.kind === 'activity' &&
        parseActivationOpenPayload(row.content, row.session_id, row.timestamp),
    )!;
    const originalInstructions = parseActivationOpenPayload(
      originalMarker.content,
      originalMarker.session_id,
      originalMarker.timestamp,
    )!.instructions;
    expect(originalInstructions).toMatchObject({
      kind: 'prepared',
      role_text: nodeInputs[0]!.input.systemPrompt,
      node: { node_id: 'schema', text: `Current workflow node 'schema':\n\n${schemaText}` },
    });
    expect(
      JSON.parse(
        foldHistoricalConversationRows(historicalRows).find((row) => row.id === originalMarker.id)!
          .content,
      ).instructions,
    ).toEqual(originalInstructions);
    expect(summarizedSource).not.toContain(nodeInputs[0]!.input.systemPrompt);
    expect(summarizedSource).not.toContain('instruction_origin');
    expect(summarizedSource).not.toContain('Prepared instructions');
    const protectedCorrection = foldConversation(
      run.root,
      cardAgentSessionId('executor', childId),
    ).segmentContext;
    expect(protectedCorrection?.kind).toBe('compacted');
    if (!protectedCorrection) throw new Error('Missing compacted context.');
    expect(protectedCorrection.protected_prompts).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ segment_version: 1 }),
        message: expect.objectContaining({
          kind: 'model_repair',
          instruction_origin: 'workflow_prompt',
          content: process.processPrompts.get(schemaForCorrection.correctionPrompt.promptId)!.text,
        }),
      }),
    );
    const compactableEntry = historicalRows.find(
      (row) =>
        row.instruction_origin === 'workflow_prompt' &&
        row.kind === 'text' &&
        row.context_policy.kind === 'content' &&
        row.context_policy.compactable,
    )!;
    expect(compactableEntry).toBeDefined();
    expect(summarizedSource).toContain(compactableEntry.content);
    expect(
      protectedCorrection.protected_prompts.some(
        (entry) => entry.message.id === compactableEntry.id,
      ),
    ).toBe(false);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'blocked',
      result: {
        kind: 'workflow-result',
        agent_name: 'executor',
        node_id: 'validate',
        outcome: 'blocked',
        records: [{ name: 'status.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
  });
});
