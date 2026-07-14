import type { EventBus } from '../events/index.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import type { AppLogStore } from '../persistence/app-log.js';
import type { ControlActionSurface, NoteAuthor, RuntimeState } from '../schemas/index.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult } from '../runtime/runtime-api.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../runtime/control.js';
import type { RuntimeControlResult } from '../runtime/runtime-control-commands.js';
import type { RuntimeStateStore } from '../runtime/state.js';
import type { ApplicationPersistenceHealth } from './persistence-health.js';
import type { RuntimeInterventionBinding } from './intervention-readiness.js';

export interface RuntimeControlRequest {
  readonly actor: NoteAuthor;
  readonly surface: ControlActionSurface;
  readonly paramsSummary: string;
}

export interface RuntimeControlApplicationPort {
  startProject(source: RuntimeCommandSource, request: RuntimeControlRequest): Promise<StartProjectResult>;
  pause(request: RuntimeControlRequest): void;
  resume(request: RuntimeControlRequest): void;
  getStatus(): ReturnType<RuntimeApi['getStatus']>;
}

export interface RuntimeControlMechanics extends Omit<RuntimeApi, 'pause' | 'resume' | 'startProject'> {
  beginStartProject(source: RuntimeCommandSource): Promise<
    | { readonly accepted: false; readonly result: StartProjectResult }
    | { readonly accepted: true; readonly state: RuntimeState }
  >;
  launchStartedProject(state: RuntimeState): void;
  beginPause(): { readonly patch: Partial<RuntimeState>; readonly settled: boolean };
  beginResume(current: RuntimeState): RuntimeState;
  finishResume(): void;
}

export class RuntimeControlService implements RuntimeApi {
  constructor(private readonly options: {
    projectRoot: string;
    persistenceHealth: ApplicationPersistenceHealth;
    interventionBinding: RuntimeInterventionBinding;
    runtimeState: RuntimeStateStore;
    appLogs: AppLogStore;
    eventBus?: EventBus;
    mechanics?: RuntimeControlMechanics;
  }) {}

  start(): Promise<void> {
    return this.requireMechanics().start();
  }

  shutdown(): Promise<void> {
    return this.requireMechanics().shutdown();
  }

  async startProject(source: RuntimeCommandSource = 'operator', request = requestForSource(source)): Promise<StartProjectResult> {
    this.options.persistenceHealth.assertMutationHealthy();
    let auditAttempted = false;
    try {
      this.options.interventionBinding.markNotReady();
      const prepared = await this.requireMechanics().beginStartProject(source);
      this.options.persistenceHealth.assertMutationHealthy();
      this.options.interventionBinding.markNotReady();
      if (!prepared.accepted) {
        auditAttempted = true;
        this.audit('runtime.start_project', request, 'error', prepared.result.error ?? 'runtime start rejected');
        return prepared.result;
      }
      const runtime = this.options.runtimeState.replace(prepared.state);
      const result: StartProjectResult = { runtime, status: runtime.status, started: true, stopped: false };
      auditAttempted = true;
      this.audit('runtime.start_project', request, 'ok', 'project execution started');
      this.requireMechanics().launchStartedProject(runtime);
      return result;
    } catch (error) {
      if (!auditAttempted) this.auditFailureWhenHealthy('runtime.start_project', request, error);
      throw error;
    }
  }

  pause(request = requestForSource('runtime')): void {
    this.options.persistenceHealth.assertMutationHealthy();
    let auditAttempted = false;
    try {
      const mechanics = this.requireMechanics();
      const prepared = mechanics.beginPause();
      this.options.interventionBinding.markNotReady();
      this.options.runtimeState.patch(prepared.patch);
      auditAttempted = true;
      this.audit('runtime.pause', request, 'ok', 'runtime paused');
      if (prepared.settled) this.options.interventionBinding.markPausedReady();
    } catch (error) {
      if (!auditAttempted) this.auditFailureWhenHealthy('runtime.pause', request, error);
      throw error;
    }
  }

  resume(request = requestForSource('runtime')): void {
    this.options.persistenceHealth.assertMutationHealthy();
    let auditAttempted = false;
    try {
      const current = this.options.runtimeState.read();
      if (!current) throw new Error('Runtime state is unavailable');
      const mechanics = this.requireMechanics();
      const next = mechanics.beginResume(current);
      this.options.interventionBinding.markNotReady();
      this.options.runtimeState.replace(next);
      auditAttempted = true;
      this.audit('runtime.resume', request, 'ok', 'runtime resumed');
      mechanics.finishResume();
    } catch (error) {
      if (!auditAttempted) this.auditFailureWhenHealthy('runtime.resume', request, error);
      throw error;
    }
  }

  pauseOffline(request: RuntimeControlRequest): RuntimeControlResult {
    return this.runOffline('pause', request);
  }

  resumeOffline(request: RuntimeControlRequest): RuntimeControlResult {
    return this.runOffline('resume', request);
  }

  notifyCard(cardId: string, notification: CardNotification) { return this.requireMechanics().notifyCard(cardId, notification); }
  subscribe(options: Parameters<RuntimeApi['subscribe']>[0]) { return this.requireMechanics().subscribe(options); }
  getStatus() { return this.requireMechanics().getStatus(); }
  getActorRuntimeReadModel() { return this.requireMechanics().getActorRuntimeReadModel(); }

  private runOffline(action: 'pause' | 'resume', request: RuntimeControlRequest): RuntimeControlResult {
    this.options.persistenceHealth.assertMutationHealthy();
    const result = action === 'pause'
      ? pauseRuntimeControl({ projectRoot: this.options.projectRoot, runtimeState: this.options.runtimeState })
      : resumeRuntimeControl({ projectRoot: this.options.projectRoot, runtimeState: this.options.runtimeState });
    this.options.persistenceHealth.assertMutationHealthy();
    this.audit(`runtime.${action}`, request, result.ok ? 'ok' : 'error', result.ok ? 'persisted-only mutation applied (server not running)' : (result.message ?? result.error ?? 'mutation failed'));
    return result;
  }

  private audit(action: 'runtime.start_project' | 'runtime.pause' | 'runtime.resume', request: RuntimeControlRequest, outcome: 'ok' | 'error', summary: string): void {
    recordControlAction(this.options.appLogs, {
      actor: request.actor,
      surface: request.surface,
      action,
      target_kind: 'runtime',
      target_id: 'project',
      params_summary: request.paramsSummary,
      outcome,
      outcome_summary: summary,
      ...(outcome === 'error' ? { error: summary } : {}),
    }, this.options.eventBus);
  }

  private auditFailureWhenHealthy(action: 'runtime.start_project' | 'runtime.pause' | 'runtime.resume', request: RuntimeControlRequest, error: unknown): void {
    try {
      this.options.persistenceHealth.assertMutationHealthy();
    } catch {
      return;
    }
    this.audit(action, request, 'error', error instanceof Error ? error.message : String(error));
  }

  private requireMechanics(): RuntimeControlMechanics {
    if (!this.options.mechanics) throw new Error('Serving runtime mechanics are unavailable.');
    return this.options.mechanics;
  }
}

export function requestForSource(source: RuntimeCommandSource): RuntimeControlRequest {
  if (source === 'analyst') return { actor: 'analyst', surface: 'web-chat', paramsSummary: stableStringify({ source }) };
  if (source === 'operator') return { actor: 'user', surface: 'rest', paramsSummary: stableStringify({ source }) };
  return { actor: 'runtime', surface: 'runtime', paramsSummary: stableStringify({ source }) };
}
