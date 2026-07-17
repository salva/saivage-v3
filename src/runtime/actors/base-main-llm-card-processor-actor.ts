import { LLMActor, type CompactorPort, type LLMActorOutcome, type LLMProviderPort, type LLMToolContinuationContextHook } from './llm-actor.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';
import { RuntimeGate } from '../runtime-gate.js';
import type { AutonomousLlmInvocationInput } from './llm-invocation.js';
import type { InvocationSurface } from '../../tools/invocation.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ProviderVisibleUserContextMessage } from './conversation-session.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { InvocationJoinOutcome } from './invocation-lifecycle.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  readonly compactor: CompactorPort;
  readonly compactionConfig: AutonomousCompactionPolicy;
  readonly summarizerProvider: SummarizerProviderPort;
  readonly conversationPublisher?: ConversationChangePublisher;
  readonly conversations: ConversationFileContext;
  readonly runtimeProjectionChanged: () => void;
  readonly activeLlmActors = new Map<string, LLMActor>();
  #joiningLlmActors: readonly LLMActor[] | null = null;
  #llmInvocationsDisposed = false;

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

  protected createMainLlm(agentId: string): LLMActor {
    const existing = this.activeLlmActors.get(agentId);
    if (existing) return existing;
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, conversations: this.conversations, gate: this.gate, compactor: this.compactor, summarizerProvider: this.summarizerProvider, conversationPublisher: this.conversationPublisher, runtimeProjectionChanged: this.runtimeProjectionChanged });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    this.runtimeProjectionChanged();
    return llm;
  }

  listLlmActors(): readonly LLMActor[] {
    return [...this.activeLlmActors.values()];
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
    llm: LLMActor,
    buildInput: () => AutonomousLlmInvocationInput | Promise<AutonomousLlmInvocationInput>,
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
    if (this.#joiningLlmActors) return;
    for (const llm of this.activeLlmActors.values()) llm.abandonParkedTurn();
    const hadActors = this.activeLlmActors.size > 0;
    this.activeLlmActors.clear();
    if (hadActors) this.runtimeProjectionChanged();
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
