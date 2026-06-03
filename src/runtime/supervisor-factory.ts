import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentExecutionPort } from '../contracts/index.js';
import type { EventKind } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import { trackedEventKindValues } from '../events/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  StuckAgentSupervisor,
  type SupervisorConfig,
  type SupervisorDeps,
} from './stuck-agent-supervisor.js';
import { readRuntimeState } from './state.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';

const TRACKED_EVENT_KINDS: ReadonlySet<EventKind> = new Set(trackedEventKindValues);

function eventsLogPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'events.jsonl');
}

export function createRuntimeSupervisor(input: {
  projectRoot: string;
  agentRuntime: AgentExecutionPort;
  eventLogger: EventLogger;
  supervisorConfig?: Partial<SupervisorConfig>;
  lifecycle: RuntimeLifecycleState;
  emit(kind: string, data: Record<string, unknown>): void;
}): StuckAgentSupervisor {
  const supervisorDeps: SupervisorDeps = {
    getRecentLogs: (maxLines: number) => {
      try {
        const logPath = eventsLogPath(input.projectRoot);
        if (!existsSync(logPath)) return '';
        const raw = readFileSync(logPath, 'utf-8');
        const allLines = raw.split('\n').filter(Boolean);
        return allLines.slice(-maxLines).join('\n');
      } catch {
        return '';
      }
    },
    getActiveSessions: () => {
      try {
        const handoffs = input.agentRuntime.getActiveSessionHandoffs();
        if (!(handoffs instanceof Promise)) {
          const active = handoffs.map((handoff) => ({
            role: handoff.role,
            sessionId: handoff.session_id,
          }));
          if (active.length > 0) return active;
        }
      } catch {
        void 0;
      }
      try {
        const state = readRuntimeState(input.projectRoot);
        if (state && state.current_agent_session_id) {
          const sessionId = state.current_agent_session_id;
          let role = 'executor';
          if (sessionId.startsWith('planner-') || sessionId.startsWith('planner:')) role = 'planner';
          else if (sessionId.startsWith('reviewer-') || sessionId.startsWith('reviewer:')) role = 'reviewer';
          return [{ role, sessionId }];
        }
      } catch {
        void 0;
      }
      return [];
    },
    abortSession: (sessionId: string) => {
      void input.agentRuntime.cancelSession(sessionId);
    },
    forceCancelSession: (sessionId: string) => {
      void input.agentRuntime.forceCancelSession(sessionId);
    },
    emitEvent: (kind: string, data: Record<string, unknown>) => {
      input.emit(kind, data);
      if (TRACKED_EVENT_KINDS.has(kind as EventKind))
        input.eventLogger.appendEvent({ kind: kind as EventKind, ...data });
    },
    isShuttingDown: () => input.lifecycle.isShuttingDown(),
  };
  return new StuckAgentSupervisor(
    { ...DEFAULT_SUPERVISOR_CONFIG, ...input.supervisorConfig },
    supervisorDeps,
  );
}
