import { LLMActor, type LLMAdmissionPort, type LLMProviderPort } from './llm-actor.js';
import { BaseCardProcessorActor, type CardProcessorOutcome } from './base-card-processor-actor.js';
import type { CardActivationInput } from './card-actor.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  readonly activeLlmActors = new Map<string, LLMActor>();
  #invocationInputCounter = 0;

  protected constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
    this.provider = args.provider;
    this.admission = args.admission;
  }

  protected createMainLlm(agentId: string): LLMActor {
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, admission: this.admission });
    llm.start();
    this.activeLlmActors.set(agentId, llm);
    return llm;
  }

  listLlmActors(): readonly LLMActor[] {
    return [...this.activeLlmActors.values()];
  }

  protected override onActivationSettled(_outcome: CardProcessorOutcome): void {
    this.activeLlmActors.clear();
  }

  protected nextInvocationInputId(prefix: string): string {
    this.#invocationInputCounter++;
    return `${prefix}:${this.cardId}:${this.#invocationInputCounter}`;
  }

  protected notificationContextMessages(input: CardActivationInput, inputId: string): unknown[] {
    const notifications = input.notificationDelivery.deliverNotificationsForInput(inputId);
    return notifications.map((notification) => ({ role: 'user', content: notification.message }));
  }
}
