import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import { executorActorId } from './ids.js';
import type { CompactorPort, LLMActorOutcome, LLMProviderPort } from './llm-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { cleanupInvocationSurface, invokeToolForLlm, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../../tools/invocation.js';
import { buildRoleSurface } from '../../tools/role-invocation-surfaces.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ProcessRunner } from '../process-runner.js';
import { cardBriefForPrompt } from '../records/card-brief.js';
import { runContractRepairLoop } from './contract-repair-loop.js';
import { appendTerminalProjectedToolResult } from './llm-delivery-log.js';
import type { RuntimeGate } from '../runtime-gate.js';
import { appendActivationMarker, appendUserContextMessage, conversationMessagesForModel, readActiveVersionMessages } from './conversation-store.js';
import { buildResponsesReplayProjection } from '../../agents/llm-openai-responses-mapper.js';
import type { BufferSizeEstimator, CompactionConfig } from './compaction/compactor.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationMutationPort } from '../../persistence/conversation-mutation-port.js';
import type { ActorSnapshotStore } from './snapshots.js';

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

  readonly store: CardActorStorePort;
  private activeProcessOwnerId: string | null = null;
  private readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;
  private readonly processRunner: ProcessRunner;
  private readonly promptTemplates: PromptTemplateRegistry;

  constructor(args: { projectRoot: string; cardId: string; snapshots: ActorSnapshotStore; provider: LLMProviderPort; conversations: ConversationMutationPort; processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry; gate?: RuntimeGate; store: CardActorStorePort; mcpManagerProvider?: () => McpToolInvocationPort | undefined; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; bufferSizeEstimator?: BufferSizeEstimator; conversationPublisher?: ConversationChangePublisher }) {
    super(args);
    this.store = args.store;
    this.processRunner = args.processRunner;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
    this.promptTemplates = args.promptTemplates;
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

  protected override recoverableLlmAgentIds(): readonly string[] {
    return [executorActorId(this.cardId)];
  }

  protected override processorSnapshotContext(): Record<string, unknown> {
    return { ...super.processorSnapshotContext(), processOwnerId: this.activeProcessOwnerId };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<TerminalProcessorOutcome> {
    if (!input.activationId) throw new Error(`Terminal processor '${this.cardId}' requires activationId for process ownership.`);
    const contract = createExecutorContract();
    const llm = this.createMainLlm(executorActorId(this.cardId));
    if (llm.state() === 'idle') this.discardOpenRecord('status.md', 'new_activation');
    const processOwnerId = input.activationId;
    const surface = this.executorInvocationSurface(processOwnerId);
    this.activeProcessOwnerId = processOwnerId;
    let cleanupStatus: 'done' | 'blocked' | 'failed' | 'cancelled' = 'failed';
    try {
      const outcome = await this.resolveInitialOutcome(llm, () => this.buildLlmInput(input, surface, contract), surface, (name) => contract.isTerminalToolName(name), signal, (inputId) => this.notificationContext(input, inputId));
      const result = await runContractRepairLoop<TerminalProcessorOutcome>({
        initialOutcome: outcome,
        isTerminalToolName: (name) => contract.isTerminalToolName(name),
        fail: (message) => ({ status: 'failed', summary: message, result: executorFailure(message) }),
        onPlainText: async (_outcome, control) => {
          const message = `${expectedTerminalToolMessage(contract)} Plain executor messages are not accepted as terminal results.`;
          return control.repair(() => llm.continueAfterPlainText(`${message} Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record:///status.md?v=next if needed, then call emit_result with valid JSON arguments.`, signal, (inputId) => this.notificationContext(input, inputId)));
        },
        onTerminalTool: async (terminalOutcome, control) => {
          const invalidTerminal = this.validateExecutorTerminal(terminalOutcome, contract);
          if (invalidTerminal) {
            return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }, signal, (inputId) => this.notificationContext(input, inputId)));
          }
          const missingRecord = this.closeRequiredStatusRecord(input.card.version_seq);
          if (missingRecord) {
            return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${missingRecord} Create record:///status.md?v=next, then call emit_result again.` }, signal, (inputId) => this.notificationContext(input, inputId)));
          }
          const projected = projectTerminalExecutorOutcome(terminalOutcome, contract);
          this.markTerminalProjected(terminalOutcome, executorActorId(this.cardId));
          return control.done(projected);
        },
        onNonTerminalTool: async (toolOutcome) => {
          const toolResult = await this.handleToolCall(toolOutcome, surface, signal);
          return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, (inputId) => this.notificationContext(input, inputId));
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
    const sessionId = executorActorId(this.cardId);
    const loadedRows = readActiveVersionMessages(this.projectRoot, sessionId);
    const loaded = conversationMessagesForModel(loadedRows);
    this.conversationPublisher?.entryAppended(appendActivationMarker(this.conversations, sessionId, { event: 'activation_open', role: 'executor', card_id: this.cardId, input_id: inputId }));
    const notifications = this.notificationContext(input, inputId).map((message, index) => {
      const result = appendUserContextMessage(this.conversations, sessionId, inputId, 'notification', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result.message;
    });
    return {
      inputId,
      agentId: sessionId,
      role: 'executor',
      sessionId,
      systemPrompt: this.promptTemplates.render(input.card.type, 'executor', {
        cardId: input.card.id,
        cardTitle: input.card.title,
        cardBrief: cardBriefForPrompt(this.store!, input.card),
        contractDescription: contract.describe(),
        toolList: formatPromptToolList(surfaceToolDefinitions(surface)),
        cardType: input.card.type,
      }),
      genericContextMessages: [...loaded, ...notifications],
      contextMessages: [...loaded, ...notifications],
      activeConversationReplay: buildResponsesReplayProjection(sessionId, [...loadedRows, ...notifications]),
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
    return buildRoleSurface('executor', { projectRoot: this.projectRoot, cardId: this.cardId, sessionId: processOwnerId, ownerId: processOwnerId, store: this.store, processRunner: this.processRunner, mcpManagerProvider: this.mcpManagerProvider });
  }

  private validateExecutorTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createExecutorContract()): string | null {
    try {
      verifyTerminalToolOutcome(contract, outcome);
      return null;
    } catch (error) {
      if (error instanceof Error && /\/status\/open.*does not exist/.test(error.message)) return `Required record 'record:///status.md?card=${this.cardId}&v=next' was not created.`;
      return error instanceof Error ? error.message : String(error);
    }
  }

  private markTerminalProjected(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, sessionId: string): void {
    const result = appendTerminalProjectedToolResult(this.conversations, {
      sessionId,
      sourceInputId: outcome.inputId,
      toolCallId: outcome.toolCallId,
      toolName: outcome.toolName,
    });
    this.conversationPublisher?.entryAppended(result.appendResult);
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
      const open = this.store!.readRecord(this.cardId, 'status.md', 'open');
      this.store!.closeRecord(this.cardId, 'status.md', open.version, 'executor', cardVersionSeq);
      return null;
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${this.cardId}/status/open'`)) return `Required record 'record:///status.md?card=${this.cardId}&v=next' was not created.`;
      return error instanceof Error ? error.message : String(error);
    }
  }

  private discardOpenRecord(filename: string, reason: string): void {
    try { const open = this.store!.readRecord(this.cardId, filename, 'open'); this.store!.discardRecord(this.cardId, filename, open.version, reason); } catch { /* no open record */ }
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
