import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/runtime-composition.js';
import { wireRuntimeEvents } from '../websocket.js';

export type StartupFailure = { code: string; error: unknown };

export interface RuntimeStartupResult {
  runtimeApplication?: RuntimeApplication;
  startupFailure?: StartupFailure;
}

export async function startRuntimeApplication(options: {
  createRuntime: boolean | undefined;
  projectRoot: string;
  saivageConfig: SaivageConfig;
  fastify: FastifyInstance;
}): Promise<RuntimeStartupResult> {
  if (!options.createRuntime) return {};

  try {
    const runtimeApplication = createRuntimeApplication(options.projectRoot, options.saivageConfig);
    await runtimeApplication.runtimeApi.start();
    wireRuntimeEvents(runtimeApplication.runtimeApi);
    options.fastify.log.info('Runtime application started');
    return { runtimeApplication };
  } catch (err) {
    options.fastify.log.warn(`Runtime application initialization failed (continuing without runtime): ${err instanceof Error ? err.message : String(err)}`);
    return { startupFailure: { code: 'runtime-application-start-failed', error: err } };
  }
}
