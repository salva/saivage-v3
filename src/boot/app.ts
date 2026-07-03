import { loadEnvironment, type Environment } from '../config/index.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { startServer, type ServerInstance } from '../server/server.js';

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

export async function startApp(options: StartAppOptions): Promise<App> {
  const environment = loadEnvironment(options.argv, options.env ?? process.env);
  const scope = createResourceScope('app');
  const server = await startServer({ environment, scope: scope.child('server') });

  async function stop(): Promise<void> {
    await scope.dispose();
  }

  scope.onSignal('SIGINT', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigint' });
  scope.onSignal('SIGTERM', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigterm' });

  return { environment, scope, server, stop };
}
