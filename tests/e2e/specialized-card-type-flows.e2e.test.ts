import { agentExecution } from '../helpers/workflow-execution.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
import { createPromptTemplateRegistry, renderCompiledPrompt } from '../../src/utils/prompt-api.js';
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
import { effectiveSaivageConfigSchema, type SaivageConfig } from '../../src/schemas/saivage-config.js';
import { parseActivationOpenPayload } from '../../src/schemas/index.js';
import {
  foldConversation,
  foldHistoricalConversationRows,
} from '../../src/application/read-models/agent-conversation-read-model.js';

// Hang safety budget for multi-turn durable integration flows, not a runtime latency assertion.
// The 25s stopped-wait allowance leaves nominal room for setup, start and assertions.
const TEST_SAFETY_TIMEOUT_MS = 30_000;
jest.setTimeout(TEST_SAFETY_TIMEOUT_MS);

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
  const deadline = performance.now() + 25_000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('condition not reached within 25000ms');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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
  profile = 'classic-typed',
) {
  const structural = compileProjectWorkflows(config, {
    defaultPromptRoot: resolveSystemTemplate(profile).promptRoot,
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
            captureTestComposition(`${basename(root)}-summary-${summary.calls.length}`, input);
            return complete({ kind: 'message', content: summary.content });
          },
          projectProviderExchanges: jest.fn(),
        },
      }
    : {};
   let capturedCalls = 0;
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    ...summaryOverrides,
    workflows,
    projectRoot: root,
    actorStore: cards,
    provider: scriptedAdmissionProvider(jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      captureTestComposition(`${basename(root)}-${profile}-${input.agentName}-${++capturedCalls}`, input);
      if (profile === 'paad-typed') {
        const cardId = JSON.parse(input.preparedContext!.stableBlocks[0]!.content).cardId as string;
        const process = structural.cardTypes.get(cards.read(cardId)!.type)!;
        // Select by the actual prepared node block rather than infer a node from history.
        const node = [...process.states.values()].find(state => state.kind === 'node' && input.preparedContext!.stableBlocks[1]!.content.startsWith(`Current workflow node '${state.nodeId}':`));
        if (!node || node.kind !== 'node') throw new Error('Missing prepared PAAD node');
        const contract = describeNodeResultContract(process, `node:${node.nodeId}`);
        const role = renderCompiledPrompt({kind:'workflow-agent', cardType: cards.read(cardId)!.type}, agentExecution(node).agent.name, agentExecution(node).selectedAgentPrompt.compiled, {contractDescription: contract});
        expect(input.systemPrompt).toContain(role);
        expect(input.systemPrompt.split(contract)).toHaveLength(2);
        expect(input.tools.map(tool => tool.function.name).sort()).toEqual([...agentExecution(node).agent.tools.map(tool => tool.name), 'emit_result'].sort());
      }
      return provider(input, signal);
    })),
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
  type: 'code' | 'architecture' | 'data' | 'test' | 'goal',
  provider: (input: LlmInvocationInput, signal: AbortSignal) => Promise<ProviderTurnCompletion>,
  summary?: { calls: LlmInvocationInput[]; content: string },
  brief = `Exercise ${type}.`,
  profile = 'classic-typed',
) {
  const root = mkdtempSync(join(tmpdir(), `specialized-${type}-flow-`));
  roots.push(root);
  createProjectIdentity(root, `Specialized ${type}`);
  const config = testConfig();
  config.card_types = effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate(profile).config)).card_types;
  if (summary) {
    const capabilities = config.providers.test?.capabilities;
    if (!capabilities) throw new Error('test provider capabilities are missing');
    capabilities.contextWindowTokens = 30_000;
    if (type === 'data') {
      agentExecution(config.card_types.data!.workflow.nodes.schema!).correction_prompt = {
        ...agentExecution(config.card_types.data!.workflow.nodes.schema!).correction_prompt,
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
    defaultPromptRoot: resolveSystemTemplate(profile).promptRoot,
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
  return { ...runtimeHarness(root, config, provider, summary, profile), child };
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
    data?: { exit_code?: number | null; status?: string; process_id?: string };
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
        agentName: input.agentName,
        sessionId: input.sessionId,
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
  it('batches two independent findings, joins a useful run, then retains evidence through original-owner repair, compaction and STOPPED reentry', async () => {
    let reviewId = '';
    let releaseOwner = '';
    let encodingOwner = '';
    let parentCalls = 0;
    let reviewCalls = 0;
    let parentReviewCalls = 0;
    let processId = '';
    const ownerCalls = new Map<string, number>();
    let findingsUrl = '';
    const summaryCalls: LlmInvocationInput[] = [];
    const findings = 'Candidate A: release.cjs returns false, expected true per caller.txt (original release owner); encoding.cjs returns ascii, expected utf8 per caller.txt (original encoding owner). Reproduce with fixture.cjs release and fixture.cjs encoding: each actual assertion exits 1. Retain both counterexamples and publication prerequisite behavior as meaningful regression coverage. Release-dependent publication not evaluated: masked by release prerequisite, not a third defect. Arithmetic unchanged and accepted; independent broad arithmetic checks passed. Full combined acceptance gate outstanding; no assessor repair.';
    const summary = `Finite assignment only: release, encoding, dependent publication and arithmetic. ${findings}`;
    const command = (mode: string) =>
      `timeout -k 10s 15s ${JSON.stringify(process.execPath)} fixture.cjs ${mode}`;
    const status = (card: string, id: string, content: string) =>
      tool(id, 'write', { path: `record:///status.md?card=${card}`, content });
    const direction = 'Combined B is stable: release.cjs=true and encoding.cjs=utf8, sequentially repaired by original owners. Retain unchanged arithmetic acceptance; independently recheck both defects and dependent publication, then run the outstanding full gate. No source/test repair by assessor.';
    const run = harness('test', async (input, signal) => {
      const cardId = JSON.parse(input.preparedContext!.stableBlocks[0]!.content).cardId as string;
      if (input.agentName === 'reviewer') {
        expect(cardId).toBe('project');
        parentReviewCalls++;
        const actions = [
          tool('parent-review-source-release', 'read', { path: 'release.cjs' }),
          tool('parent-review-source-encoding', 'read', { path: 'encoding.cjs' }),
          tool('parent-review-revision', 'write', { path: 'record:///review.md?card=project', content: 'Combined source has release true and encoding utf8. Child acceptance is evidence, not authored fixes by this Reviewer. Parent status needs exact retained A finding locator and explicit distinction between masked A and evaluated B publication, so the finite disposition is intelligible.' }),
          tool('parent-review-return', 'emit_result', { outcome: 'revision_required', summary: 'Clarify retained finding provenance and masked A versus evaluated B in parent status; no additional product work requested.' }),
          tool('parent-review-revised-status', 'read', { path: 'record:///status.md?card=project' }),
          tool('parent-review-approved-record', 'write', { path: 'record:///review.md?card=project', content: 'Parent status now cites exact retained A findings, distinguishes masked A from passing B publication, and records combined independent/full acceptance. Source inspection agrees with B; no additional gate or source repair required.' }),
          tool('parent-review-approved', 'emit_result', { outcome: 'approved', summary: 'Finite correction/evidence disposition accepted.' }),
        ];
        if (parentReviewCalls === 6) {
          expect(JSON.stringify(latestToolResult(input))).toContain(findingsUrl);
          expect(JSON.stringify(latestToolResult(input))).toContain('masked A');
        }
        const action = actions[parentReviewCalls - 1];
        if (!action) throw new Error(`Unexpected parent review ${parentReviewCalls}`);
        return complete(action);
      }
      if (input.agentName === 'planner') {
        parentCalls++;
        const actions = [
          tool('initial-release-owner', 'activate_card', { card_id: releaseOwner, instructions: 'Deliver candidate A release implementation; later correct original scope when directed.' }),
          tool('initial-encoding-owner', 'activate_card', { card_id: encodingOwner, instructions: 'Deliver candidate A encoding implementation; later correct original scope when directed.' }),
          tool('finite-review-A', 'activate_card', { card_id: reviewId, instructions: 'Independently classify adequate arithmetic coverage, then review the finite release/encoding/publication scope on candidate A. Collect useful independent findings; do not repair.' }),
          tool('reopen-release-owner', 'reopen_card', { card_id: releaseOwner }),
          tool('repair-release-owner', 'activate_card', { card_id: releaseOwner, instructions: 'Correct release false to true from the concrete counterexample. Preserve other files. Run focused author check, not independent acceptance.' }),
          tool('reopen-encoding-owner', 'reopen_card', { card_id: encodingOwner }),
          tool('repair-encoding-owner', 'activate_card', { card_id: encodingOwner, instructions: 'Correct ascii to utf8 from the concrete counterexample. Preserve prior release repair and arithmetic. Run focused author check; combined acceptance remains outstanding.' }),
          tool('finite-review-B', 'activate_card', { card_id: reviewId, instructions: direction }),
          tool('resume-finite-review-B', 'activate_card', { card_id: reviewId, instructions: direction }),
          status('project', 'batch-parent-status', 'Both original owners repaired sequentially with focused checks. Combined B independently accepted, unchanged arithmetic evidence retained; outstanding full gate passed.'),
          tool('batch-parent-review', 'emit_result', { outcome: 'admit_review', summary: 'Finite combined repair accepted with full gate; inspect parent evidence disposition.' }),
          status('project', 'batch-parent-revision-status', `Both original owners repaired sequentially with focused checks. Combined B independently accepted after full gate. Retained A findings: ${findingsUrl}; masked A publication was not evaluated, B publication was independently evaluated PASS. Arithmetic source/assertion unchanged, prior applicable acceptance retained. No full-gate restart on intermediate edits; finite assigned obligations complete.`),
          tool('batch-parent-revised-review', 'emit_result', { outcome: 'admit_review', summary: 'Clarified original-owner evidence and exact A/B applicability for parent review.' }),
        ];
        if (parentCalls === 4) {
          expect(run.cards.read(reviewId)!.lifecycle).toMatchObject({ status: 'blocked', result: { node_id: 'verify', outcome: 'blocked' } });
          expect(JSON.stringify(latestToolResult(input))).toContain('record:///status.md');
          expect(JSON.stringify(latestToolResult(input))).toContain('release and encoding');
          const accepted = run.cards.readRecordCurrent(reviewId, 'status.md');
          if (accepted.kind !== 'found') throw new Error('Missing accepted findings');
          expect(accepted.value.projection?.accepted?.content).toBe(findings);
          findingsUrl = accepted.value.projection!.acceptedVersionUrl!;
        }
        if (parentCalls === 9) {
          expect(input.preparedContext!.stableBlocks[1]!.content).toContain("Current workflow node 'recover'");
          expect(run.cards.read(reviewId)!.lifecycle.status).toBe('stopped');
        }
        if (parentCalls === 12) {
          const transition = transitionRows(input).at(-1)!.content;
          expect(transition).toContain('Previous process node: review\nAccepted outcome: revision_required');
          expect(transition).toMatch(/record:\/\/\/review\.md\?card=project&v=\d+/u);
        }
        const action = actions[parentCalls - 1];
        if (!action) throw new Error(`Unexpected batch parent ${parentCalls}`);
        return complete(action);
      }
      if (cardId === releaseOwner || cardId === encodingOwner) {
        const count = (ownerCalls.get(cardId) ?? 0) + 1;
        ownerCalls.set(cardId, count);
        const release = cardId === releaseOwner;
        const actions = [
          tool(`deliver-${cardId}`, 'write', { path: release ? 'release.cjs' : 'encoding.cjs', content: release ? 'module.exports = false;\n' : 'module.exports = "ascii";\n' }),
          status(cardId, `initial-${cardId}`, 'Candidate A implementation delivered; independent acceptance outstanding.'),
          tool(`initial-done-${cardId}`, 'emit_result', { outcome: 'done', summary: 'Original implementation delivered for independent review.' }),
          tool(`repair-${cardId}`, 'write', { path: release ? 'release.cjs' : 'encoding.cjs', content: release ? 'module.exports = true;\n' : 'module.exports = "utf8";\n' }),
          tool(`focused-${cardId}`, 'run_command', { command: command(release ? 'release' : 'encoding') }),
          status(cardId, `repaired-${cardId}`, 'Original-owner correction passes focused check. Author evidence only; independent combined/full gate outstanding.'),
          tool(`repair-done-${cardId}`, 'emit_result', { outcome: 'done', summary: 'Focused original-owner repair complete; not independent approval.' }),
        ];
        if (count === 6) expect(latestToolResult(input)).toMatchObject({ success: true, data: { exit_code: 0 } });
        const action = actions[count - 1];
        if (!action) throw new Error(`Unexpected batch owner ${count}`);
        return complete(action);
      }
      expect(cardId).toBe(reviewId);
      reviewCalls++;
      const position = run.supervisor.getActorRuntimeReadModel().cards.find(({ cardId: id }) => id === reviewId)?.processState;
      if (position?.kind !== 'node') throw new Error('Missing batch review node');
      if (reviewCalls === 5) {
        const result = latestToolResult(input) as { success: boolean; data: { process_id: string; status: string } };
        expect(result).toMatchObject({ success: true, data: { status: 'running' } });
        processId = result.data.process_id;
      }
      if (reviewCalls === 7 || reviewCalls === 9)
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { exit_code: 1 } });
      if (reviewCalls === 11) {
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { exit_code: 3, stdout: 'publication NOT_EVALUATED: release prerequisite\n' } });
      }
      if (reviewCalls === 12) {
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { status: 'running' } });
        // This releases only the fixture's bounded independent command, not a source input.
        writeFileSync(join(run.root, 'finish-independent'), 'finish');
      }
      if (reviewCalls === 13)
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { status: 'exited', exit_code: 0, stdout: 'independent-start\nindependent 3/3 PASS\n' } });
      if (reviewCalls === 21) {
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if (reviewCalls === 22) {
        expect(position.nodeId).toBe('diagnose');
        expect(input.preparedContext!.stableBlocks.at(-1)!.content).toContain(JSON.stringify(direction));
      }
      if ([26, 27, 28, 29].includes(reviewCalls))
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { exit_code: 0 } });
      const actions = [
        tool('batch-arithmetic', 'run_command', { command: command('arithmetic') }),
        status(reviewId, 'batch-diagnosed', 'Candidate A arithmetic assertion passes, adequate coverage. Release/encoding/publication review remains assigned to verify; no coverage gap.'),
        tool('batch-ready', 'emit_result', { outcome: 'coverage_ready', summary: 'Adequate focused coverage; finite semantic inspection remains.' }),
        tool('independent-broad', 'run_command', { command: command('independent'), wait: false }),
        tool('inspect-release', 'read', { path: 'release.cjs' }),
        tool('counterexample-release', 'run_command', { command: command('release') }),
        tool('inspect-encoding', 'read', { path: 'encoding.cjs' }),
        tool('counterexample-encoding', 'run_command', { command: command('encoding') }),
        tool('inspect-caller', 'read', { path: 'caller.txt' }),
        tool('masked-publication', 'run_command', { command: command('publication') }),
        tool('observe-independent', 'wait_process', { process_id: processId, timeout_ms: 0 }),
        tool('join-independent', 'wait_process', { process_id: processId, timeout_ms: 2_000 }),
        status(reviewId, 'batch-evidence-for-compaction', `${findings}\n${'Synthetic compaction pressure, not additional findings. '.repeat(2000)}`),
        status(reviewId, 'batch-consolidated', findings),
        tool('batch-return', 'emit_result', { outcome: 'blocked', summary: 'Candidate A: release and encoding independent defects require original owners; publication masked; full combined gate outstanding.' }),
        // Accepted findings remain readable on corrected-input reactivation, not merely in summary prose.
        tool('retained-findings', 'read', { path: findingsUrl }),
        status(reviewId, 'B-diagnosed-before-stop', 'Combined B established by sequential original owners. Arithmetic source/assertion unchanged, retained acceptance. Release/encoding/dependent publication and full gate still outstanding.'),
        tool('B-ready-before-stop', 'emit_result', { outcome: 'coverage_ready', summary: 'B adequate coverage; affected independent acceptance outstanding.' }),
        tool('B-read-release-before-stop', 'read', { path: 'release.cjs' }),
        tool('B-read-encoding-before-stop', 'read', { path: 'encoding.cjs' }),
        // Call 21 is an abort-aware suspended provider turn, not an emitted result.
        tool('unused-stop-slot', 'read', { path: 'caller.txt' }),
        tool('retained-B-status-after-stop', 'read', { path: `record:///status.md?card=${reviewId}` }),
        status(reviewId, 'B-recovered-diagnosis', 'STOPPED reentry at diagnose: B remains stable, arithmetic retained; independent release/encoding/publication and mandatory full gate remain outstanding.'),
        tool('B-recovered-ready', 'emit_result', { outcome: 'coverage_ready', summary: 'B unchanged adequate coverage; verify remaining obligations.' }),
        tool('independent-B-release', 'run_command', { command: command('release') }),
        tool('independent-B-encoding', 'run_command', { command: command('encoding') }),
        tool('independent-B-publication', 'run_command', { command: command('publication') }),
        tool('outstanding-B-full', 'run_command', { command: command('full') }),
        status(reviewId, 'B-final-acceptance', 'Combined B: both source-backed findings independently rechecked PASS; dependent publication now evaluated PASS; outstanding full gate 4/4 PASS. Arithmetic unchanged, prior acceptance retained without rerunning its unrelated focused check. No assessor source/test edits; finite assigned scope complete.'),
        tool('B-done', 'emit_result', { outcome: 'done', summary: 'Combined B independently accepted after full gate; unchanged arithmetic evidence retained.' }),
      ];
      if (reviewCalls === 17) {
        expect(latestToolResult(input).success).toBe(true);
        expect(JSON.stringify(latestToolResult(input))).toContain('Candidate A');
      }
      const action = actions[reviewCalls - 1];
      if (!action) throw new Error(`Unexpected batch review ${reviewCalls}`);
      if (action.kind === 'tool_calls') {
        for (const call of action.tool_calls) {
          if (call.function.name === 'write')
            expect(JSON.parse(call.function.arguments).path).toBe(`record:///status.md?card=${reviewId}`);
        }
      }
      return complete(action);
    }, { calls: summaryCalls, content: summary }, 'Independently classify arithmetic coverage, then assess finite release, encoding and dependent publication semantics on the exact candidate named by parent. Release must be true, encoding utf8, publication requires both; arithmetic is 4. Original owners alone repair. Required final full gate covers all four; retain applicable unchanged evidence. No whole-product expansion.');
    reviewId = run.child.id;
    for (const name of ['release', 'encoding']) {
      const owner = run.cards.create({ type: 'ops', parent: 'project', title: `${name} original owner`, bootstrap_content: `Deliver candidate A ${name}.cjs, then correct independently reported defects in that file when directed. Preserve other owners' files and arithmetic; focused author checks are not independent acceptance.`, priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
      if (name === 'release') releaseOwner = owner.id;
      else encodingOwner = owner.id;
    }
    writeFileSync(join(run.root, 'caller.txt'), 'release must be true; encoding must be utf8; publication checks require release, then encoding. Arithmetic must remain 4.\n');
    writeFileSync(join(run.root, 'arithmetic.cjs'), 'module.exports = 4;\n');
    writeFileSync(join(run.root, 'fixture.cjs'), `
const fs = require('node:fs'); const a = require('node:assert/strict');
const mode = process.argv[2]; fs.appendFileSync('command-starts.txt', mode + '\\n');
const release = () => a.equal(require('./release.cjs'), true);
const encoding = () => a.equal(require('./encoding.cjs'), 'utf8');
const arithmetic = () => a.equal(require('./arithmetic.cjs'), 4);
if (mode === 'independent') {
  console.log('independent-start');
  const timer = setInterval(() => {
    if (!fs.existsSync('finish-independent')) return;
    clearInterval(timer); arithmetic(); arithmetic(); arithmetic(); console.log('independent 3/3 PASS');
  }, 5);
} else if (mode === 'release') release();
else if (mode === 'encoding') encoding();
else if (mode === 'arithmetic') arithmetic();
else if (mode === 'publication') {
  if (!require('./release.cjs')) { console.log('publication NOT_EVALUATED: release prerequisite'); process.exit(3); }
  encoding(); console.log('publication PASS');
} else if (mode === 'full') { release(); encoding(); arithmetic(); a.ok(require('./release.cjs')); console.log('full 4/4 PASS'); }
else throw new Error('Unknown fixture mode');
`);
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(() => reviewCalls === 21 || run.supervisor.getStatus().status === 'stopped');
    expect(reviewCalls).toBe(21);
    await expect(run.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    // Stop contains execution; explicit Run performs the existing durable-chain recovery.
    expect(run.cards.read(reviewId)!.lifecycle.status).toBe('running');
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(() => run.supervisor.getStatus().status === 'stopped');
    expect(parentCalls).toBe(13);
    expect(parentReviewCalls).toBe(7);
    expect(reviewCalls).toBe(30);
    expect([...ownerCalls.values()]).toEqual([7, 7]);
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(summaryCalls.some(({ providerConversation }) => providerConversation.messages.some(({ content }) => content.includes("Current workflow node 'verify'")))).toBe(true);
    expect(summaryCalls.some(({ providerConversation }) => providerConversation.messages.some(({ content }) => content.includes(findings)))).toBe(true);
    const commandStarts = readFileSync(join(run.root, 'command-starts.txt'), 'utf8').trim().split('\n');
    expect(commandStarts).toEqual(['arithmetic', 'independent', 'release', 'encoding', 'publication', 'release', 'encoding', 'release', 'encoding', 'publication', 'full']);
    expect(run.cards.read(reviewId)!.lifecycle).toMatchObject({ status: 'done', result: { node_id: 'verify', outcome: 'done' } });
    expect(run.cards.read('project')!.lifecycle).toMatchObject({ status: 'done', result: { node_id: 'review', outcome: 'approved' } });
    expect(run.cards.readRecordVersion(reviewId, 'status.md', Number(findingsUrl.match(/&v=(\d+)$/u)![1]))).toMatchObject({
      kind: 'found', value: { projection: { versionUrl: findingsUrl, artifact: { accepted: { content: findings, writer_agent: 'executor' } } } },
    });
    const rows = readConversation(run.root, cardAgentSessionId('executor', reviewId)).physicalRows;
    const writes = rows.filter(({ kind, tool }) => kind === 'tool_call' && tool === 'write');
    for (const row of writes) {
      const args = JSON.parse(JSON.parse(row.content).tool_calls[0].function.arguments);
      expect(args.path).toBe(`record:///status.md?card=${reviewId}`);
    }
    expect(readFileSync(join(run.root, 'release.cjs'), 'utf8')).toBe('module.exports = true;\n');
    expect(readFileSync(join(run.root, 'encoding.cjs'), 'utf8')).toBe('module.exports = "utf8";\n');
  });

  it.each(['diagnose', 'verify'])('curtails invalid ongoing work in %s without losing independent findings or claiming a full pass', async (phase) => {
    let childId = '';
    let parentCalls = 0;
    let calls = 0;
    let processId = '';
    let observationCount = 0;
    const evidence: object[] = [];
    const command = (script: string) => `timeout -k 10s 15s ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const status = (id: string, content: string) => tool(id, 'write', { path: `record:///status.md?card=${childId}`, content });
    const run = harness('test', async (input) => {
      if (input.agentName === 'planner') {
        parentCalls++;
        if (parentCalls === 1) return complete(tool('curtailed-activate', 'activate_card', { card_id: childId, instructions: 'Classify only the assigned two counterexamples and prerequisite. Do not author fixes or claim a full pass. Stop the controlled nonconverging command when prerequisite failure is observed.' }));
        if (parentCalls === 2) {
          expect(run.cards.read(childId)!.lifecycle).toMatchObject({ status: 'blocked', result: { node_id: phase, outcome: 'blocked' } });
          return complete(tool('curtailed-parent-status', 'write', { path: 'record:///status.md?card=project', content: 'Two independent findings returned. Prerequisite invalid; controlled run killed, full dependent gate not evaluated. Original owner action required.' }));
        }
        if (parentCalls === 3) return complete(tool('curtailed-parent-result', 'emit_result', { outcome: 'blocked', summary: 'Original owner/prerequisite correction required; no product acceptance claimed.' }));
        throw new Error('Unexpected curtailed parent');
      }
      calls++;
      const offset = phase === 'verify' ? 3 : 0;
      if (phase === 'verify' && calls <= 3) {
        const diagnosis = [
          tool('curtailed-baseline', 'run_command', { command: command("require('node:assert/strict').equal(4, 4)") }),
          status('curtailed-ready-status', 'Arithmetic focused baseline passes with adequate coverage. Two source/caller cases and prerequisite belong to verify.'),
          tool('curtailed-ready', 'emit_result', { outcome: 'coverage_ready', summary: 'Adequate focused baseline; semantic review outstanding.' }),
        ];
        return complete(diagnosis[calls - 1]!);
      }
      const step = calls - offset;
      if (step === 2 || step === 3) {
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { exit_code: 1 } });
        evidence.push(latestToolResult(input));
      }
      if (step === 4) {
        const result = latestToolResult(input);
        expect(result).toMatchObject({ success: true, data: { status: 'running', process_id: expect.any(String) } });
        processId = result.data!.process_id!;
      }
      if (step === 5) {
        observationCount++;
        const result = latestToolResult(input);
        expect(result).toMatchObject({ success: true, data: { status: 'running' } });
        if (!JSON.stringify(result).includes('prerequisite FAIL')) {
          if (observationCount >= 10) throw new Error('Controlled prerequisite never produced evidence');
          calls--;
          return complete(tool(`observe-prerequisite-${observationCount}`, 'wait_process', { process_id: processId, timeout_ms: 100 }));
        }
        evidence.push(result);
      }
      if (step === 6) {
        expect(latestToolResult(input)).toMatchObject({ success: true, data: { status: 'killed', stdout: 'prerequisite FAIL\n' } });
        evidence.push(latestToolResult(input));
      }
      const actions = [
        tool('classify-first-defect', 'run_command', { command: command("require('node:assert/strict').equal(require('./first.cjs'), true)") }),
        tool('classify-independent-defect', 'run_command', { command: command("require('node:assert/strict').equal(require('./second.cjs'), 'utf8')") }),
        tool('controlled-invalid-run', 'run_command', { command: command("console.log('prerequisite FAIL'); setInterval(() => {}, 1000)"), wait: false }),
        tool('observe-prerequisite', 'wait_process', { process_id: processId, timeout_ms: 100 }),
        tool('curtail-invalid-run', 'kill_process', { process_id: processId }),
        status('curtailed-status', 'Fixed first.cjs=false versus caller true and second.cjs=ascii versus caller utf8 independently fail actual assertions (exit1 each). Both require original implementation owners; no source/test repair by assessor. Controlled command reported prerequisite FAIL, was killed, not a full pass. Dependent/full checks NOT_EVALUATED; prerequisite correction and stable combined input needed. No coverage_ready classification of known failures.'),
        tool('curtailed-result', 'emit_result', { outcome: 'blocked', summary: 'Two independent findings and invalid prerequisite need original owners; killed ongoing run, dependent full gate unperformed.' }),
      ];
      const action = actions[step - 1];
      if (!action) throw new Error(`Unexpected curtailed step ${step}`);
      return complete(action);
    }, undefined, 'Independently classify the two fixed source/caller cases: first.cjs must be true, second.cjs utf8. Preserve independent findings; no assessor repairs. A failing prerequisite invalidates dependent full acceptance; do not waive it.');
    childId = run.child.id;
    writeFileSync(join(run.root, 'first.cjs'), 'module.exports = false;\n');
    writeFileSync(join(run.root, 'second.cjs'), 'module.exports = "ascii";\n');
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(() => run.supervisor.getStatus().status === 'stopped');
    expect(parentCalls).toBe(3);
    expect(evidence).toHaveLength(4);
    expect(readFileSync(join(run.root, 'first.cjs'), 'utf8')).toBe('module.exports = false;\n');
    expect(readFileSync(join(run.root, 'second.cjs'), 'utf8')).toBe('module.exports = "ascii";\n');
  });

  it('prepares classic parent and one-node test Executor without typed outcomes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classic-throughput-composition-'));
    roots.push(root);
    createProjectIdentity(root, 'Classic composition');
    const config = effectiveSaivageConfigSchema.parse({
      ...testConfig(),
      card_types: structuredClone(resolveSystemTemplate('classic').config.card_types),
    });
    const structural = compileProjectWorkflows(config, { defaultPromptRoot: resolveSystemTemplate('classic').promptRoot });
    publishInitialProjectRuntime(root, structural);
    const cards = new CardService(root, structural);
    const child = cards.create({ type: 'test', parent: 'project', title: 'Classic finite assessment', bootstrap_content: 'Inspect the supplied caller agreement only; no implementation or broad gate is required by this assessment-only brief.', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    let parentCalls = 0;
    let childCalls = 0;
    const inputs: Array<{ node: string; input: LlmInvocationInput }> = [];
    const run = runtimeHarness(root, config, async (input) => {
      if (input.agentName === 'planner') {
        parentCalls++;
        const actions = [
          tool('classic-activate', 'activate_card', { card_id: child.id, instructions: 'Assess only supplied caller agreement; no typed diagnosis/verify route or implementation repair is requested.' }),
          tool('classic-parent-status', 'write', { path: 'record:///status.md?card=project', content: 'Scoped classic assessment accepted; no implementation or full product acceptance claimed.' }),
          tool('classic-parent-done', 'emit_result', { outcome: 'complete_direct', summary: 'Scoped classic assessment complete.' }),
        ];
        return complete(actions[parentCalls - 1]!);
      }
      childCalls++;
      if (childCalls === 1) inputs.push({ node: 'execute', input });
      expect(outcomeEnum(input)).toEqual(['done', 'blocked', 'failed']);
      const actions = [
        tool('classic-inspect', 'read', { path: 'caller.txt' }),
        tool('classic-status', 'write', { path: `record:///status.md?card=${child.id}`, content: 'Supplied caller explicitly agrees on true; scoped inspection complete without source/test changes.' }),
        tool('classic-done', 'emit_result', { outcome: 'done', summary: 'Supplied caller agreement assessed.' }),
      ];
      if (childCalls === 2) expect(JSON.stringify(latestToolResult(input))).toContain('release must be true');
      return complete(actions[childCalls - 1]!);
    }, undefined, 'classic');
    writeFileSync(join(root, 'caller.txt'), 'release must be true; supplied agreement is true.\n');
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(() => run.supervisor.getStatus().status === 'stopped');
    expect(childCalls).toBe(3);
    expect(parentCalls).toBe(3);
    expect(run.cards.read('project')!.lifecycle.status).toBe('done');
    assertRecordedNodeInstructions(root, inputs);
  });

  it.each(['classic', 'paad-typed'])('prepares %s goal Planner and independent Reviewer with its own brief, current contract and direct parent direction', async (profile) => {
    let goalId = ''; let parentCalls = 0; let goalCalls = 0; let reviewerCalls = 0;
    const direction = 'Assess this goal only against its accepted brief. No implementation or descendant work is requested; return actual scoped evidence.';
    const run = harness('goal', async input => {
      const cardId = JSON.parse(input.preparedContext!.stableBlocks[0]!.content).cardId;
      if (cardId === 'project') {
        parentCalls++;
        if (parentCalls === 1) return complete(tool('goal-activate','activate_card',{card_id:goalId,instructions:direction}));
        if (parentCalls === 2) {
          expect(run.cards.read(goalId)!.lifecycle).toMatchObject({status:'done',result:{node_id:'review',outcome:'approved'}});
          expect(latestToolResult(input).success).toBe(true);
          return complete(tool('goal-parent-status','write',{path:'record:///status.md?card=project',content:'Scoped goal assessment returned; no implementation acceptance claimed.'}));
        }
        if (parentCalls === 3) return complete(tool('goal-parent-done','emit_result',{outcome:'complete_direct',summary:'Scoped assessment complete.'}));
        throw new Error('Unexpected goal parent call');
      }
      expect(cardId).toBe(goalId);
      expect(input.preparedContext!.stableBlocks.find(block=>block.id.startsWith('parent-direction:'))!.content).toContain(JSON.stringify(direction));
      if (input.agentName === 'reviewer') {
        reviewerCalls++;
        if (reviewerCalls === 1) return complete(tool('goal-review', 'write', {path:`record:///review.md?card=${goalId}`, content:'Independently assessed the bounded assessment-only brief and accepted status. No implementation or decomposition is required; the scoped assessment is complete.'}));
        if (reviewerCalls === 2) return complete(tool('goal-approved', 'emit_result', {outcome:'approved',summary:'Scoped assessment independently approved.'}));
        throw new Error('Unexpected goal reviewer call');
      }
      goalCalls++;
      expect(input.agentName).toBe('planner');
      if (goalCalls === 1) return complete(tool('goal-status','write',{path:`record:///status.md?card=${goalId}`,content:'Accepted goal requests assessment only. No implementation or decomposition is necessary; no work is added to manufacture alignment.'}));
      if (goalCalls === 2) return complete(tool('goal-review-admission','emit_result',{outcome:'admit_review',summary:'Assessment complete without unnecessary decomposition; ready for scoped independent review.'}));
      throw new Error('Unexpected goal call');
    }, undefined, 'Assess whether this supplied assessment-only goal needs decomposition. No implementation is requested or accepted by this goal.', profile);
    goalId = run.child.id;
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(()=>run.supervisor.getStatus().status === 'stopped');
    expect(goalCalls).toBe(2); expect(reviewerCalls).toBe(2); expect(parentCalls).toBe(3);
  });

  it.each(['repair', 'already_green'] as const)('PAAD returns a missing owner decision, re-enters after clarification and independently accepts %s', async (mode) => {
    let childId = ''; let acceptanceId = ''; let plannerCalls = 0; let codeCalls = 0; let acceptanceCalls = 0;
    const brief = 'Implement the owner-selected answer in answer.cjs. The answer must be supplied by the requirement owner, not chosen by the implementer. Preserve that accepted scope; a later owner clarification supplies only the missing value.';
    const direction = 'Owner clarification in owner-decision.txt supplies answer 42 within the accepted brief. Diagnose before ordinary scoped repair; retain already-green when appropriate. Independent acceptance remains separate.';
    const status = (card: string, id: string, content: string) => tool(id, 'write', {path: `record:///status.md?card=${card}`, content});
    const check = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:assert/strict').equal(require('./answer.cjs'), 42)")}`;
    const run = harness('code', async input => {
      if (input.agentName === 'planner') {
        plannerCalls++;
        const actions = [
          tool('first-activation', 'activate_card', {card_id: childId, instructions:'Diagnose the assigned answer implementation; return the unavailable owner decision rather than choosing a value.'}),
          tool('owner-input', 'read', {path:'owner-decision.txt'}),
          tool('clarified-activation', 'activate_card', {card_id: childId, instructions:direction}),
          tool('accept-fixed-output', 'activate_card', {card_id:acceptanceId, instructions:'Independently inspect owner-decision.txt and answer.cjs and run the fixed-input acceptance check. Do not repair the implementation.'}),
          status('project', 'parent-status', 'Owner supplied the missing answer. Implementation returned current evidence; separate fixed-input verification accepted it.'),
          tool('parent-complete', 'emit_result', {outcome:'complete_direct', summary:'Clarified implementation independently accepted.'}),
        ];
        if (plannerCalls === 2) {
          expect(latestToolResult(input).success).toBe(true);
          expect(JSON.stringify(latestToolResult(input))).toContain('Owner answer unavailable');
          expect(JSON.stringify(latestToolResult(input))).toContain('record:///status.md');
          expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'blocked', result:{node_id:'red',outcome:'blocked'}});
          captureTestComposition(`paad-${mode}-actual-blocked-parent-return`, input);
          // Simulate the requirement owner's external clarification, only after the real terminal return.
          writeFileSync(join(run.root, 'owner-decision.txt'), 'Requirement owner decision: answer 42. Existing implementation scope is unchanged.\n');
        }
        if (plannerCalls === 3) expect(JSON.stringify(latestToolResult(input))).toContain('Requirement owner decision: answer 42');
        if (plannerCalls === 4) expect(run.cards.read(childId)!.lifecycle.status).toBe('done');
        if (plannerCalls === 5) expect(run.cards.read(acceptanceId)!.lifecycle).toMatchObject({status:'done',result:{node_id:'verify',outcome:'done'}});
        const action = actions[plannerCalls - 1]; if (!action) throw new Error('Unexpected PAAD planner call');
        return complete(action);
      }
      const cardId = JSON.parse(input.preparedContext!.stableBlocks[0]!.content).cardId;
      if (cardId === childId) {
        codeCalls++;
        const actions = [
          tool('missing-decision', 'read', {path:'owner-decision.txt'}),
          status(childId, 'unavailable-status', 'Owner answer unavailable: choosing 41 versus 42 would change required behavior; no owner decision exists. Need the requirement owner to supply the answer. No implementation change made.'),
          tool('unavailable-result', 'emit_result', {outcome:'blocked',summary:'Owner answer unavailable; required input must come from requirement owner.'}),
          tool('read-clarification', 'read', {path:'owner-decision.txt'}),
          tool('diagnose-answer', 'run_command', {command:check}),
          status(childId, 'diagnosed-status', mode === 'repair' ? 'Owner answer 42 confirmed. Focused check reproduces answer 41 defect; ordinary local repair authorized.' : 'Owner answer 42 confirmed. Focused check passes on unchanged source; already green.'),
          tool('red-classification', 'emit_result', {outcome:mode === 'repair' ? 'red_confirmed' : 'already_green',summary:mode === 'repair' ? 'Answer defect reproduced.' : 'Existing answer satisfies owner decision.'}),
          ...(mode === 'repair' ? [
            tool('repair-answer', 'write', {path:'answer.cjs',content:'module.exports = 42;\n'}),
            tool('check-repair', 'run_command', {command:check}),
            status(childId, 'green-status', 'Scoped answer repair passes the focused check. Independent acceptance outstanding.'),
            tool('green-result', 'emit_result', {outcome:'green',summary:'Ordinary scoped repair passes.'}),
          ] : []),
          status(childId, 'refactor-status', 'No further structural changes justified. Owner answer check passes; separate independent acceptance required.'),
          tool('implementation-done', 'emit_result', {outcome:'done',summary:'Owner answer implemented with focused evidence.'}),
        ];
        if (codeCalls === 4) {
          expect(input.preparedContext!.stableBlocks.find(block=>block.id.startsWith('parent-direction:'))!.content).toContain(JSON.stringify(direction));
          captureTestComposition(`paad-${mode}-clarified-reentry`, input);
        }
        if (codeCalls === 6) expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code: mode === 'repair' ? 1 : 0}});
        const action = actions[codeCalls - 1]; if (!action) throw new Error('Unexpected PAAD code call');
        return complete(action);
      }
      expect(cardId).toBe(acceptanceId); acceptanceCalls++;
      const actions = [
        tool('independent-owner-read', 'read', {path:'owner-decision.txt'}),
        tool('independent-source-read', 'read', {path:'answer.cjs'}),
        tool('independent-diagnosis', 'run_command', {command:check}),
        status(acceptanceId, 'independent-diagnosed', 'Fixed input has adequate focused coverage and passes; independent source/owner comparison proceeds in verify.'),
        tool('independent-ready', 'emit_result', {outcome:'coverage_ready',summary:'Fixed-input coverage ready.'}),
        tool('independent-verify', 'run_command', {command:check}),
        status(acceptanceId, 'independent-status', 'Independent source and owner-decision inspection agree on answer 42; focused check passes; no source changes.'),
        tool('independent-done', 'emit_result', {outcome:'done',summary:'Fixed owner answer independently accepted.'}),
      ];
      if (acceptanceCalls === 4 || acceptanceCalls === 7) expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0}});
      const action = actions[acceptanceCalls - 1]; if (!action) throw new Error('Unexpected PAAD acceptance call');
      return complete(action);
    }, undefined, brief, 'paad-typed');
    childId = run.child.id;
    acceptanceId = run.cards.create({type:'test',parent:'project',title:'Independent fixed answer acceptance',bootstrap_content:'Independently accept the fixed answer.cjs against the requirement owner decision using source inspection and the focused assertion. No implementation or test edits assigned.',priority:0,urgency:'normal',created_by:'planner',depends_on:[childId]}).id;
    const original = `module.exports = ${mode === 'repair' ? 41 : 42};\n`;
    writeFileSync(join(run.root, 'answer.cjs'), original);
    const acceptedBrief = run.cards.readRecordCurrent(childId, 'brief.md');
    if (acceptedBrief.kind !== 'found') throw new Error('Missing accepted brief');
    expect((await run.supervisor.startProject()).started).toBe(true);
    await waitUntil(()=>run.supervisor.getStatus().status === 'stopped');
    expect(plannerCalls).toBe(6);
    expect(acceptanceCalls).toBe(8);
    expect(readFileSync(join(run.root, 'answer.cjs'),'utf8')).toBe(mode === 'repair' ? 'module.exports = 42;\n' : original);
    const finalBrief = run.cards.readRecordCurrent(childId, 'brief.md');
    if (finalBrief.kind !== 'found') throw new Error('Missing retained accepted brief');
    expect(finalBrief.value.projection).toEqual(acceptedBrief.value.projection);
    const activations = readConversation(run.root, cardAgentSessionId('executor',childId)).physicalRows.filter(row=>row.kind==='activity' && parseActivationOpenPayload(row.content, row.session_id, row.timestamp));
    expect(activations.length).toBe(mode === 'repair' ? 4 : 3);
  });

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

  it.each(['classic-typed', 'paad-typed'])('%s accepts a fresh adequately covered passing test baseline through diagnosis and verify-owned completion', async (profile) => {
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
    }, undefined, 'Independently verify the fixed arithmetic baseline; no source repair is assigned.', profile);
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
        content: `Current workflow node 'verify':\n\n${process.processPrompts.get(agentExecution(verify).prompt.promptId)!.text}`,
      }),
    );
    expect(nodeInputs.some(({ node }) => node === 'add-coverage' || node === 'repair')).toBe(false);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({
      status: 'done',
      result: {
        kind: 'workflow-result',
        executor: { kind: 'agent', agent: 'executor' },
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
      .processPrompts.get(agentExecution(red).correctionPrompt.promptId)!.text;
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
        executor: { kind: 'agent', agent: 'executor' },
        node_id: 'refactor',
        outcome: 'done',
        summary: 'Repair complete.',
        records: [{ name: 'status.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
  });

  it.each(['classic-typed', 'paad-typed'])('%s cycles clean architecture reviews, redrafts after system revision, and promotes the latest draft while exporting final review evidence', async (profile) => {
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
    }, undefined, 'Exercise architecture.', profile);
    supervisor = run.supervisor;
    childId = run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);
    await pendingApprovalAnnounced;
    const draft = run.workflows.cardTypes.get('architecture')!.states.get('node:draft')!;
    if (draft.kind !== 'node') throw new Error('Missing draft instruction owner.');
    const notificationText = `Reconsider the accepted architecture against the new deployment boundary.\nRecorded workflow instruction:\n${run.workflows.cardTypes.get('architecture')!.processPrompts.get(agentExecution(draft).prompt.promptId)!.text}`;
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
      const selectedText = process.processPrompts.get(agentExecution(compiledNode).prompt.promptId)!.text;
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
        executor: { kind: 'agent', agent: 'executor' },
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
  });

  it.each(['classic-typed', 'paad-typed'])('%s keeps the compiled data node authoritative across compaction and advances schema_ready to validate in one Executor session', async (profile) => {
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
            const oldText = process.processPrompts.get(agentExecution(implement).prompt.promptId)!.text;
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
      'Exercise data.',
      profile,
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
      process.processPrompts.get(agentExecution(schemaForCorrection).correctionPrompt.promptId)!.text,
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
      const text = process.processPrompts.get(agentExecution(compiled).prompt.promptId)!.text;
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
    const schemaText = process.processPrompts.get(agentExecution(schemaState).prompt.promptId)!.text;
    const validateState = process.states.get('node:validate')!;
    if (validateState.kind !== 'node') throw new Error('missing validate node');
    const validateText = process.processPrompts.get(agentExecution(validateState).prompt.promptId)!.text;
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
          content: process.processPrompts.get(agentExecution(schemaForCorrection).correctionPrompt.promptId)!.text,
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
        executor: { kind: 'agent', agent: 'executor' },
        node_id: 'validate',
        outcome: 'blocked',
        records: [{ name: 'status.md', url: expect.stringMatching(/&v=\d+$/u) }],
      },
    });
  });
});
