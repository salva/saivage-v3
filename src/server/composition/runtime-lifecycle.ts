import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import { ActiveRuntime } from '../../runtime/control-api.js';
import { wireRuntimeEvents } from '../websocket.js';

export type StartupFailure = { code: string; error: unknown };

export interface RuntimeStartupResult {
  activeRuntime?: ActiveRuntime;
  startupFailure?: StartupFailure;
}

export async function startActiveRuntime(options: {
  createRuntime: boolean | undefined;
  projectRoot: string;
  saivageConfig: SaivageConfig;
  fastify: FastifyInstance;
}): Promise<RuntimeStartupResult> {
  if (!options.createRuntime) return {};

  try {
    const activeRuntime = new ActiveRuntime(options.projectRoot, options.saivageConfig);
    await activeRuntime.start();
    wireRuntimeEvents(activeRuntime.runtime);
    options.fastify.log.info('ActiveRuntime started');
    return { activeRuntime };
  } catch (err) {
    options.fastify.log.warn(`ActiveRuntime initialization failed (continuing without runtime): ${err instanceof Error ? err.message : String(err)}`);
    return { startupFailure: { code: 'active-runtime-start-failed', error: err } };
  }
}
