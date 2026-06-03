export class RuntimeLifecycleState {
  private _paused = false;
  private _running = false;
  private _shuttingDown = false;
  private _startupRepairPending = false;
  private _resumeHandoffContext: string | null = null;
  private readonly _runningProcesses: Set<string> = new Set();
  private readonly _dispatchInFlight: Set<string> = new Set();

  isPaused(): boolean { return this._paused; }
  isRunning(): boolean { return this._running; }
  isShuttingDown(): boolean { return this._shuttingDown; }
  isStartupRepairPending(): boolean { return this._startupRepairPending; }

  setPaused(paused: boolean): void { this._paused = paused; }
  setRunning(running: boolean): void { this._running = running; }
  setShuttingDown(shuttingDown: boolean): void { this._shuttingDown = shuttingDown; }
  setStartupRepairPending(pending: boolean): void { this._startupRepairPending = pending; }

  consumeResumeHandoffContext(): string | null {
    const ctx = this._resumeHandoffContext;
    this._resumeHandoffContext = null;
    return ctx;
  }

  setResumeHandoffContext(context: string | null): void {
    this._resumeHandoffContext = context;
  }

  get runningProcesses(): Set<string> { return this._runningProcesses; }
  get dispatchInFlight(): Set<string> { return this._dispatchInFlight; }
}