import { LLMActor, type LLMAdmissionPort, type LLMProviderPort } from './llm-actor.js';
import { BaseCardProcessorActor } from './base-card-processor-actor.js';

export abstract class BaseMainLLMCardProcessorActor extends BaseCardProcessorActor {
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  #activationCounter = 0;

  protected constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
    this.provider = args.provider;
    this.admission = args.admission;
  }

  protected createMainLlm(agentId: string): LLMActor {
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId, provider: this.provider, admission: this.admission });
    llm.start();
    return llm;
  }

  protected nextInvocationInputId(prefix: string): string {
    this.#activationCounter++;
    return `${prefix}:${this.cardId}:${this.#activationCounter}`;
  }
}
