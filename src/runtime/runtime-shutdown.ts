import { join } from 'node:path';
import type { CardStore } from '../cards/store-api.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import type { EventLogger, ErrorLogger } from '../observability/index.js';
import { cleanAll } from '../runtime/cleanup.js';
import type { StuckAgentSupervisor } from '../runtime/stuck-agent-supervisor.js';
import { disposeProcessRuntimeScope } from './process-runner.js';
import { buildShutdownRuntimeStatePatch } from './runtime-core.js';
import { releaseLock } from './lock.js';
import type { RuntimeStateMachine } from './state-machine.js';
import { readRuntimeState } from './state.js';
import type { RuntimeDiagnostics } from './runtime-diagnostics.js';
import type { RuntimeStateMutationPort } from './mutations.js';

function saivageWorkDir(projectRoot: string): string {
  return join(projectRoot, '.saivage-work');
}

function processDisposeFailureReport(error: unknown) {
  return [
    {
      id: 'process-runtime-scope',
      kind: 'disposable' as const,
      status: 'failed' as const,
      error: error instanceof Error ? error.message : String(error),
    },
  ];
}

export async function performRuntimeShutdown(input: {
  projectRoot: string;
  cards: CardStore;
  agentRuntime: AgentExecutionPort;
  supervisor: StuckAgentSupervisor;
  stateMachine: RuntimeStateMachine;
  diagnostics: RuntimeDiagnostics;
  mutations: RuntimeStateMutationPort;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  ownsEventLogger: boolean;
  ownsErrorLogger: boolean;
  runningProcesses: Set<string>;
  dispatchInFlight: Set<string>;
  isRunning(): boolean;
  setRunning(running: boolean): void;
  setShuttingDown(shuttingDown: boolean): void;
  emitShutdown(): void;
}): Promise<void> {
  if (input.dispatchInFlight.size > 0) {
    await Promise.allSettled(
      Array.from(input.dispatchInFlight).map((cardId) =>
        input.agentRuntime.forceCancelSession(`planner:${cardId}`),
      ),
    );
  }
  if (!input.isRunning()) return;
  input.supervisor.stop();
  input.stateMachine.stop();
  if ((readRuntimeState(input.projectRoot)?.status ?? 'idle') === 'frozen') {
    try {
      input.diagnostics.setLastLifecycleDisposeReport(await disposeProcessRuntimeScope(input.projectRoot));
    } catch (error) {
      input.diagnostics.setLastLifecycleDisposeReport(processDisposeFailureReport(error));
    }
    try {
      releaseLock(input.projectRoot);
    } catch {
      void 0;
    }
    input.setRunning(false);
    input.setShuttingDown(false);
    input.emitShutdown();
    input.eventLogger.appendEvent({ kind: 'shutdown' });
    if (input.ownsEventLogger) input.eventLogger.close();
    if (input.ownsErrorLogger) input.errorLogger.close();
    return;
  }
  input.setShuttingDown(true);
  input.setRunning(false);
  try {
    const disposeReport = await disposeProcessRuntimeScope(input.projectRoot);
    input.diagnostics.setLastLifecycleDisposeReport(disposeReport);
    for (const id of disposeReport
      .filter((entry) => entry.kind === 'child_process')
      .map((entry) => entry.id.replace(/^child:/, '')))
      input.runningProcesses.delete(id);
  } catch (error) {
    input.diagnostics.setLastLifecycleDisposeReport(processDisposeFailureReport(error));
  }
  try {
    input.mutations.apply({ kind: 'patchRuntimeState', patch: buildShutdownRuntimeStatePatch() });
  } catch {
    void 0;
  }
  try {
    releaseLock(input.projectRoot);
  } catch {
    void 0;
  }
  try {
    cleanAll(saivageWorkDir(input.projectRoot), input.cards);
  } catch {
    void 0;
  }
  input.emitShutdown();
  input.eventLogger.appendEvent({ kind: 'shutdown' });
  if (input.ownsEventLogger) input.eventLogger.close();
  if (input.ownsErrorLogger) input.errorLogger.close();
}
