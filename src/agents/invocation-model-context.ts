import type { AgentMessage, RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { AgentRole } from './agent-adapter.js';
import { AgentSessionCoordinator } from './agent-session-coordinator.js';
import { ContextCompactor } from './context-compactor.js';

export interface InvocationModelContextConfig {
  projectRoot: string;
  sessionCoordinator: AgentSessionCoordinator;
  contextCompactor: ContextCompactor;
  cardStore: CardStore;
  runtimeStateProvider?: () => RuntimeState | null;
}

export class InvocationModelContext {
  constructor(private readonly config: InvocationModelContextConfig) {}

  buildModelMessages(sessionId: string, role?: AgentRole, goalId?: string): AgentMessage[] {
    return this.config.contextCompactor.compactPlannerInMemory(
      sessionId,
      this.config.sessionCoordinator.buildModelMessages(sessionId),
      role,
      { contextLimit: 24000, threshold: 1 },
      {
        projectRoot: this.config.projectRoot,
        goalId: goalId ?? sessionId.replace(/^planner:/, ''),
        cardStore: this.config.cardStore,
        runtimeStateProvider: this.config.runtimeStateProvider,
      },
    );
  }
}
