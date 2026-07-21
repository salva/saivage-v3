import type { RuntimeState } from '../schemas/index.js';
import type { CardNotification } from '../schemas/index.js';
import type { RuntimeApi, StartProjectResult, StopProjectResult } from '../runtime/runtime-api.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';

export interface RuntimeControlApplicationPort {
  startProject(): Promise<StartProjectResult>;
  pause(): void;
  resume(): void;
  stopProject(): Promise<StopProjectResult>;
  getStatus(): ReturnType<RuntimeApi['getStatus']>;
  cancelCard(cardId: string, reason: string): ReturnType<RuntimeApi['cancelCard']>;
}

declare const runtimeLaunchPlanBrand: unique symbol;
export interface RuntimeLaunchPlan { readonly [runtimeLaunchPlanBrand]: never }

export interface RuntimeControlMechanics extends Omit<RuntimeApi, 'pause' | 'resume' | 'startProject' | 'stopProject'> {
  closeApplicationAdmission(): void;
  cleanupForApplicationStop(): Promise<void>;
  stopProject(): Promise<StopProjectResult>;
  beginStartProject(): Promise<
    | { readonly accepted: false; readonly result: StartProjectResult }
    | { readonly accepted: true; readonly launch: RuntimeLaunchPlan }
  >;
  launchStartedProject(launch: RuntimeLaunchPlan): RuntimeState;
  pause(): void;
  resume(): void;
  captureAutonomousExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[];
}

export class RuntimeControlService implements RuntimeApi {
  constructor(private readonly options: {
    mechanics?: RuntimeControlMechanics;
  }) {}

  start(): Promise<void> {
    return this.requireMechanics().start();
  }

  closeApplicationAdmission(): void { this.requireMechanics().closeApplicationAdmission(); }
  cleanupForApplicationStop(): Promise<void> { return this.requireMechanics().cleanupForApplicationStop(); }

  async startProject(): Promise<StartProjectResult> {
    const prepared = await this.requireMechanics().beginStartProject();
    if (!prepared.accepted) {
      return prepared.result;
    }
    const runtime = this.requireMechanics().launchStartedProject(prepared.launch);
    const result: StartProjectResult = { runtime, status: runtime.status, started: true, stopped: false };
    return result;
  }

  pause(): void {
    this.requireMechanics().pause();
  }

  resume(): void {
    this.requireMechanics().resume();
  }

  async stopProject(): Promise<StopProjectResult> {
    return this.requireMechanics().stopProject();
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
