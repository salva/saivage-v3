import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import type { RuntimeTestHooks } from './runtime-config.js';

export class RuntimeDiagnostics {
  private readonly backgroundDispatches = new Set<Promise<void>>();
  private lastLifecycleDisposeReport: RuntimeDisposeReportEntry[] = [];

  constructor(private readonly diagnosticsSink: RuntimeTestHooks['diagnosticsSink']) {}

  publish(): void {
    this.diagnosticsSink?.setBackgroundDispatchCount(this.backgroundDispatches.size);
    this.diagnosticsSink?.setLastLifecycleDisposeReport([...this.lastLifecycleDisposeReport]);
  }

  trackBackgroundDispatch(dispatch: Promise<void>): void {
    this.backgroundDispatches.add(dispatch);
    this.publish();
    dispatch
      .finally(() => {
        this.backgroundDispatches.delete(dispatch);
        this.publish();
      })
      .catch(() => undefined);
  }

  setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void {
    this.lastLifecycleDisposeReport = report;
    this.publish();
  }
}
