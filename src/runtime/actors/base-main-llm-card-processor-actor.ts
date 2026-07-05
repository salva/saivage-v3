import { LLMActor, type LLMActorOutcome, type LLMProviderPort } from './llm-actor.js';
import type { ToolReplayOutcome } from '../../tools/invocation.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';
import { RuntimeGate } from '../runtime-gate.js';
import type { LlmInvocationInput } from './llm-invocation.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  readonly activeLlmActors = new Map<string, LLMActor>();
  #invocationInputCounter = 0;

  protected constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; gate?: RuntimeGate }) {
    super(args);
    this.provider = args.provider;
    this.gate = args.gate ?? new RuntimeGate();
  }

  protected createMainLlm(agentId: string): LLMActor {
    const existing = this.activeLlmActors.get(agentId);
    if (existing) return existing;
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, gate: this.gate });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    return llm;
  }

  adoptRecoveredLlmActor(llm: LLMActor): void {
    this.activeLlmActors.set(llm.agentId, llm);
  }

  async replayWaitingToolCall(_llm: LLMActor): Promise<ToolReplayOutcome> {
    return { kind: 'settled', result: { success: false, error: 'Runtime restarted before tool completion. Re-issue the call after inspecting current state.' } };
  }

  listLlmActors(): readonly LLMActor[] {
    return [...this.activeLlmActors.values()];
  }

  protected resumeOrStartLlm(llm: LLMActor, input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome> {
    if (llm.state() === 'calling_provider') return llm.awaitPendingTurn();
    if (llm.state() === 'waiting_tool') return Promise.resolve(llm.waitingToolOutcome());
    return llm.turn(input, signal);
  }

  protected override onActivationSettled(_outcome: CardProcessorOutcome): void {
    for (const llm of this.activeLlmActors.values()) llm.abandonParkedTurn();
    this.activeLlmActors.clear();
  }

  protected nextInvocationInputId(prefix: string): string {
    this.#invocationInputCounter++;
    return `${prefix}:${this.cardId}:${this.#invocationInputCounter}`;
  }

  protected plannerNotificationContext(input: CardActivationInput, inputId: string): unknown[] {
    const notifications = input.notificationDelivery.deliverNotificationsForInput(inputId);
    return notifications.map((notification) => ({ role: 'user', content: notification.message }));
  }

  protected reviewerContext(input: CardActivationInput): unknown[] {
    const pending = input.notificationDelivery.hasPendingNotifications?.() ?? false;
    return [{ role: 'user', content: `Main-agent notification currentness: pending=${pending ? 'yes' : 'no'}. This is an invalidation signal only; reviewer turns must not consume main-agent notifications.` }];
  }
}
