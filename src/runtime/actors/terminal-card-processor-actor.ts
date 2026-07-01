import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import { executorActorId } from './ids.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { buildInvocationSurface, invokeTool } from '../../tools/invocation.js';
import { createCardHistoryProvider } from '../../tools/card-history-provider.js';
import { createProcessProvider } from '../../tools/process-provider.js';
import { createPatchProvider, createWorkspaceProvider } from '../../tools/workspace-provider.js';
import { createSkillProvider } from '../../tools/skill-provider.js';
import { createMcpProvider } from '../../tools/mcp-provider.js';
import { createWebProvider } from '../../tools/web-tools.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import { processApi } from '../process-api.js';
import { closeOpenRecordSlot, discardOpenRecordSlot } from '../records/record-slots.js';
import { cardBriefForPrompt } from '../records/card-brief.js';

type TerminalProcessorOutcome = Extract<CardActivationOutcome, { status: 'done' | 'failed' }>;

const MAX_TERMINAL_CONTRACT_REPAIRS = 2;

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

  constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort; store?: CardActorStorePort; mcpManagerProvider?: () => McpToolInvocationPort | undefined }) {
    super(args);
    this.store = args.store;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
  }

  _on_enter__executing(): void {
    this.runPendingActivation('executing', (input) => this.runActivation(input));
  }

  _on_recover__executing(): void {
    throw new Error(`Terminal processor '${this.cardId}' cannot recover directly into active state 'executing'; startup recovery must project or restart the activation.`);
  }

  recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): TerminalProcessorOutcome | null {
    return this.projectExecutorTerminal(outcome);
  }

  protected override processorSnapshotContext(): Record<string, unknown> {
    return { ...super.processorSnapshotContext(), processOwnerId: this.activeProcessOwnerId };
  }

  private async runActivation(input: CardActivationInput): Promise<TerminalProcessorOutcome> {
    const contract = createExecutorContract();
    const llm = this.createMainLlm(executorActorId(this.cardId));
    discardOpenRecordSlot(this.projectRoot, { cardId: this.cardId, filename: 'status.md', reason: 'new_activation' });
    const llmInput = this.buildLlmInput(input, contract);
    this.activeProcessOwnerId = llmInput.inputId;
    let outcome = await llm.turn(llmInput);
    let repairAttempts = 0;
    for (;;) {
      if (outcome.type === 'result') {
        const message = `${expectedTerminalToolMessage(contract)} Plain executor messages are not accepted as terminal results.`;
        if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return { status: 'failed', summary: message, result: executorFailure(message) };
        repairAttempts++;
        outcome = await llm.continueAfterPlainText(`${message} Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_executor_result with valid JSON arguments.`);
        continue;
      }
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: executorFailure(outcome.error) };
      if (contract.isTerminalToolName(outcome.toolName)) {
        const invalidTerminal = this.validateExecutorTerminal(outcome, contract);
        if (invalidTerminal) {
          if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return { status: 'failed', summary: invalidTerminal, result: executorFailure(invalidTerminal) };
          repairAttempts++;
          outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: invalidTerminal }, () => [{ role: 'user', content: `${invalidTerminal} Call emit_executor_result again with valid JSON arguments.` }]);
          continue;
        }
        const missingRecord = this.closeRequiredStatusRecord(input.card.version_seq);
        if (missingRecord) {
          if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return { status: 'failed', summary: missingRecord, result: executorFailure(missingRecord) };
          repairAttempts++;
          outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://status.md?v=next, then call emit_executor_result again.` }]);
          continue;
        }
        return this.projectExecutorTerminal(outcome, contract);
      }
      const toolResult = await this.handleToolCall(outcome, llmInput.inputId);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
    }
  }

  private buildLlmInput(input: CardActivationInput, contract = createExecutorContract()): LlmInvocationInput {
    const inputId = this.nextInvocationInputId('terminal');
    return {
      inputId,
      agentId: executorActorId(this.cardId),
      role: 'executor',
      sessionId: executorActorId(this.cardId),
      systemPrompt: `Execute terminal card ${input.card.id}: ${input.card.title}\n\n${cardBriefForPrompt(this.projectRoot, input.card)}\n\nUse process and file tools when needed. Write your current invocation status to:\nrecord://status.md?v=next\n\nDo not call emit_executor_result until the status file exists. End by calling emit_executor_result; plain text or JSON messages are not accepted as terminal reports.`,
      contextMessages: this.notificationContextMessages(input, inputId),
      tools: [...TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
    };
  }

  private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, processOwnerId: string): Promise<unknown> {
    try {
      const providers = [
        createWorkspaceProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
        createPatchProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
        createProcessProvider({ projectRoot: this.projectRoot, ownerId: processOwnerId, cardId: this.cardId }),
        createWebProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
        createSkillProvider({ projectRoot: this.projectRoot, agentRole: 'executor' }),
        createMcpProvider({ mcpManagerProvider: this.mcpManagerProvider, agentRole: 'executor' }),
      ];
      providers.push(createCardHistoryProvider({ projectRoot: this.projectRoot, sessionId: processOwnerId, agentRole: 'executor' }));
      const workspaceSurface = buildInvocationSurface('executor', providers);
      if (workspaceSurface.tools.has(outcome.toolName)) return await invokeTool(workspaceSurface, outcome.toolName, outcome.args);
      throw new Error(`Unsupported executor tool call '${outcome.toolName}'.`);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  shutdownOwnedProcesses(reason = 'terminal processor shutdown'): void {
    const ownerId = this.activeProcessOwnerId;
    if (!ownerId) return;
    for (const record of processApi(this.projectRoot).listForRuntime().filter((process) => process.owner_id === ownerId && process.status === 'running')) {
      void processApi(this.projectRoot).terminate(record.id, 'SIGTERM');
    }
  }

  protected override onActivationSettled(_outcome: TerminalProcessorOutcome): void {
    super.onActivationSettled(_outcome);
    this.shutdownOwnedProcesses('terminal card settled');
    this.activeProcessOwnerId = null;
  }

  private projectExecutorTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createExecutorContract()): TerminalProcessorOutcome {
    let result: ExecutorResult;
    try {
      result = verifyTerminalToolOutcome(contract, outcome).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', summary: message, result: executorFailure(message) };
    }
    const summary = result.summary ?? result.status_text;
    if (result.status === 'done') return { status: 'done', summary, result: executorSuccess(result) };
    const error = result.error ?? summary;
    return { status: 'failed', summary: error, result: executorFailure(error, executorResultRecord(result), result.status_text) };
  }

  private validateExecutorTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createExecutorContract()): string | null {
    try {
      verifyTerminalToolOutcome(contract, outcome);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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

function executorSuccess(result: ExecutorResult) {
  const at = new Date().toISOString();
  const summary = result.summary ?? result.status_text;
  return { kind: 'executor_success' as const, executor: executorResultRecord(result), verified_at: at, latest_self_report: { result: 'done', outcome: 'done', summary, status_text: result.status_text, at }, warnings: result.warnings };
}

function executorFailure(error: string, partialResult: Record<string, unknown> | null = null, statusText = error) {
  const at = new Date().toISOString();
  return { kind: 'executor_failure' as const, error, partial_result: partialResult, latest_self_report: { result: 'failed', outcome: 'failed', summary: error, status_text: statusText, at } };
}

function executorResultRecord(result: ExecutorResult): Record<string, unknown> {
  return { ...(result.result ?? {}), warnings: result.warnings };
}
