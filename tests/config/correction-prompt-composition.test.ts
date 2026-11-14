import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentExecution } from '../helpers/workflow-execution.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { materializeSystemTemplate, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import {
  compileProjectWorkflows, describeNodeResultContract, nodeResultToolDefinition,
  type CompiledCardTypeWorkflow, type CompiledNodeContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { AgentExecutor } from '../../src/runtime/actors/agent-executor.js';
import { NodeExecution } from '../../src/runtime/actors/node-execution.js';
import type { CardActivationInput } from '../../src/runtime/actors/card-activation-owner.js';
import { buildUserContextMessage, type ProviderVisibleUserContextMessage } from '../../src/runtime/actors/conversation-session.js';
import { buildModelRepairMessage } from '../../src/runtime/actors/llm-delivery-log.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { bootstrapContextSupplier } from '../../src/runtime/records/bootstrap-context.js';
import { validateConversation } from '../../src/contracts/conversation-validation.js';
import type { ContextBlock } from '../../src/contracts/index.js';
import {
  agentMessageSchema, DURABLE_PRIMARY_CONTENT_POLICY, STRUCTURAL_ROW_POLICY, sha256Hex,
  type AgentMessage, type ConversationSessionId,
} from '../../src/schemas/index.js';
import { createSequentialRefineAccumulator } from '../../src/runtime/actors/compaction/refine-accumulator.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';

const INPUT = '11111111-1111-4111-8111-111111111111';
const REENTRY = '22222222-2222-4222-8222-222222222222';
const SESSION: ConversationSessionId = 'agent:executor:card-a';
const renderer = new AgentExecutor({} as never, {} as never) as unknown as {
  correctionContext(process: CompiledCardTypeWorkflow, node: CompiledNodeContract, violations: readonly string[], remaining: number): readonly ProviderVisibleUserContextMessage[];
  nodeStableBlocks(input: CardActivationInput, node: CompiledNodeContract, text: string): { card: ContextBlock; node: ContextBlock; parent: ContextBlock | null };
};
const facts = 'Check F-1 failed. Local change P-1 is partial and unaccepted. External effect U-1 is unknown. Refusal R-1: scope expansion was not authorized. Obligation O-1 is unresolved.';
const attempts = [
  'First attempt: local edit present, verification failed, no result submitted.',
  'Second attempt: attempted completion still has no authored status.md.',
];
const brief = 'Synthetic accepted assignment: bounded code change with a focused regression and status.md. O-1 remains unresolved.';

function text(id: string, role: 'user' | 'assistant', content: string): AgentMessage {
  return agentMessageSchema.parse({
    id, session_id: SESSION, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0,
    timestamp: '2026-11-14T00:00:00.000Z', role, kind: 'text', content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
  });
}

function boundary(inputId: string): AgentMessage {
  return agentMessageSchema.parse({
    ...text(`boundary-${inputId}`, 'user', ''), role: 'system', kind: 'activity',
    context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
    content: JSON.stringify({
      event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' },
      agent_name: 'executor', card_id: 'card-a', input_id: inputId, timestamp: '2026-11-14T00:00:00.000Z',
    }),
  });
}

async function captureSummary(rows: AgentMessage[], preparedBlocks: ContextBlock[]) {
  let captured: Parameters<SummarizerProviderPort['completeTurn']>[0] | undefined;
  const stop = new Error('Offline summary request captured');
  const accumulator = createSequentialRefineAccumulator({
    conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks,
    summarizerProvider: {
      candidate: { provider: 'test', account: null, model: 'capture-only' }, contextWindowTokens: 1_000_000, maxOutputTokens: 10_000,
      serializeSummaryRequest(input) {
        const serializedRequest = JSON.stringify(input.providerConversation.messages);
        return { serializedRequest, requestSha256: sha256Hex(serializedRequest), estimatedInputTokens: Buffer.byteLength(serializedRequest) / 4, imageCount: 0 };
      },
      async completeTurn(input) { captured = input; throw stop; },
      async materializeImage() { throw new Error('Unexpected image'); },
      projectProviderExchanges() { throw new Error('Unexpected exchange'); },
    },
    budget: { contextUtilizationFraction: 0.8 }, signal: new AbortController().signal, progress: noCompactionProgress,
  });
  await expect(accumulator.materializeThrough(rows.length)).rejects.toBe(stop);
  expect(captured).toBeDefined();
  return captured!;
}

