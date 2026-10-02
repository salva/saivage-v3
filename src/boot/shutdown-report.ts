import type { ShutdownReport } from '../contracts/index.js';

export function logShutdownWarnings(report: ShutdownReport): void {
  for (const warning of report.warnings)
    console.warn(`[shutdown] ${warning.component}: ${warning.code}`);
}
