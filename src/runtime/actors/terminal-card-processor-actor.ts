import type { ActorDefinition } from '../micro-actor/index.js';
import { cardActivationOutcomePatch, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor } from './card-actor.js';
import type { CardService } from '../../cards/card-service.js';
import { executorActorId } from './ids.js';
import type { CompactorPort, LLMActorOutcome, LLMProviderPort } from './llm-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { validateConversationRows } from '../../contracts/conversation-compaction.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { cleanupInvocationSurface, invokeToolForLlm, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../../tools/invocation.js';
import { buildRoleSurface } from '../../tools/role-invocation-surfaces.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import { cardBriefForPrompt } from '../records/card-brief.js';
import { runContractRepairLoop } from './contract-repair-loop.js';
import type { RuntimeGate } from '../runtime-gate.js';
import { appendActivationMarker, appendRecoveryNotice, appendUserContextMessage, conversationMessagesForModel } from './conversation-session.js';
import { stabilizeRoleSession } from './conversation-recovery.js';
import { buildResponsesReplayProjection } from '../../agents/llm-openai-responses-mapper.js';
import { prepareCompaction, type CompactionConfig } from './compaction/compactor.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import { isRuntimeStoppedInterruption } from './runtime-stopped-interruption.js';

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

  readonly store: CardService;
  private activeProcessOwnerId: string | null = null;
  private readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;
  private readonly processRunner: ProcessRunner;
  private readonly promptTemplates: PromptTemplateRegistry;
  private readonly appLogs: AppLogContext;

  constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; conversations: ConversationFileContext; appLogs: AppLogContext; processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry; runtimeProjectionChanged: () => void; gate?: RuntimeGate; store: CardService; mcpManagerProvider?: () => McpToolInvocationPort | undefined; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; conversationPublisher?: ConversationChangePublisher }) {
    super(args);
    this.store = args.store;
    this.processRunner = args.processRunner;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
    this.promptTemplates = args.promptTemplates;
    this.appLogs = args.appLogs;
  }

  _on_enter__executing(): void {
    this.runPendingActivation('executing', (input, signal) => this.runActivation(input, signal));
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<TerminalProcessorOutcome> {
    if (!input.activationId) throw new Error(`Terminal processor '${this.cardId}' requires activationId for process ownership.`);
    const contract = createExecutorContract();
    const llm = this.createMainLlm(executorActorId(this.cardId));
    if (llm.state() === 'idle') this.discardOpenRecord('status.md', 'new_activation');
    const processOwnerId = input.activationId;
    const processScope = this.processRunner.createDirectScope(this.processRunner.runtimeRootScope, `card-activation:${processOwnerId}`, 'runtime_card');
    const surface = this.executorInvocationSurface(processOwnerId, processScope);
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
          const missingRecord = this.validateRequiredStatusRecord();
          if (missingRecord) {
            return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${missingRecord} Create record:///status.md?v=next, then call emit_result again.` }, signal, (inputId) => this.notificationContext(input, inputId)));
          }
          const currentCard = this.store.read(this.cardId);
          if (!currentCard) throw new Error(`Executor card '${this.cardId}' disappeared before terminal acceptance.`);
          const pending = [...currentCard.pending_notifications];
          if (pending.length > 0) {
            return control.continue(await llm.appendToolResult(terminalOutcome.toolCallId, {
              success: false,
              error: 'emit_result was not accepted because new operator context is pending. Consider the appended notifications, update the required record, and call emit_result again.',
              data: { reason: 'pending_notifications' },
            }, signal, (inputId) => this.notificationContext(input, inputId)));
          }
          input.claimResult();
          const closeError = this.closeRequiredStatusRecord(currentCard.version_seq);
          if (closeError) return control.done({ status: 'failed', summary: closeError, result: executorFailure(closeError) });
          const projected = projectTerminalExecutorOutcome(terminalOutcome, contract);
          llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, { success: true, data: { accepted: true } });
          this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(projected, new Date().toISOString()));
          return control.done(projected);
        },
        onNonTerminalTool: async (toolOutcome) => {
          const toolResult = await this.handleToolCall(toolOutcome, surface, signal);
          signal.throwIfAborted();
          return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, (inputId) => this.notificationContext(input, inputId));
        },
      });
      if (result.kind === 'restart') throw new Error('Terminal activation repair loop cannot restart.');
      cleanupStatus = result.value.status;
      return result.value;
    } finally {
      try {
        await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: signal.aborted ? 'cancelled' : cleanupStatus });
      } catch (error) {
        if (signal.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
        throw error;
      } finally {
        this.activeProcessOwnerId = null;
      }
    }
  }

  private buildLlmInput(input: CardActivationInput, surface: InvocationSurface, contract = createExecutorContract()): LlmInvocationInput {
    const inputId = this.freshSourceInputId();
    if (!input.activationId) throw new Error(`Terminal processor '${this.cardId}' requires activationId for process ownership.`);
    const sessionId = executorActorId(this.cardId);
    const systemPrompt = this.promptTemplates.render(input.card.type, 'executor', {
      cardId: input.card.id, cardTitle: input.card.title, cardBrief: cardBriefForPrompt(this.store!, input.card), contractDescription: contract.describe(),
      toolList: formatPromptToolList(surfaceToolDefinitions(surface)), cardType: input.card.type,
    });
    const tools = [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)];
    const preparedCompaction = this.compactionConfig?.enabled ? prepareCompaction(this.compactionConfig, systemPrompt, tools) : null;
    const stabilized = stabilizeRoleSession({ projectRoot: this.projectRoot, sessionId, conversations: this.conversations, terminalToolNames: new Set(contract.terminals.map((terminal) => terminal.name)) });
    const loadedRows = stabilized.messages;
    const loaded = conversationMessagesForModel(validateConversationRows(loadedRows));
    this.conversationPublisher?.entryAppended(appendActivationMarker(this.conversations, sessionId, { event: 'activation_open', role: 'executor', card_id: this.cardId, input_id: inputId }));
    const recovery = stabilized.interrupted ? appendRecoveryNotice(this.conversations, sessionId, inputId) : null;
    if (recovery) this.conversationPublisher?.entryAppended(recovery);
    const selected = input.notificationDelivery.selectNotifications();
    const notifications = selected.map((notification, index) => {
      const message = { role: 'user' as const, content: notification.content };
      const result = appendUserContextMessage(this.conversations, sessionId, inputId, 'notification', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result;
    });
    if (selected.length > 0) input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id));
    return {
      inputId,
      agentId: sessionId,
      role: 'executor',
      sessionId,
      systemPrompt,
      genericContextMessages: [...loaded, ...(recovery ? [recovery] : []), ...notifications],
      contextMessages: [...loaded, ...(recovery ? [recovery] : []), ...notifications],
      activeConversationReplay: buildResponsesReplayProjection(sessionId, [...loadedRows, ...(recovery ? [recovery] : []), ...notifications]),
      tools,
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      ...(preparedCompaction ? { preparedCompaction } : {}),
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
    };
  }

  private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, surface: InvocationSurface, signal: AbortSignal): Promise<ToolResult> {
    if (surface.tools.has(outcome.toolName)) return await invokeToolForLlm(surface, outcome.toolName, outcome.args, signal);
    return { success: false, error: `Unsupported executor tool call '${outcome.toolName}'.` };
  }

  private executorInvocationSurface(processOwnerId: string, processScope: ManagedProcessScope): InvocationSurface {
    return buildRoleSurface('executor', { projectRoot: this.projectRoot, cardId: this.cardId, sessionId: processOwnerId, ownerId: processOwnerId, store: this.store, processRunner: this.processRunner, processScope, mcpManagerProvider: this.mcpManagerProvider, appLogs: this.appLogs });
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

  protected get processorLabel(): string {
    return 'Terminal processor';
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

  private validateRequiredStatusRecord(): string | null {
    try {
      const open = this.store.readRecord(this.cardId, 'status.md', 'open');
      return open.artifact.content.trim().length > 0 ? null : `Required record '${open.recordUrl}' was not created or is empty.`;
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${this.cardId}/status/open'`)) return `Required record 'record:///status.md?card=${this.cardId}&v=next' was not created.`;
      return error instanceof Error ? error.message : String(error);
    }
  }

  private discardOpenRecord(filename: string, reason: string): void {
    try {
      const open = this.store.readRecord(this.cardId, filename, 'open');
      this.store.discardRecord(this.cardId, filename, open.version, reason);
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${this.cardId}/${filename.slice(0, -3)}/open'`)) return;
      throw error;
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
