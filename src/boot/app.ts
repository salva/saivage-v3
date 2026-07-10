import { loadEnvironment, type Environment } from '../config/index.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { initProjectTree } from '../persistence/index.js';
import { acquireLock, releaseLock } from '../runtime/lock.js';
import { startServer, type ServerInstance } from '../server/server.js';
import { resolve } from 'node:path';

export interface App {
  readonly environment: Environment;
  readonly scope: ResourceScope;
  readonly server: ServerInstance;
  stop: () => Promise<void>;
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
    } else if (arg.startsWith('--project-root=')) {
      projectRoot = arg.slice('--project-root='.length);
    }
  }
  return { projectRoot: resolve(projectRoot), createRuntime };
}

export async function startApp(options: StartAppOptions): Promise<App> {
  const env = options.env ?? process.env;
  const prelock = prelockStartupInputs(options.argv, env);
  const scope = createResourceScope('app');
  acquireLock(prelock.projectRoot);
  scope.add({ dispose: () => releaseLock(prelock.projectRoot) }, { name: 'runtime-process-lock' });
  let environment: Environment;
  let server: ServerInstance;
  try {
    if (prelock.createRuntime) initProjectTree(prelock.projectRoot);
    environment = loadEnvironment(options.argv, env);
    server = await startServer({ environment, scope: scope.child('server') });
  } catch (error) {
    await scope.dispose();
    throw error;
  }

  async function stop(): Promise<void> {
    await scope.dispose();
  }

  scope.onSignal('SIGINT', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigint' });
  scope.onSignal('SIGTERM', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigterm' });

  return { environment, scope, server, stop };
}
