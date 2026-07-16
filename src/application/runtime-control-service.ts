import type { RuntimeState } from '../schemas/index.js';
import type { CardNotification } from '../schemas/index.js';
import type { RuntimeApi, StartProjectResult, StopProjectResult } from '../runtime/runtime-api.js';
import type { RuntimeInterventionBinding } from './intervention-readiness.js';

export interface RuntimeControlApplicationPort {
  startProject(): Promise<StartProjectResult>;
  pause(): void;
  resume(): void;
  stopProject(): Promise<StopProjectResult>;
  getStatus(): ReturnType<RuntimeApi['getStatus']>;
  cancelCard(cardId: string, reason: string): ReturnType<RuntimeApi['cancelCard']>;
}

export interface RuntimeControlMechanics extends Omit<RuntimeApi, 'pause' | 'resume' | 'startProject' | 'stopProject'> {
  closeApplicationAdmission(): void;
  cleanupForApplicationStop(): Promise<void>;
  stopProject(): Promise<StopProjectResult>;
  beginStartProject(): Promise<
    | { readonly accepted: false; readonly result: StartProjectResult }
    | { readonly accepted: true; readonly state: RuntimeState }
  >;
  launchStartedProject(state: RuntimeState): void;
  beginPause(): { readonly patch: Partial<RuntimeState>; readonly settled: boolean };
  beginResume(current: RuntimeState): RuntimeState;
  finishResume(): void;
}

export class RuntimeControlService implements RuntimeApi {
  private currentState: RuntimeState | null = null;
  constructor(private readonly options: {
    projectRoot: string;
    interventionBinding: RuntimeInterventionBinding;
    mechanics?: RuntimeControlMechanics;
  }) {}

  start(): Promise<void> {
    return this.requireMechanics().start();
  }

  closeApplicationAdmission(): void { this.requireMechanics().closeApplicationAdmission(); }
  cleanupForApplicationStop(): Promise<void> { return this.requireMechanics().cleanupForApplicationStop(); }

  async startProject(): Promise<StartProjectResult> {
    try {
      this.options.interventionBinding.markNotReady();
      const prepared = await this.requireMechanics().beginStartProject();
      this.options.interventionBinding.markNotReady();
      if (!prepared.accepted) {
        return prepared.result;
      }
      const runtime = prepared.state;
      this.currentState = runtime;
      const result: StartProjectResult = { runtime, status: runtime.status, started: true, stopped: false };
      this.requireMechanics().launchStartedProject(runtime);
      return result;
    } catch (error) {
      throw error;
    }
  }

  pause(): void {
    try {
      const mechanics = this.requireMechanics();
      const prepared = mechanics.beginPause();
      this.options.interventionBinding.markNotReady();
      if (this.currentState) this.currentState = { ...this.currentState, ...prepared.patch };
      if (prepared.settled) this.options.interventionBinding.markPausedReady();
    } catch (error) {
      throw error;
    }
  }

  resume(): void {
    try {
      const current = this.currentState;
      if (!current) throw new Error('Runtime state is unavailable');
      const mechanics = this.requireMechanics();
      const next = mechanics.beginResume(current);
      this.options.interventionBinding.markNotReady();
      this.currentState = next;
      mechanics.finishResume();
    } catch (error) {
      throw error;
    }
  }

  async stopProject(): Promise<StopProjectResult> {
    const result = await this.requireMechanics().stopProject();
    if (result.contained) this.currentState = null;
    this.options.interventionBinding.markStoppedReady();
    return result;
  }

  notifyCard(cardId: string, notification: CardNotification) { return this.requireMechanics().notifyCard(cardId, notification); }
  cancelCard(cardId: string, reason: string) { return this.requireMechanics().cancelCard(cardId, reason); }
  subscribe(options: Parameters<RuntimeApi['subscribe']>[0]) { return this.requireMechanics().subscribe(options); }
  getStatus() { return this.requireMechanics().getStatus(); }
  getRuntimeState() { return this.requireMechanics().getRuntimeState(); }
  getActorRuntimeReadModel() { return this.requireMechanics().getActorRuntimeReadModel(); }

  private requireMechanics(): RuntimeControlMechanics {
    if (!this.options.mechanics) throw new Error('Serving runtime mechanics are unavailable.');
    return this.options.mechanics;
  }
}
