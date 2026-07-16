import { mkdirSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnvironment, type Environment } from '../config/index.js';
import { publishInitialProjectCard, readCard } from '../persistence/card-files.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../runtime/lock.js';
import type { CardRecord } from '../schemas/index.js';
import { startServer, type ServerInstance } from '../server/server.js';
import { createRestartPort } from './restart-port.js';

export const APP_CLEANUP_LEAF_TIMEOUT_MS = 10_000;

export type ShutdownComponent =
  | 'http-admission'
  | 'websocket-admission'
  | 'fastify'
  | 'live-sync'
  | 'telegram'
  | 'runtime'
  | 'tool-admission'
  | 'provider-admission'
  | 'child-admission'
  | 'process-admission'
  | 'analyst'
  | 'mcp'
  | 'subscriptions'
  | 'lifecycle-lock';

export interface SafeCleanupWarning {
  readonly component: ShutdownComponent;
  readonly code: 'closer_failed' | 'cleanup_failed' | 'cleanup_timeout';
}

export interface ShutdownReport { readonly warnings: readonly SafeCleanupWarning[] }

export interface AppTerminalRegistration {
  registerAdmissionCloser(component: ShutdownComponent, close: () => void): void;
  registerCleanupLeaf(component: ShutdownComponent, cleanup: () => void | Promise<void>): void;
  isApplicationClosing(): boolean;
}

type CleanupSettlement = 'fulfilled' | 'rejected' | 'timeout';

export async function settleCleanupLeafWithTimeout(cleanup: () => void | Promise<void>, timeoutMs: number): Promise<CleanupSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
  });
  let cleanupPromise: Promise<void>;
  try { cleanupPromise = Promise.resolve(cleanup()); }
  catch { cleanupPromise = Promise.reject(); }
  try {
    return await Promise.race([
      cleanupPromise.then(() => 'fulfilled' as const, () => 'rejected' as const),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAppTerminalCoordinator(): AppTerminalRegistration & { stop(): Promise<ShutdownReport> } {
  const admissionClosers: Array<{ component: ShutdownComponent; close: () => void }> = [];
  const cleanupLeaves: Array<{ component: ShutdownComponent; cleanup: () => void | Promise<void> }> = [];
  let applicationClosing = false;
  let stopPromise: Promise<ShutdownReport> | null = null;

  return {
    registerAdmissionCloser(component, close): void {
      if (applicationClosing) throw new Error('Application terminal registration is closed.');
      admissionClosers.push({ component, close });
    },
    registerCleanupLeaf(component, cleanup): void {
      if (applicationClosing) throw new Error('Application terminal registration is closed.');
      cleanupLeaves.push({ component, cleanup });
    },
    isApplicationClosing: () => applicationClosing,
    stop(): Promise<ShutdownReport> {
      if (stopPromise) return stopPromise;
      applicationClosing = true;
      const warnings: SafeCleanupWarning[] = [];
      for (const { component, close } of admissionClosers) {
        try { close(); }
        catch { warnings.push({ component, code: 'closer_failed' }); }
      }
      stopPromise = (async () => {
        for (const { component, cleanup } of [...cleanupLeaves].reverse()) {
          const outcome = await settleCleanupLeafWithTimeout(cleanup, APP_CLEANUP_LEAF_TIMEOUT_MS);
          if (outcome === 'rejected') warnings.push({ component, code: 'cleanup_failed' });
          else if (outcome === 'timeout') warnings.push({ component, code: 'cleanup_timeout' });
        }
        const report: ShutdownReport = Object.freeze({ warnings: Object.freeze([...warnings]) });
        return report;
      })();
      return stopPromise;
    },
  };
}

export function logShutdownWarnings(report: ShutdownReport): void {
  for (const warning of report.warnings) console.warn(`[shutdown] ${warning.component}: ${warning.code}`);
}

export interface NewProjectRootInput { readonly card: CardRecord; readonly brief: string }

export interface App {
  readonly environment: Environment;
  readonly server: ServerInstance;
  stop(): Promise<ShutdownReport>;
}

export function newProjectRootInput(projectRoot: string): NewProjectRootInput {
  const stamp = new Date().toISOString();
  const title = basename(projectRoot) || 'saivage-project';
  const card: CardRecord = {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title, status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, pending_notifications: [], version_seq: 1,
  };
  return { card, brief: `# Goal\n\nDefine and execute the ${title} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card brief.\n- Child work is created under this project card.\n` };
}

export interface StartAppOptions {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

function prelockStartupInputs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): { projectRoot: string; createRuntime: boolean } {
  const args = argv.slice(2);
  const command = args[0];
  const rest = command === 'start' ? args.slice(1) : args;
  let projectRoot = env['SAIVAGE_PROJECT_ROOT'] ?? process.cwd();
  let createRuntime = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--create-runtime') createRuntime = true;
    if (arg === '--project-root') {
      const value = rest[i + 1];
      if (!value) throw new Error('Missing value for --project-root.');
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith('--project-root=')) projectRoot = arg.slice('--project-root='.length);
  }
  return { projectRoot: realpathSync(resolve(projectRoot)), createRuntime };
}

export async function startApp(options: StartAppOptions): Promise<App> {
  const env = options.env ?? process.env;
  const prelock = prelockStartupInputs(options.argv, env);
  const terminal = createAppTerminalCoordinator();
  const lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: prelock.projectRoot, mode: 'bound' });
  terminal.registerCleanupLeaf('lifecycle-lock', () => releaseRuntimeLifecycleLock(lifecycleLock));
  const restartPort = createRestartPort({
    onAcknowledgedRestart: () => terminal.stop(),
    exit: (code) => process.exit(code),
  });
  let environment: Environment;
  let server: ServerInstance;
  try {
    if (prelock.createRuntime && readCard(prelock.projectRoot, 'project') === null) {
      mkdirSync(resolve(prelock.projectRoot, '.saivage', 'cards'), { recursive: true });
      const root = newProjectRootInput(prelock.projectRoot);
      publishInitialProjectCard(prelock.projectRoot, root.card, root.brief, 'analyst');
    }
    environment = await loadEnvironment(options.argv, env);
    server = await startServer({ environment, terminal, restartPort });
    const address = server.fastify.server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not publish a TCP control address.');
    const dialHost = environment.server.host === '0.0.0.0' || environment.server.host === '::' ? '127.0.0.1' : environment.server.host;
    const urlHost = dialHost.includes(':') ? `[${dialHost}]` : dialHost;
    publishRuntimeControlEndpoint(lifecycleLock, { origin: `http://${urlHost}:${address.port}`, auth: environment.auth.apiToken === undefined ? 'disabled' : 'bearer' });
  } catch (error) {
    const report = await terminal.stop();
    logShutdownWarnings(report);
    throw error;
  }

  const stop = () => terminal.stop();
  const stopForSignal = (): void => { void stop().then((report) => { logShutdownWarnings(report); process.exit(0); }); };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  terminal.registerCleanupLeaf('subscriptions', () => {
    process.removeListener('SIGINT', stopForSignal);
    process.removeListener('SIGTERM', stopForSignal);
  });
  return { environment, server, stop };
}
