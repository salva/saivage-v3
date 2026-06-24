import type { RuntimeDisposeReportEntry } from './lifecycle.js';

export interface RuntimeDiagnosticsObserver {
  setBackgroundDispatchCount(count: number): void;
  setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void;
}

export interface RuntimeDiagnostics {
  publish(): void;
  trackBackgroundDispatch(dispatch: Promise<void>): void;
  setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void;
}

export function createRuntimeDiagnostics(diagnosticsSink?: RuntimeDiagnosticsObserver): RuntimeDiagnostics {
  const backgroundDispatches = new Set<Promise<void>>();
  let lastLifecycleDisposeReport: RuntimeDisposeReportEntry[] = [];

  function publish(): void {
    diagnosticsSink?.setBackgroundDispatchCount(backgroundDispatches.size);
    diagnosticsSink?.setLastLifecycleDisposeReport([...lastLifecycleDisposeReport]);
  }

  return {
    publish,
    trackBackgroundDispatch(dispatch: Promise<void>): void {
    backgroundDispatches.add(dispatch);
    publish();
    dispatch
      .finally(() => {
        backgroundDispatches.delete(dispatch);
        publish();
      })
      .catch(() => undefined);
    },

    setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void {
    lastLifecycleDisposeReport = report;
    publish();
    },
  };
}
