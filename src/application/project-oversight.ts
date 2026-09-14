import type { OversightCheckOutcome, OversightSession } from '../agents/oversight-session.js';
import type { RuntimeStatus } from '../schemas/index.js';

export interface OversightClock {
  monotonicNow(): number;
  wallNow(): string;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const nodeOversightClock: OversightClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => new Date().toISOString(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type OversightStatus = Readonly<{
  agent_name: string;
  session_id: string;
  enabled: boolean;
  eligible: boolean;
  eligibility_reason: 'disabled' | Exclude<RuntimeStatus, 'running'> | 'application_closing' | 'check_in_flight' | null;
  state: 'waiting' | 'checking' | 'unavailable';
  next_nominal_due: string | null;
  last_attempt: Readonly<{ outcome: OversightCheckOutcome; settled_at: string }> | null;
  last_successful_at: string | null;
  service_epoch: string;
}>;

const MAX_TIMEOUT_MS = 2_147_483_647;

export class ProjectOversight {
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #agentName: string;
  readonly #sessionId: string;
  readonly #serviceEpoch: string;
  readonly #clock: OversightClock;
  readonly #createCheck: () => OversightSession;
  readonly #changed: () => void;
  readonly #ownerFailure: (error: unknown) => void;

  #runtimeStatus: RuntimeStatus = 'stopped';
  #closing = false;
  #timer: unknown | null = null;
  #deadline: number | null = null;
  #dueWall: string | null = null;
  #check: OversightSession | null = null;
  #checkTask: Promise<void> | null = null;
  #lastAttempt: OversightStatus['last_attempt'] = null;
  #lastSuccess: string | null = null;

  constructor(input: {
    enabled: boolean;
    intervalMs: number;
    agentName: string;
    sessionId: string;
    serviceEpoch: string;
    clock?: OversightClock;
    createCheck(): OversightSession;
    changed(): void;
    onOwnerFailure(error: unknown): void;
  }) {
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0)
      throw new Error('Oversight interval must be finite and positive.');
    this.#enabled = input.enabled;
    this.#intervalMs = input.intervalMs;
    this.#agentName = input.agentName;
    this.#sessionId = input.sessionId;
    this.#serviceEpoch = input.serviceEpoch;
    this.#clock = input.clock ?? nodeOversightClock;
    this.#createCheck = input.createCheck;
    this.#changed = input.changed;
    this.#ownerFailure = input.onOwnerFailure;
  }

  runtimeStatusChanged(status: RuntimeStatus): void {
    if (this.#runtimeStatus === status) return;
    this.#runtimeStatus = status;
    if (status === 'running' && !this.#closing) {
      if (!this.#check) this.#arm();
    } else {
      this.#disarm();
      this.#check?.cancel(new Error(`Oversight ineligible: ${status}.`));
    }
    this.#changed();
  }

  closeAdmission(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#disarm();
    this.#check?.cancel(new Error('Application closing.'));
    this.#changed();
  }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeAdmission();
    await this.#checkTask;
  }

  executingLlmSnapshot() {
    return this.#check?.executingLlmSnapshot() ?? null;
  }

  assertEffectAdmission(signal: AbortSignal): void {
    if (!this.#enabled || this.#closing || this.#runtimeStatus !== 'running' || !this.#check)
      throw new Error('Oversight check effect admission is closed.');
    this.#check.assertEffectSignal(signal);
  }

  status(): OversightStatus {
    const eligible = this.#enabled && !this.#closing && this.#runtimeStatus === 'running' && !this.#check;
    const reason: OversightStatus['eligibility_reason'] = !this.#enabled
      ? 'disabled'
      : this.#closing
        ? 'application_closing'
        : this.#runtimeStatus !== 'running'
          ? this.#runtimeStatus
          : this.#check
            ? 'check_in_flight'
            : null;
    return Object.freeze({
      agent_name: this.#agentName,
      session_id: this.#sessionId,
      enabled: this.#enabled,
      eligible,
      eligibility_reason: reason,
      state: this.#check ? 'checking' : eligible && this.#timer !== null ? 'waiting' : 'unavailable',
      next_nominal_due: this.#timer !== null ? this.#dueWall : null,
      last_attempt: this.#lastAttempt,
      last_successful_at: this.#lastSuccess,
      service_epoch: this.#serviceEpoch,
    });
  }

  #arm(): void {
    if (!this.#enabled || this.#closing || this.#runtimeStatus !== 'running' || this.#check || this.#timer !== null) return;
    this.#deadline = this.#clock.monotonicNow() + this.#intervalMs;
    this.#dueWall = new Date(Date.parse(this.#clock.wallNow()) + this.#intervalMs).toISOString();
    this.#armRemaining();
  }

  #armRemaining(): void {
    const deadline = this.#deadline;
    if (deadline === null) throw new Error('Oversight timer has no deadline.');
    const wait = Math.min(Math.max(0, deadline - this.#clock.monotonicNow()), MAX_TIMEOUT_MS);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      if (this.#deadline !== deadline) return;
      if (this.#clock.monotonicNow() < deadline) {
        this.#armRemaining();
        return;
      }
      this.#deadline = null;
      this.#dueWall = null;
      if (this.#enabled && !this.#closing && this.#runtimeStatus === 'running') this.#startCheck();
      else this.#changed();
    }, wait);
    this.#changed();
  }

  #disarm(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#deadline = null;
    this.#dueWall = null;
  }

  #startCheck(): void {
    if (this.#check) throw new Error('Oversight admitted overlapping checks.');
    let check: OversightSession;
    let run: Promise<OversightCheckOutcome>;
    try {
      check = this.#createCheck();
      this.#check = check;
      this.#changed();
      run = check.run();
    } catch (error) {
      this.#check = null;
      this.#dispatchOwnerFailure(error);
      return;
    }
    const task = run.then(
      (outcome) => {
        const settledAt = this.#clock.wallNow();
        this.#lastAttempt = Object.freeze({ outcome, settled_at: settledAt });
        if (outcome === 'succeeded') this.#lastSuccess = settledAt;
        this.#check = null;
        this.#checkTask = null;
        if (this.#enabled && !this.#closing && this.#runtimeStatus === 'running') this.#arm();
        this.#changed();
      },
      (error) => {
        this.#check = null;
        this.#checkTask = null;
        this.#dispatchOwnerFailure(error);
      },
    );
    this.#checkTask = task;
    void task.catch(() => undefined);
  }

  #dispatchOwnerFailure(error: unknown): void {
    this.#closing = true;
    this.#disarm();
    this.#changed();
    this.#ownerFailure(error);
  }
}
