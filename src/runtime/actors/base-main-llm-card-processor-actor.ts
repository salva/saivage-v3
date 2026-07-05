import { LLMActor, type LLMProviderPort } from './llm-actor.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';
import { RuntimeGate } from '../runtime-gate.js';

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
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, gate: this.gate });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    return llm;
  }

  listLlmActors(): readonly LLMActor[] {
    return [...this.activeLlmActors.values()];
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