describe.each(['classic', 'classic-typed', 'paad-typed', 'classic-git', 'newloop'] as const)('%s ordinary Executor correction composition', profile => {
  it('keeps distinct failures and correction policy across continuation, fresh entry and reentry, with separate summary orientation', async () => {
    const template = resolveSystemTemplate(profile);
    const config = materializeSystemTemplate(template, profile === 'classic-git' ? {
      delivery_branch: 'main', private_ref_namespace: 'refs/saivage/test',
      source_roots: ['src', 'tests'], excluded_paths: ['.git', '.saivage'],
    } : undefined);
    const paths: string[] = [];
    const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), {
      defaultPromptRoot: template.promptRoot, artifactObserver: ({ path }) => paths.push(resolve(path)),
    });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(path => path.startsWith(`${resolve(template.promptRoot)}/`))).toBe(true);
    const registry = createPromptTemplateRegistry(workflows);
    const process = workflows.cardTypes.get('code')!;
    const nodeId = profile === 'classic' || profile === 'classic-git' ? 'execute' : 'green';
    const node = process.states.get(`node:${nodeId}`);
    if (node?.kind !== 'node') throw new Error(`Missing ${profile}/code/${nodeId}`);
    const execution = agentExecution(node);
    expect(execution.agent.name).toBe('executor');
    expect(execution.selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'executor' });
    expect(execution.correctionPrompt).toEqual({ promptId: 'correct-execution-result', compactable: true });
    const host = process.processPrompts.get(execution.correctionPrompt.promptId)!;
    expect(resolve(host.path)).toBe(resolve(template.promptRoot, 'process/_shared/correct-execution-result.md'));
    expect(host.text).toBe(readFileSync(host.path, 'utf8'));
    expect(node.requirements.map(({ definition, mode, gate }) => [definition.name, mode, gate]))
      .toEqual([['status.md', 'continue', 'updated']]);
    const outcomes = nodeId === 'execute' ? ['done', 'blocked', 'failed'] : ['green', 'still_red', 'blocked', 'failed'];
    expect(nodeResultToolDefinition(process, `node:${nodeId}`).function.parameters).toMatchObject({
      properties: { outcome: { enum: outcomes } }, required: ['outcome', 'summary'], additionalProperties: false,
    });

    const gate = new NodeExecution({
      cardId: 'card-a', store: { readRecordCurrent: () => ({ kind: 'found', value: { projection: null } }) },
    } as never, {} as never) as unknown as {
      validateRecords(node: CompiledNodeContract, baseline: ReadonlyMap<string, { revision: number; headId: string } | null>): { violations: string[] };
    };
    const violations = gate.validateRecords(node, new Map()).violations;
    expect(violations).toEqual(["Required record 'record:///status.md?card=card-a' is missing, empty or document 0; authored content is required."]);
    const corrections = [
      renderer.correctionContext(process, node, ['emit_result is required.'], 15),
      renderer.correctionContext(process, node, violations, 14),
    ];
    expect(corrections.map(messages => messages[1]!.content)).toEqual([
      '\n\nValidation errors:\n- emit_result is required.\n\nCorrective attempts remaining before this node fails: 15.',
      `\n\nValidation errors:\n- ${violations[0]}\n\nCorrective attempts remaining before this node fails: 14.`,
    ]);
    const correctionRows = corrections.map((messages, visit) => {
      const inputId = visit === 0 ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444';
      return [
        buildModelRepairMessage({ inputId, sessionId: SESSION } as never, messages[0]!),
        buildUserContextMessage(SESSION, inputId, 'continuation_hook', 0, messages[1]!),
      ];
    });
    for (const rows of correctionRows) {
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ kind: 'model_repair', content: host.text, instruction_origin: 'workflow_prompt', context_policy: DURABLE_PRIMARY_CONTENT_POLICY });
      expect(rows[1]!.kind).toBe('text');
      expect(rows[1]!.context_policy).toEqual(DURABLE_PRIMARY_CONTENT_POLICY);
      expect(rows[1]!.instruction_origin).toBeUndefined();
    }
    const history = [
      boundary(INPUT), text('prior-facts', 'user', facts),
      text('attempt-1', 'assistant', attempts[0]!), ...correctionRows[0]!,
      text('attempt-2', 'assistant', attempts[1]!), ...correctionRows[1]!,
    ];
    validateConversation(SESSION, history);
    const expectedSource = [facts, attempts[0]!, ...corrections[0]!.map(m => m.content), attempts[1]!, ...corrections[1]!.map(m => m.content)];
    const input = {
      activationId: INPUT, card: { id: 'card-a', type: 'code', title: 'Synthetic code assignment' },
      caller: { kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project', sourceInputId: INPUT,
        toolCallId: 'activate-code', toolName: 'activate_card', instructions: 'Synthetic parent obligation O-1 is unresolved.' },
    } as unknown as CardActivationInput;
    const projection = {
      headId: INPUT, revision: 1, state: 'closed', currentUrl: 'record:///brief.md?card=card-a', acceptedVersionUrl: 'record:///brief.md?card=card-a&v=1',
      accepted: { source_entry_id: INPUT, source_version: 1, content_sha256: sha256Hex(brief), content: brief }, draft: null, baseline: null,
    };
    const store = { workflows, readRecordCurrent: (_id: string, name: string) => ({ kind: 'found', value: { projection: name === 'brief.md' ? projection : null } }) };
    for (const phase of ['continuation', 'fresh', 'reentry'] as const) {
      const currentInput = { ...input, activationId: phase === 'continuation' ? INPUT : REENTRY };
      const rows = phase === 'fresh' ? [boundary(REENTRY)] : phase === 'reentry' ? [...history, boundary(REENTRY)] : history;
      const contract = describeNodeResultContract(process, `node:${nodeId}`);
      expect(contract).toContain(outcomes.join(' | '));
      expect(contract).toContain('status.md (continue + updated)');
      const role = registry.render({ kind: 'workflow-agent', cardType: 'code' }, execution.agent.name, { contractDescription: contract });
      expect(role.split(contract)).toHaveLength(2);
      const blocks = renderer.nodeStableBlocks(currentInput, node, process.processPrompts.get(execution.prompt.promptId)!.text);
      const bootstrap = bootstrapContextSupplier(store as never, input.card, node)({
        inputId: currentInput.activationId, conversation: validateConversation(SESSION, rows),
      });
      const prepared = [blocks.card, blocks.node, blocks.parent!, ...bootstrap.recordBlocks];
      const allRows = [...rows, ...bootstrap.rows];
      const primary = providerConversationFromComposedContext(composeContextProjection({
        sourceSessionId: SESSION, effectiveHistory: null, dynamicBlocks: prepared, uncoveredRows: allRows,
      }));
      expect(primary.messages.filter(m => m.kind === 'synthetic_context' && m.origin === 'dynamic'))
        .toEqual(prepared.map(block => expect.objectContaining({ block_identity: block.id, content: block.content })));
      expect(primary.messages.filter(m => m.content === blocks.node.content)).toHaveLength(1);
      expect(primary.messages.some(m => m.content === role)).toBe(false);
      expect(bootstrap.recordBlocks[0]!.content).toContain(brief);
      const primarySource = primary.messages.filter(m => m.kind !== 'synthetic_context').map(m => m.content);
      if (phase === 'fresh') expect(primarySource).toEqual(bootstrap.rows.filter(row => row.kind === 'record_prompt').map(row => row.content));
      else expect(primarySource.slice(0, expectedSource.length)).toEqual(expectedSource);
      expect(primarySource.filter(content => content === host.text)).toHaveLength(phase === 'fresh' ? 0 : 2);
      if (phase === 'fresh') continue;
      const summary = await captureSummary(allRows, prepared);
      expect(summary.systemPrompt).not.toBe(role);
      expect(summary.providerConversation.messages.slice(0, prepared.length).map(m => m.content))
        .toEqual(prepared.map((block, index) => `[order ${index + 1}/${summary.providerConversation.messages.length}] [kind=prepared_context source=${block.id}]\n${block.content}`));
      const summarySource = summary.providerConversation.messages.slice(prepared.length).map(m => m.content);
      for (const [index, content] of expectedSource.entries()) expect(summarySource[index]!.endsWith(`\n${content}`)).toBe(true);
      expect(summary.providerConversation.messages.some(m => m.content === role || m.content === contract)).toBe(false);
    }
  });
});
