import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import { executorActorId } from './ids.js';
import type { LLMActor, LLMActorOutcome, LLMProviderPort } from './llm-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { cleanupInvocationSurface, invokeToolForLlm, replayToolForRecovery, surfaceToolDefinitions, type InvocationSurface, type ToolReplayOutcome, type ToolResult } from '../../tools/invocation.js';
import { buildRoleSurface } from '../../tools/role-invocation-surfaces.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ProcessRunner } from '../process-runner.js';
import { closeOpenRecordSlot, discardOpenRecordSlot } from '../records/record-slots.js';
import { cardBriefForPrompt } from '../records/card-brief.js';
import { runContractBoundedRepairLoop } from './contract-bounded-repair-loop.js';
import { appendTerminalToolProjectedStatus } from './llm-delivery-log.js';
import type { RuntimeGate } from '../runtime-gate.js';

type TerminalProcessorOutcome = Extract<CardActivationOutcome, { status: 'done' | 'failed' | 'blocked' }>;

export class TerminalCardProcessorActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'executing' } },
      executing: { on: { done: 'settled', failed: 'settled' } },
      settled: { parked: true, on: { activate: 'executing' } },
    },
  };

  readonly store?: CardActorStorePort;
  private activeProcessOwnerId: string | null = null;
  private readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;
  private readonly processRunner: ProcessRunner;

  constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; processRunner: ProcessRunner; gate?: RuntimeGate; store?: CardActorStorePort; mcpManagerProvider?: () => McpToolInvocationPort | undefined }) {
    super(args);
    this.store = args.store;
    this.processRunner = args.processRunner;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
  }

  _on_enter__executing(): void {
    this.runPendingActivation('executing', (input, signal) => this.runActivation(input, signal));
  }

  _on_recover__executing(): void {
    this._on_enter__executing();
  }

  recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): TerminalProcessorOutcome | null {
    return projectTerminalExecutorOutcome(outcome);
  }

  override async replayWaitingToolCall(llm: LLMActor): Promise<ToolReplayOutcome> {
    const outcome = llm.waitingToolOutcome();
    const processOwnerId = llm.activeReconstruction?.input.episodeContext.activationId;
    const ownerId = typeof processOwnerId === 'string' ? processOwnerId : `card:${this.cardId}:activation:recovered`;
    return replayToolForRecovery(this.executorInvocationSurface(ownerId), outcome.toolName, outcome.args);
  }

  protected override processorSnapshotContext(): Record<string, unknown> {
    return { ...super.processorSnapshotContext(), processOwnerId: this.activeProcessOwnerId };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<TerminalProcessorOutcome> {
    if (!input.activationId) throw new Error(`Terminal processor '${this.cardId}' requires activationId for process ownership.`);
    const contract = createExecutorContract();
    const llm = this.createMainLlm(executorActorId(this.cardId));
    if (llm.state() === 'idle') discardOpenRecordSlot(this.projectRoot, { cardId: this.cardId, filename: 'status.md', reason: 'new_activation' });
    const processOwnerId = input.activationId;
    const surface = this.executorInvocationSurface(processOwnerId);
    const llmInput = this.buildLlmInput(input, surface, contract);
    this.activeProcessOwnerId = processOwnerId;
    let cleanupStatus: 'done' | 'blocked' | 'failed' | 'cancelled' = 'failed';
    try {
      const outcome = await this.resumeOrStartLlm(llm, llmInput, signal);
      const result = await runContractBoundedRepairLoop<TerminalProcessorOutcome>({
        initialOutcome: outcome,
        isTerminalToolName: (name) => contract.isTerminalToolName(name),
        fail: (message) => ({ status: 'failed', summary: message, result: executorFailure(message) }),
        onPlainText: async (_outcome, control) => {
          const message = `${expectedTerminalToolMessage(contract)} Plain executor messages are not accepted as terminal results.`;
          return control.repair(message, () => llm.continueAfterPlainText(`${message} Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_result with valid JSON arguments.`, signal));
        },
        onTerminalTool: async (terminalOutcome, control) => {
          const invalidTerminal = this.validateExecutorTerminal(terminalOutcome, contract);
          if (invalidTerminal) {
            return control.repair(invalidTerminal, () => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: invalidTerminal }, signal, () => [{ role: 'user', content: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }]));
          }
          const missingRecord = this.closeRequiredStatusRecord(input.card.version_seq);
          if (missingRecord) {
            return control.repair(missingRecord, () => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: missingRecord }, signal, () => [{ role: 'user', content: `${missingRecord} Create record://status.md?v=next, then call emit_result again.` }]));
          }
          const projected = projectTerminalExecutorOutcome(terminalOutcome, contract);
          if (projected.status === 'done' && (input.notificationDelivery.hasPendingNotifications?.() ?? false)) {
            const message = 'Pending main-agent notifications arrived before terminal completion. Read the delivered notifications, update record://status.md?v=next if needed, then call emit_result again.';
            return control.repair(message, () => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: message }, signal, (inputId) => this.plannerNotificationContext(input, inputId)));
          }
          this.markTerminalProjected(terminalOutcome);
          return control.done(projected);
        },
        onNonTerminalTool: async (toolOutcome) => {
          const toolResult = await this.handleToolCall(toolOutcome, surface, signal);
          return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, (inputId) => this.plannerNotificationContext(input, inputId));
        },
      });
      if (result.kind === 'restart') throw new Error('Terminal activation repair loop cannot restart.');
      cleanupStatus = result.value.status;
      return result.value;
    } finally {
      await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: signal.aborted ? 'cancelled' : cleanupStatus });
      this.activeProcessOwnerId = null;
    }
  }

  private buildLlmInput(input: CardActivationInput, surface: InvocationSurface, contract = createExecutorContract()): LlmInvocationInput {
    const inputId = this.nextInvocationInputId('terminal');
    if (!input.activationId) throw new Error(`Terminal processor '${this.cardId}' requires activationId for process ownership.`);
    return {
      inputId,
      agentId: executorActorId(this.cardId),
      role: 'executor',
      sessionId: executorActorId(this.cardId),
      systemPrompt: `Execute terminal card ${input.card.id}: ${input.card.title}\n\n${cardBriefForPrompt(this.projectRoot, input.card)}\n\nUse process and file tools when needed. Write your current invocation status to:\nrecord://status.md?v=next\n\nDo not call emit_result until the status file exists. End by calling emit_result with status done, blocked, or failed and a summary; plain text or JSON messages are not accepted as terminal reports.`,
      contextMessages: this.plannerNotificationContext(input, inputId),
      tools: [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
    };
  }

  private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, surface: InvocationSurface, signal: AbortSignal): Promise<ToolResult> {
    if (surface.tools.has(outcome.toolName)) return await invokeToolForLlm(surface, outcome.toolName, outcome.args, signal);
    return { success: false, error: `Unsupported executor tool call '${outcome.toolName}'.` };
  }

  private executorInvocationSurface(processOwnerId: string): InvocationSurface {
    return buildRoleSurface('executor', { projectRoot: this.projectRoot, cardId: this.cardId, sessionId: processOwnerId, ownerId: processOwnerId, processRunner: this.processRunner, runtimeGate: this.gate, mcpManagerProvider: this.mcpManagerProvider });
  }

  private validateExecutorTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createExecutorContract()): string | null {
    try {
      verifyTerminalToolOutcome(contract, outcome);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private markTerminalProjected(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): void {
    appendTerminalToolProjectedStatus(this.projectRoot, {
      agent_id: outcome.agentId,
      source_input_id: outcome.inputId,
      tool_call_id: outcome.toolCallId,
      tool_name: outcome.toolName,
    });
  }

  protected get processorLabel(): string {
    return 'Terminal processor';
  }

  protected get processorKind(): 'terminal' {
    return 'terminal';
  }

  protected activationFailureOutcome(error: string): TerminalProcessorOutcome {
    return { status: 'failed', summary: error, result: executorFailure(error) };
  }

  private closeRequiredStatusRecord(cardVersionSeq: number): string | null {
    try {
      closeOpenRecordSlot(this.projectRoot, { cardId: this.cardId, filename: 'status.md', writer: 'executor', cardVersionSeq });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

export function projectTerminalExecutorOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createExecutorContract()): TerminalProcessorOutcome {
  let result: ExecutorResult;
  try {
    result = verifyTerminalToolOutcome(contract, outcome).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message, result: executorFailure(message) };
  }
  const summary = result.summary;
  if (result.status === 'done') return { status: 'done', summary, result: executorSuccess(result) };
  if (result.status === 'blocked') return { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } };
  return { status: 'failed', summary, result: executorFailure(summary) };
}

function executorSuccess(result: ExecutorResult) {
  return { kind: 'done' as const, summary: result.summary };
}

function executorFailure(error: string) {
  return { kind: 'failed' as const, summary: error };
}
