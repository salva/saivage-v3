import type { TypedEventEmitter } from '../events/index.js';
import type { RuntimeActivationLedgerPort, ReviewerResult } from '../contracts/index.js';
import type { EventLogger } from '../observability/index.js';
import type { RuntimeState, AgentMessage } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import { createReviewerContract } from '../contracts/reviewer-contract.js';
import { buildReviewerPrompt } from './system-prompt.js';
import { PlannerControlExecutor } from './planner-control-executor.js';

export interface PlannerControlFactoryConfig {
  cardStore: CardStore;
  projectRoot: string;
  saivageDir: string;
  maxReviewRetries: number;
  eventLogger?: EventLogger;
  runtimeStateProvider: () => RuntimeState | null;
  activationLedgerProvider: () => RuntimeActivationLedgerPort | undefined;
  eventBusProvider: () => TypedEventEmitter | undefined;
  markSessionWaiting: (sessionId: string) => void;
  markSessionActive: (sessionId: string) => void;
  invokeReviewer: (request: {
    goalId: string;
    systemPrompt: string;
    contextMessages: AgentMessage[];
    assessmentId: string;
    reviewerSessionId: string;
    contract: ReturnType<typeof createReviewerContract>;
  }) => Promise<ReviewerResult>;
}

export function createPlannerControlExecutor(config: PlannerControlFactoryConfig): PlannerControlExecutor {
  return new PlannerControlExecutor({
    cardStore: config.cardStore,
    projectRoot: config.projectRoot,
    saivageDir: config.saivageDir,
    runtimeStateProvider: config.runtimeStateProvider,
    activationLedger: {
      readState: () => config.activationLedgerProvider()?.readState() ?? null,
      appendRun: (input) => config.activationLedgerProvider()!.appendRun(input),
      upsertActivation: (input) => config.activationLedgerProvider()!.upsertActivation(input),
    },
    reviewer: async (goalId, assessmentId, reviewerSessionId, report, parentSessionId) => {
      if (parentSessionId) config.markSessionWaiting(parentSessionId);
      try {
        const reviewerContract = createReviewerContract();
        return (
          await config.invokeReviewer({
            goalId,
            systemPrompt: buildReviewerPrompt(reviewerContract),
            contextMessages: [
              {
                id: `review-report:${assessmentId}`,
                session_id: reviewerSessionId,
                role: 'user',
                kind: 'text',
                content: `The planner reports the following terminal outcome for goal '${goalId}'. Evaluate against the goal's acceptance criteria and respond with the canonical ReviewerResult JSON envelope.\n\n${JSON.stringify(report, null, 2)}`,
                round_id: generateRoundId('user'),
                message_index: 0,
                block_index: 0,
                timestamp: new Date().toISOString(),
              },
            ],
            assessmentId,
            reviewerSessionId,
            contract: reviewerContract,
          })
        ).assessment;
      } finally {
        if (parentSessionId) config.markSessionActive(parentSessionId);
      }
    },
    maxReviewRetries: config.maxReviewRetries,
    assessmentIdFactory: undefined,
    eventBusProvider: config.eventBusProvider,
    eventLogger: config.eventLogger,
  });
}
