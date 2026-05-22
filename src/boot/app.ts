import { loadEnvironment, type Environment } from '../config/environment.js';
import { startServer, type ServerInstance } from '../server/server.js';

export interface App {
  readonly environment: Environment;
  readonly server: ServerInstance;
  stop: () => Promise<void>;
}

export interface StartAppOptions {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  createRuntime?: boolean;
}

export async function startApp(options: StartAppOptions): Promise<App> {
  const environment = loadEnvironment(options.argv, options.env ?? process.env);
  const server = await startServer({ environment, createRuntime: options.createRuntime });

  async function stop(): Promise<void> {
    await server.stop();
  }

  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });

  return { environment, server, stop };
}
