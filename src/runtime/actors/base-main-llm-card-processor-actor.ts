import { LLMActor, type CompactorPort, type LLMActorOutcome, type LLMProviderPort, type LLMToolContinuationContextHook } from './llm-actor.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';
import { RuntimeGate } from '../runtime-gate.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { replayToolForRecovery, type InvocationSurface } from '../../tools/invocation.js';
import { readLlmActiveReconstruction } from './active-reconstruction.js';
import { readActorSnapshot } from './snapshots.js';
import type { BufferSizeEstimator, CompactionConfig } from './compaction/compactor.js';
import { listConversationSessionIds, readConversationMessages, type ProviderVisibleUserContextMessage } from './conversation-store.js';
import type { AgentMessage } from '../../schemas/index.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  readonly compactor?: CompactorPort;
  readonly compactionConfig?: CompactionConfig;
  readonly summarizerProvider?: LLMProviderPort;
  readonly bufferSizeEstimator?: BufferSizeEstimator;
  readonly activeLlmActors = new Map<string, LLMActor>();
  #invocationInputCounter = 0;

  protected constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; gate?: RuntimeGate; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; bufferSizeEstimator?: BufferSizeEstimator }) {
    super(args);
    this.provider = args.provider;
    this.gate = args.gate ?? new RuntimeGate();
    this.compactor = args.compactor;
    this.compactionConfig = args.compactionConfig;
    this.summarizerProvider = args.summarizerProvider;
    this.bufferSizeEstimator = args.bufferSizeEstimator;
  }

  protected createMainLlm(agentId: string): LLMActor {
    const existing = this.activeLlmActors.get(agentId);
    if (existing) return existing;
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, gate: this.gate, compactor: this.compactor, compactionConfig: this.compactionConfig, summarizerProvider: this.summarizerProvider, bufferSizeEstimator: this.bufferSizeEstimator });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    return llm;
  }

  adoptRecoveredLlmActor(llm: LLMActor): void {
    this.activeLlmActors.set(llm.agentId, llm);
  }

  listLlmActors(): readonly LLMActor[] {
    return [...this.activeLlmActors.values()];
  }

  override recoverActive(state: string, input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
    this.seedInvocationInputCounterFromConversations();
    this.adoptRecoveredLlmSnapshots();
    return super.recoverActive(state, input, signal);
  }

  protected async resolveInitialOutcome(
    llm: LLMActor,
    buildInput: () => LlmInvocationInput | Promise<LlmInvocationInput>,
    surface: InvocationSurface,
    isTerminalToolName: (name: string) => boolean,
    signal: AbortSignal,
    continuationContextHook?: LLMToolContinuationContextHook,
  ): Promise<LLMActorOutcome> {
    switch (llm.state()) {
      case 'idle':
        return llm.turn(await buildInput(), signal);
      case 'calling_provider':
        return llm.awaitPendingTurn();
      case 'waiting_tool':
        return this.resolveWaitingToolOutcome(llm, surface, isTerminalToolName, signal, continuationContextHook);
      default:
        throw new Error(`LLMActor '${llm.agentId}' is in unexpected state '${llm.state()}' for initial outcome resolution.`);
    }
  }

  private async resolveWaitingToolOutcome(
    llm: LLMActor,
    surface: InvocationSurface,
    isTerminalToolName: (name: string) => boolean,
    signal: AbortSignal,
    continuationContextHook?: LLMToolContinuationContextHook,
  ): Promise<LLMActorOutcome> {
    const outcome = llm.waitingToolOutcome();
    if (isTerminalToolName(outcome.toolName)) return outcome;
    const replay = await replayToolForRecovery(surface, outcome.toolName, outcome.args);
    if (replay.kind === 'settled') return llm.appendToolResult(outcome.toolCallId, replay.result, signal, continuationContextHook);
    return outcome;
  }

  private adoptRecoveredLlmSnapshots(): void {
    for (const agentId of this.recoverableLlmAgentIds()) {
      if (this.activeLlmActors.has(agentId)) continue;
      const snapshot = readActorSnapshot(this.projectRoot, agentId);
      if (!snapshot) continue;
      const activeReconstruction = readLlmActiveReconstruction(snapshot);
      if (!activeReconstruction) continue;
      const llm = LLMActor.fromActiveReconstruction({
        projectRoot: this.projectRoot,
        agentId,
        provider: this.provider,
        gate: this.gate,
        compactor: this.compactor,
        compactionConfig: this.compactionConfig,
        summarizerProvider: this.summarizerProvider,
        bufferSizeEstimator: this.bufferSizeEstimator,
        state: String(snapshot.state_value),
        activeReconstruction,
      });
      this.adoptRecoveredLlmActor(llm);
    }
  }

  protected abstract recoverableLlmAgentIds(): readonly string[];

  protected override onActivationSettled(_outcome: CardProcessorOutcome): void {
    for (const llm of this.activeLlmActors.values()) llm.abandonParkedTurn();
    this.activeLlmActors.clear();
  }

  protected nextInvocationInputId(prefix: string): string {
    this.#invocationInputCounter++;
    return `${prefix}:${this.cardId}:${this.#invocationInputCounter}`;
  }

  private seedInvocationInputCounterFromConversations(): void {
    let maxSuffix = 0;
    for (const sessionId of listConversationSessionIds(this.projectRoot)) {
      for (const message of readConversationMessages(this.projectRoot, sessionId)) {
        for (const inputId of inputIdsFromMessage(message)) {
          const suffix = this.parseOwnedInputSuffix(inputId);
          if (suffix !== null) maxSuffix = Math.max(maxSuffix, suffix);
        }
      }
    }
    this.#invocationInputCounter = maxSuffix;
  }

  private parseOwnedInputSuffix(inputId: string): number | null {
    for (const role of ['planner', 'terminal', 'reviewer']) {
      const prefix = `${role}:${this.cardId}:`;
      if (!inputId.startsWith(prefix)) continue;
      const rest = inputId.slice(prefix.length);
      const numeric = rest.match(/^\d+/)?.[0];
      if (!numeric) return null;
      const suffix = Number(numeric);
      return Number.isSafeInteger(suffix) ? suffix : null;
    }
    return null;
  }

  protected notificationContext(input: CardActivationInput, inputId: string): readonly ProviderVisibleUserContextMessage[] {
    const notifications = input.notificationDelivery.deliverNotificationsForInput(inputId);
    return notifications.map((notification) => ({ role: 'user', content: notification.message }));
  }
}

function inputIdsFromMessage(message: AgentMessage): string[] {
  const ids = new Set<string>();
  for (const delimiter of [':started', ':message', ':error', ':repair', ':tool-call:', ':provider-exchange:', ':tool:']) {
    const index = message.id.indexOf(delimiter);
    if (index > 0) ids.add(message.id.slice(0, index));
  }
  try {
    const parsed = JSON.parse(message.content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['input_id', 'inputId', 'source_input_id']) {
        if (typeof record[key] === 'string') ids.add(record[key]);
      }
    }
  } catch {}
  return [...ids];
}
