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
  readonly #mechanics: RuntimeControlMechanics;

  constructor(mechanics: RuntimeControlMechanics) {
    this.#mechanics = mechanics;
  }

  start(): Promise<void> {
    return this.#mechanics.start();
  }

  closeApplicationAdmission(): void { this.#mechanics.closeApplicationAdmission(); }
  cleanupForApplicationStop(): Promise<void> { return this.#mechanics.cleanupForApplicationStop(); }

  async startProject(): Promise<StartProjectResult> {
    const prepared = await this.#mechanics.beginStartProject();
    if (!prepared.accepted) {
      return prepared.result;
    }
    const runtime = this.#mechanics.launchStartedProject(prepared.launch);
    const result: StartProjectResult = { runtime, status: runtime.status, started: true, stopped: false };
    return result;
  }

  pause(): void {
    this.#mechanics.pause();
  }

  resume(): void {
    this.#mechanics.resume();
  }

  async stopProject(): Promise<StopProjectResult> {
    return this.#mechanics.stopProject();
  }

  notifyCard(cardId: string, notification: CardNotification) { return this.#mechanics.notifyCard(cardId, notification); }
  cancelCard(cardId: string, reason: string) { return this.#mechanics.cancelCard(cardId, reason); }
  subscribe(options: Parameters<RuntimeApi['subscribe']>[0]) { return this.#mechanics.subscribe(options); }
  getStatus() { return this.#mechanics.getStatus(); }
  getRuntimeState() { return this.#mechanics.getRuntimeState(); }
  getActorRuntimeReadModel() { return this.#mechanics.getActorRuntimeReadModel(); }
}
