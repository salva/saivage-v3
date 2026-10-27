import {
  loadEnvironment,
  formatConfigWarning,
  resolveStartupProjectRoot,
  type Environment,
  type StartInputs,
} from '../config/index.js';
import {
  initializeAndValidateCurrentGeneratedState,
  readProjectCardOrAssertInitialPublicationAllowed,
} from '../persistence/index.js';
import {
  acquireRuntimeLifecycleLock,
  publishRuntimeControlEndpoint,
  releaseRuntimeLifecycleLock,
  runtimeProcessIdentity,
  ManagedProcessGroupRegistry,
  ProcessRunner,
  type RuntimeLifecycleLockHandle,
} from '../runtime/runtime-api.js';
import { startServer, type ServerInstance } from '../server/server-api.js';
import { createRestartPort } from './restart-port.js';
import {
  publishInitialProjectRuntime,
  assertInitialProjectPolicy,
} from './project-runtime-bootstrap.js';
import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../contracts/index.js';
import type {
  ShutdownComponent,
  SafeCleanupWarning,
  ShutdownReport,
  AppTerminalRegistration,
} from '../contracts/index.js';
import { logShutdownWarnings } from './shutdown-report.js';

export const APP_CLEANUP_LEAF_TIMEOUT_MS = 10_000;

type CleanupSettlement = 'fulfilled' | 'rejected' | 'timeout';

