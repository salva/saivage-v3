import type { EventEmitter } from 'node:events';
import type { EventLogger } from '../observability/index.js';
import type {
  LlmAttemptPayload,
  LlmFailureClass,
} from '../schemas/index.js';

export type ContractVerdict = 'satisfied' | 'repair_exhausted' | 'no_progress';

export class AttemptRecorder {
  private attemptOutcomeCount = 0;
  private lastSucceededAttemptPayload: LlmAttemptPayload | undefined;
  private lastFailedFailureClass: LlmFailureClass | undefined;
  private lastRepairAttempts = 0;
  private lastContractVerdict: ContractVerdict | undefined;

  constructor(
    private readonly eventBus?: EventEmitter,
    private readonly eventLogger?: EventLogger,
  ) {}

  recordOutcome(payload: LlmAttemptPayload): void {
    this.attemptOutcomeCount += 1;
    if (payload.outcome.kind === 'succeeded') this.lastSucceededAttemptPayload = payload;
    else this.lastFailedFailureClass = payload.outcome.failure_class;
    if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'llm_attempt', ...payload });
    if (this.eventBus) this.eventBus.emit('llm_attempt', payload);
  }

  recordContractVerdict(verdict: ContractVerdict, repairAttempts: number): void {
    this.lastContractVerdict = verdict;
    this.lastRepairAttempts = repairAttempts;
  }

  getOutcomeCount(): number {
    return this.attemptOutcomeCount;
  }

  getLastSucceeded(): LlmAttemptPayload | undefined {
    return this.lastSucceededAttemptPayload;
  }

  getLastFailedClass(): LlmFailureClass | undefined {
    return this.lastFailedFailureClass;
  }

  getRepairAttempts(): number {
    return this.lastRepairAttempts;
  }

  getContractVerdict(): ContractVerdict | undefined {
    return this.lastContractVerdict;
  }
}
