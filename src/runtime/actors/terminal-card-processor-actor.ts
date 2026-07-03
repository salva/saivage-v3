import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import { executorActorId } from './ids.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { buildInvocationSurface, invokeTool, surfaceToolDefinitions, type InvocationSurface } from '../../tools/invocation.js';
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
import { runContractBoundedRepairLoop } from './contract-bounded-repair-loop.js';

type TerminalProcessorOutcome = Extract<CardActivationOutcome, { status: 'done' | 'failed' }>;

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
    const outcome = await llm.turn(llmInput);
    return runContractBoundedRepairLoop<TerminalProcessorOutcome>({
      initialOutcome: outcome,
      isTerminalToolName: (name) => contract.isTerminalToolName(name),
      fail: (message) => ({ status: 'failed', summary: message, result: executorFailure(message) }),
      onPlainText: async (_outcome, control) => {
        const message = `${expectedTerminalToolMessage(contract)} Plain executor messages are not accepted as terminal results.`;
        return control.repair(message, () => llm.continueAfterPlainText(`${message} Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_result with valid JSON arguments.`));
      },
      onTerminalTool: async (terminalOutcome, control) => {
        const invalidTerminal = this.validateExecutorTerminal(terminalOutcome, contract);
        if (invalidTerminal) {
          return control.repair(invalidTerminal, () => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: invalidTerminal }, () => [{ role: 'user', content: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }]));
        }
        const missingRecord = this.closeRequiredStatusRecord(input.card.version_seq);
        if (missingRecord) {
          return control.repair(missingRecord, () => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://status.md?v=next, then call emit_result again.` }]));
        }
        return control.done(this.projectExecutorTerminal(terminalOutcome, contract));
      },
      onNonTerminalTool: async (toolOutcome) => {
        const toolResult = await this.handleToolCall(toolOutcome, llmInput.inputId);
        return llm.appendToolResult(toolOutcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
      },
    });
  }

  private buildLlmInput(input: CardActivationInput, contract = createExecutorContract()): LlmInvocationInput {
    const inputId = this.nextInvocationInputId('terminal');
    const surface = this.executorInvocationSurface(inputId);
    return {
      inputId,
      agentId: executorActorId(this.cardId),
      role: 'executor',
      sessionId: executorActorId(this.cardId),
      systemPrompt: `Execute terminal card ${input.card.id}: ${input.card.title}\n\n${cardBriefForPrompt(this.projectRoot, input.card)}\n\nUse process and file tools when needed. Write your current invocation status to:\nrecord://status.md?v=next\n\nDo not call emit_result until the status file exists. End by calling emit_result with status done or failed and a summary; plain text or JSON messages are not accepted as terminal reports.`,
      contextMessages: this.notificationContextMessages(input, inputId),
      tools: [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
    };
  }

  private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, processOwnerId: string): Promise<unknown> {
    const workspaceSurface = this.executorInvocationSurface(processOwnerId);
    if (workspaceSurface.tools.has(outcome.toolName)) return await invokeTool(workspaceSurface, outcome.toolName, outcome.args);
    return { success: false, error: `Unsupported executor tool call '${outcome.toolName}'.` };
  }

  private executorInvocationSurface(processOwnerId: string): InvocationSurface {
    return buildInvocationSurface('executor', [
      createWorkspaceProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
      createPatchProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
      createProcessProvider({ projectRoot: this.projectRoot, ownerId: processOwnerId, cardId: this.cardId }),
      createCardHistoryProvider({ projectRoot: this.projectRoot, sessionId: processOwnerId, agentRole: 'executor' }),
      createWebProvider({ projectRoot: this.projectRoot, cardId: this.cardId, agentRole: 'executor' }),
      createSkillProvider({ projectRoot: this.projectRoot, agentRole: 'executor' }),
      createMcpProvider({ mcpManagerProvider: this.mcpManagerProvider, agentRole: 'executor' }),
    ]);
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
    const summary = result.summary;
    if (result.status === 'done') return { status: 'done', summary, result: executorSuccess(result) };
    return { status: 'failed', summary, result: executorFailure(summary) };
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
  return { kind: 'done' as const, summary: result.summary };
}

function executorFailure(error: string) {
  return { kind: 'failed' as const, summary: error };
}
