import { loadEnvironment, type Environment } from '../config/index.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { classifyPersistenceOpenMode, createProjectPersistenceAuthority, type NewProjectRootInput, type ProjectPersistenceAuthority } from '../persistence/project-persistence-authority.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../runtime/lock.js';
import { startServer, type ServerInstance } from '../server/server.js';
import { createRestartPort } from './restart-port.js';
import { basename, resolve } from 'node:path';
import type { CardRecord } from '../schemas/index.js';
import { realpathSync } from 'node:fs';
import { createMutationLane } from '../application/mutation-lane.js';

export interface App {
  readonly environment: Environment;
  readonly scope: ResourceScope;
  readonly server: ServerInstance;
  readonly authority: ProjectPersistenceAuthority;
  stop: () => Promise<void>;
}

export function newProjectRootInput(projectRoot: string): NewProjectRootInput {
  const stamp = new Date().toISOString();
  const title = basename(projectRoot) || 'saivage-project';
  const card: CardRecord = {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title, status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, retries: 0, version_seq: 1,
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
    } else if (arg.startsWith('--project-root=')) {
      projectRoot = arg.slice('--project-root='.length);
    }
  }
  return { projectRoot: realpathSync(resolve(projectRoot)), createRuntime };
}

export async function startApp(options: StartAppOptions): Promise<App> {
  const env = options.env ?? process.env;
  const prelock = prelockStartupInputs(options.argv, env);
  const scope = createResourceScope('app');
  const lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: prelock.projectRoot, mode: 'bound' });
  const mutationComposition = createMutationLane();
  scope.add({ dispose: () => releaseRuntimeLifecycleLock(lifecycleLock) }, { name: 'runtime-process-lock' });
  let environment: Environment;
  let server: ServerInstance;
  let authority: ProjectPersistenceAuthority;
  const restartPort = createRestartPort({ dispose: async () => { await scope.dispose(); }, exit: (code) => process.exit(code) });
  try {
    const mode = prelock.createRuntime
      ? classifyPersistenceOpenMode(prelock.projectRoot, mutationComposition.authority, newProjectRootInput(prelock.projectRoot))
      : { kind: 'normal' } as const;
    authority = createProjectPersistenceAuthority({ projectRoot: prelock.projectRoot, lane: mutationComposition.lane, compositionAuthority: mutationComposition.authority, mode });
    environment = await loadEnvironment(options.argv, env, mutationComposition);
    server = await startServer({ environment, authority, mutationLane: mutationComposition.lane, compositionAuthority: mutationComposition.authority, scope: scope.child('server'), restartPort });
    const address = server.fastify.server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not publish a TCP control address.');
    const dialHost = environment.server.host === '0.0.0.0' || environment.server.host === '::' ? '127.0.0.1' : environment.server.host;
    const urlHost = dialHost.includes(':') ? `[${dialHost}]` : dialHost;
    publishRuntimeControlEndpoint(lifecycleLock, {
      origin: `http://${urlHost}:${address.port}`,
      auth: environment.auth.apiToken === undefined ? 'disabled' : 'bearer',
    });
  } catch (error) {
    await scope.dispose();
    throw error;
  }

  async function stop(): Promise<void> {
    await scope.dispose();
  }

  scope.onSignal('SIGINT', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigint' });
  scope.onSignal('SIGTERM', () => { void stop().then(() => process.exit(0)); }, { name: 'process-sigterm' });

  return { environment, authority, scope, server, stop };
}