async function settleCleanupLeafWithTimeout(
  cleanup: () => void | Promise<void>,
  timeoutMs: number,
): Promise<CleanupSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
  });
  let cleanupPromise: Promise<void>;
  try {
    cleanupPromise = Promise.resolve(cleanup());
  } catch {
    cleanupPromise = Promise.reject();
  }
  try {
    return await Promise.race([
      cleanupPromise.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAppTerminalCoordinator(): AppTerminalRegistration & {
  stop(): Promise<ShutdownReport>;
} {
  const admissionClosers: Array<{ component: ShutdownComponent; close: () => void }> = [];
  const cleanupLeaves: Array<{
    component: ShutdownComponent;
    cleanup: () => void | Promise<void>;
  }> = [];
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
        try {
          close();
        } catch {
          warnings.push({ component, code: 'closer_failed' });
        }
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

export function createApplicationOwnerFailureHandler(input: {
  component: 'oversight' | 'external-analyst';
  terminal: ReturnType<typeof createAppTerminalCoordinator>;
  exit(code: 1): never | void;
  writeDiagnostic?(): void;
}): (error: unknown) => void {
  return (_error: unknown): void => {
    (
      input.writeDiagnostic ??
      (() => console.error(`[${input.component}] owner failure; application terminating`))
    )();
    void input.terminal.stop().then((report) => {
      logShutdownWarnings(report);
      input.exit(1);
    });
  };
}

export interface App {
  readonly environment: Environment;
  readonly server: ServerInstance;
  readonly boundListener: { readonly host: string; readonly port: number };
  stop(): Promise<ShutdownReport>;
}

interface StartAppOptions extends StartInputs {
  env?: Readonly<Record<string, string | undefined>>;
}

export async function startApp(options: StartAppOptions): Promise<App> {
  const processFatalPort = createApplicationFatalPort();
  let fatal = false;
  const fatalPort = {
    publicationOutcomeUnknown(error: PublicationOutcomeUnknownError): never {
      fatal = true;
      return processFatalPort.publicationOutcomeUnknown(error);
    },
  };
  const env = options.env ?? process.env;
  const projectRoot = resolveStartupProjectRoot(options, env);
  const terminal = createAppTerminalCoordinator();
  let lifecycleLock: RuntimeLifecycleLockHandle;
  try {
    lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot, mode: 'bound' });
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error);
    throw error;
  }
  const processIdentity = runtimeProcessIdentity(lifecycleLock);
  terminal.registerCleanupLeaf('lifecycle-lock', () => releaseRuntimeLifecycleLock(lifecycleLock));
  const processRegistry = new ManagedProcessGroupRegistry();
  const processRunner = new ProcessRunner(projectRoot, processRegistry, fatalPort);
  const bootstrapScope = processRegistry.createContainerScope(
    processRegistry.rootScope,
    'initial-project',
  );
  const startupController = new AbortController();
  let starting = true;
  const assertInitializerCurrent = () => {
    startupController.signal.throwIfAborted();
    if (!starting || fatal || terminal.isApplicationClosing())
      throw new Error('Startup initializer no longer owns publication.');
    runtimeProcessIdentity(lifecycleLock);
  };
  terminal.registerAdmissionCloser('process-admission', () => processRunner.closeLaunchAdmission());
  const containProcesses = async () => {
    try {
      const report = await processRunner.terminateScopeTree({
        rootScope: processRegistry.rootScope,
        categories: ['runtime_card', 'operator_session', 'service_infrastructure'],
        reason: 'Application stopped',
        graceMs: 1000,
      });
      if (report.failed.length > 0) throw new Error('Application process containment unconfirmed.');
    } catch (error) {
      if (fatal) throw error;
      if (error instanceof PublicationOutcomeUnknownError)
        fatalPort.publicationOutcomeUnknown(error);
      console.error('Application process containment failed; lifecycle lock retained.');
      process.exit(1);
    }
  };
  terminal.registerCleanupLeaf('process-admission', containProcesses);
  const stopForSignal = (): void => {
    if (starting) {
      startupController.abort(new Error('Startup initialization interrupted.'));
      return;
    }
    void terminal.stop().then((report) => {
      logShutdownWarnings(report);
      process.exit(0);
    });
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  terminal.registerCleanupLeaf('signal-handlers', () => {
    process.removeListener('SIGINT', stopForSignal);
    process.removeListener('SIGTERM', stopForSignal);
  });
  let environment: Environment;
  let server: ServerInstance;
  let boundListener: App['boundListener'];
  try {
    environment = await loadEnvironment(options, env);
    assertInitializerCurrent();
    for (const warning of environment.configWarnings) console.error(formatConfigWarning(warning));
    if (
      options.createRuntime &&
      readProjectCardOrAssertInitialPublicationAllowed(projectRoot) === null
    ) {
      await publishInitialProjectRuntime(projectRoot, environment.workflows, {
        runner: processRunner,
        parentScope: bootstrapScope,
        signal: startupController.signal,
        assertCurrent: assertInitializerCurrent,
      });
    }
    assertInitializerCurrent();
    initializeAndValidateCurrentGeneratedState(projectRoot, environment.workflows);
    assertInitialProjectPolicy(projectRoot, environment.workflows);
    const restartPort = createRestartPort({
      onAcknowledgedRestart: () => terminal.stop(),
      exit: (code) => process.exit(code),
    });
    const onOversightOwnerFailure = createApplicationOwnerFailureHandler({
      component: 'oversight',
      terminal,
      exit: (code) => process.exit(code),
    });
    const onExternalAnalystOwnerFailure = createApplicationOwnerFailureHandler({
      component: 'external-analyst',
      terminal,
      exit: (code) => process.exit(code),
    });
    server = await startServer({
      environment,
      terminal,
      restartPort,
      processIdentity,
      fatalPort,
      processRegistry,
      processRunner,
      onOversightOwnerFailure,
      onExternalAnalystOwnerFailure,
    });
    assertInitializerCurrent();
    const address = server.fastify.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Server did not publish a TCP control address.');
    boundListener = { host: address.address, port: address.port };
    const dialHost =
      environment.server.host === '0.0.0.0' || environment.server.host === '::'
        ? '127.0.0.1'
        : environment.server.host;
    const urlHost = dialHost.includes(':') ? `[${dialHost}]` : dialHost;
    publishRuntimeControlEndpoint(lifecycleLock, {
      origin: `http://${urlHost}:${address.port}`,
      auth: environment.auth.apiToken === undefined ? 'disabled' : 'bearer',
    });
    assertInitializerCurrent();
    starting = false;
  } catch (error) {
    if (fatal) throw error;
    if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error);
    processRunner.closeLaunchAdmission();
    await containProcesses();
    const report = await terminal.stop();
    logShutdownWarnings(report);
    throw error;
  }

  const stop = () => terminal.stop();
  return { environment, server, boundListener, stop };
}
