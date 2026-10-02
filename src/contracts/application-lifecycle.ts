export type ShutdownComponent =
  | 'http-admission'
  | 'websocket-admission'
  | 'fastify'
  | 'live-sync'
  | 'runtime'
  | 'process-admission'
  | 'analyst'
  | 'oversight'
  | 'mcp'
  | 'sync-hub'
  | 'signal-handlers'
  | 'lifecycle-lock';

export interface SafeCleanupWarning {
  readonly component: ShutdownComponent;
  readonly code: 'closer_failed' | 'cleanup_failed' | 'cleanup_timeout';
}

export interface ShutdownReport {
  readonly warnings: readonly SafeCleanupWarning[];
}

export interface AppTerminalRegistration {
  registerAdmissionCloser(component: ShutdownComponent, close: () => void): void;
  registerCleanupLeaf(component: ShutdownComponent, cleanup: () => void | Promise<void>): void;
  isApplicationClosing(): boolean;
}
