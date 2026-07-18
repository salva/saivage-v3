import { ConversationLLMActor, type CompactorPort, type LLMActorOutcome, type LLMProviderPort, type LLMToolContinuationContextHook } from './llm-actor.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';
import { RuntimeGate } from '../runtime-gate.js';
import type { PreparedLlmInvocationInput } from './llm-invocation.js';
import type { InvocationSurface } from '../../tools/invocation.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ProviderVisibleUserContextMessage } from './conversation-session.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { InvocationJoinOutcome } from './invocation-lifecycle.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import { parseLlmActorId } from './ids.js';
import type { ExecutingLlmSnapshot, LlmToolInvocationContext } from './executing-llm-snapshot.js';
import { parseConversationSessionId } from '../../schemas/index.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  readonly compactor: CompactorPort;
  readonly compactionConfig: AutonomousCompactionPolicy;
  readonly summarizerProvider: SummarizerProviderPort;
  readonly conversationPublisher?: ConversationChangePublisher;
  readonly conversations: ConversationFileContext;
  readonly runtimeProjectionChanged: () => void;
  readonly activeLlmActors = new Map<string, ConversationLLMActor>();
  #joiningLlmActors: readonly ConversationLLMActor[] | null = null;
  #llmInvocationsDisposed = false;
  #currentExecutingLlm: ConversationLLMActor | null = null;

  protected constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; conversations: ConversationFileContext; runtimeProjectionChanged: () => void; gate?: RuntimeGate; compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort; conversationPublisher?: ConversationChangePublisher }) {
    super(args);
    this.provider = args.provider;
    this.conversations = args.conversations;
    this.gate = args.gate ?? new RuntimeGate();
    this.compactor = args.compactor;
    this.compactionConfig = args.compactionConfig;
    this.summarizerProvider = args.summarizerProvider;
    this.conversationPublisher = args.conversationPublisher;
    this.runtimeProjectionChanged = args.runtimeProjectionChanged;
  }

  protected createMainLlm(agentId: string): ConversationLLMActor {
    const existing = this.activeLlmActors.get(agentId);
    if (existing) return existing;
    const llm = new ConversationLLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, conversations: this.conversations, gate: this.gate, compactor: this.compactor, summarizerProvider: this.summarizerProvider, conversationPublisher: this.conversationPublisher, runtimeProjectionChanged: this.runtimeProjectionChanged });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    this.runtimeProjectionChanged();
    return llm;
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    if (!this.hasPendingActivation() || this.state() !== 'running') return null;
    const llm = this.#currentExecutingLlm;
    if (!llm) return null;
    const identity = parseLlmActorId(llm.agentId);
    if (identity.cardId !== this.cardId || identity.role === 'analyst') throw new Error(`Current LLM actor '${llm.agentId}' does not belong to processor '${this.cardId}'.`);
    return Object.freeze({ sessionId: parseConversationSessionId(llm.agentId), agentId: llm.agentId, role: identity.role, cardId: identity.cardId, activity: llm.executingActivity() });
  }

  protected setCurrentExecutingLlm(llm: ConversationLLMActor): void {
    if (this.#currentExecutingLlm && this.#currentExecutingLlm !== llm) throw new Error(`Processor '${this.cardId}' requires an explicit LLM role handoff.`);
    this.#currentExecutingLlm = llm;
    llm.resetExecutingActivity();
    this.runtimeProjectionChanged();
  }

  protected handoffExecutingLlm(from: ConversationLLMActor, to: ConversationLLMActor): void {
    if (this.#currentExecutingLlm !== from || from === to) throw new Error(`Processor '${this.cardId}' has an invalid LLM role handoff.`);
    if (from.executingActivity().mode !== 'active') throw new Error(`Processor '${this.cardId}' cannot hand off an LLM actor while waiting.`);
    this.#currentExecutingLlm = to;
    to.resetExecutingActivity();
    this.runtimeProjectionChanged();
  }

  protected selectExecutingLlm(llm: ConversationLLMActor): void {
    if (!this.#currentExecutingLlm) this.setCurrentExecutingLlm(llm);
    else if (this.#currentExecutingLlm !== llm) this.handoffExecutingLlm(this.#currentExecutingLlm, llm);
  }

  protected toolInvocationContext(llm: ConversationLLMActor, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): LlmToolInvocationContext {
    if (this.#currentExecutingLlm !== llm || outcome.agentId !== llm.agentId) throw new Error(`Tool call '${outcome.toolCallId}' does not belong to the current LLM actor.`);
    const identity = { sessionId: parseConversationSessionId(llm.agentId), sourceInputId: outcome.inputId, toolCallId: outcome.toolCallId, toolName: outcome.toolName };
    return { ...identity, waits: llm.waitCallbacks(identity) };
  }

  override disposeActivation(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.activeLlmActors.values()];
    if (!this.#llmInvocationsDisposed) {
      for (const llm of this.#joiningLlmActors) llm.disposeInvocations(reason);
      this.#llmInvocationsDisposed = true;
    }
    super.disposeActivation(reason);
  }

  override suppressContinuationAndPrepareJoin(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.activeLlmActors.values()];
    for (const llm of this.#joiningLlmActors) llm.closeInvocationAdmission(reason);
    super.suppressContinuationAndPrepareJoin(reason);
  }

  override async joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const actors = this.#joiningLlmActors;
    if (!actors) throw new Error(`Processor '${this.cardId}' must dispose activation admission before join.`);
    const outcomes = await Promise.all(actors.map((llm) => llm.joinInvocationSettlement()));
    const processorOutcomes = await super.joinActivation();
    const hadActors = this.activeLlmActors.size > 0;
    this.activeLlmActors.clear();
    if (hadActors) this.runtimeProjectionChanged();
    return [...outcomes, ...processorOutcomes];
  }

  override pendingJoinTaskCount(): number {
    return super.pendingJoinTaskCount() + (this.#joiningLlmActors ?? []).reduce((count, llm) => count + llm.pendingInvocationCount(), 0);
  }

  protected async resolveInitialOutcome(
    llm: ConversationLLMActor,
    buildInput: () => PreparedLlmInvocationInput | Promise<PreparedLlmInvocationInput>,
    surface: InvocationSurface,
    isTerminalToolName: (name: string) => boolean,
    signal: AbortSignal,
    continuationContextHook?: LLMToolContinuationContextHook,
  ): Promise<LLMActorOutcome> {
    switch (llm.state()) {
      case 'idle':
        return llm.turn(await buildInput(), signal);
      default:
        throw new Error(`LLMActor '${llm.agentId}' must be idle at the start of a process-local activation, received '${llm.state()}'.`);
    }
  }

  protected override onActivationSettled(_outcome: CardProcessorOutcome): void {
    if (this.#currentExecutingLlm?.executingActivity().mode === 'waiting') throw new Error(`Processor '${this.cardId}' settled while its current LLM actor was waiting.`);
    this.#currentExecutingLlm = null;
    this.runtimeProjectionChanged();
    if (this.#joiningLlmActors) return;
    for (const llm of this.activeLlmActors.values()) llm.abandonParkedTurn();
    const hadActors = this.activeLlmActors.size > 0;
    this.activeLlmActors.clear();
    if (hadActors) this.runtimeProjectionChanged();
  }

  protected override onActivationFailed(_error: Error): void {
    if (this.#currentExecutingLlm?.executingActivity().mode === 'waiting') throw new Error(`Processor '${this.cardId}' failed while its current LLM actor was waiting.`);
    this.#currentExecutingLlm = null;
    this.runtimeProjectionChanged();
  }

  protected freshSourceInputId(): string { return randomUUID(); }

  protected notificationContext(input: CardActivationInput, inputId: string): ReturnType<LLMToolContinuationContextHook> {
    void inputId;
    const notifications = input.notificationDelivery.selectNotifications();
    if (notifications.length === 0) return undefined;
    return {
      messages: notifications.map((notification) => ({ role: 'user', content: notification.content })),
      afterAppend: () => input.notificationDelivery.removeNotifications(notifications.map((notification) => notification.id)),
    };
  }
}
import { randomUUID } from 'node:crypto';
