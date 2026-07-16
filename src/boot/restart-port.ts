import { logShutdownWarnings, type ShutdownReport } from './app.js';

export interface RestartPort {
  schedule(): void;
  acknowledge(): Promise<void>;
}

export function createRestartPort(args: { onAcknowledgedRestart(): Promise<ShutdownReport>; exit(code: number): never }): RestartPort {
  let scheduled = false;
  let acknowledgement: Promise<void> | null = null;
  return {
    schedule(): void { scheduled = true; },
    acknowledge(): Promise<void> {
      if (!scheduled) throw new Error('Server restart has not been scheduled.');
      acknowledgement ??= args.onAcknowledgedRestart().then((report) => { logShutdownWarnings(report); return args.exit(75); });
      return acknowledgement;
    },
  };
}
