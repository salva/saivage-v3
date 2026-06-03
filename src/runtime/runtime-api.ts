import type { Subscription, SubscriptionOptions } from '../events/index.js';
import type { SessionActivity } from '../contracts/session-stamper.js';
import type { ActionableErrorEnvelope, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../schemas/index.js';

export type RuntimeCommandSource = 'operator' | 'tool' | 'runtime' | 'analyst';
export type StartProjectResult =
  | {
      success: true;
      command: RuntimeCommandRecord;
      intent: RuntimeState['runtime_intent'];
      run: RuntimeRunRecord;
    }
  | { success: false; command: RuntimeCommandRecord; error: ActionableErrorEnvelope };
export interface StopProjectResult {
  success: true;
  command: RuntimeCommandRecord;
  intent: RuntimeState['runtime_intent'];
  run?: RuntimeRunRecord;
}

export interface RuntimeApi {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  pause(): void;
  resume(): void;
  startProject(source?: RuntimeCommandSource): Promise<StartProjectResult>;
  stopProject(source?: RuntimeCommandSource): Promise<StopProjectResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  getStatus(): {
    status: RuntimeStatus;
    paused: boolean;
    currentCardId: string | null;
    goalCount: number;
    lastTickAt: string | null;
  };
  getActivityStatus(sessionId: string): SessionActivity;
}
