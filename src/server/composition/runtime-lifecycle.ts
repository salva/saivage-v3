import type { FastifyInstance } from 'fastify';
import { createRuntimeApplication, type RuntimeApplication, type RuntimeApplicationServices } from '../../application/runtime-composition.js';
import type { SyncHub } from '../sync-hub.js';

export async function startRuntimeApplication(options: RuntimeApplicationServices & {
  fastify: FastifyInstance;
  syncHub?: SyncHub;
}): Promise<RuntimeApplication> {
  const runtimeApplication = createRuntimeApplication(options);
  await runtimeApplication.runtimeApi.start();
  options.syncHub?.wire(runtimeApplication.runtimeApi);
  options.fastify.log.info('Runtime application started');
  return runtimeApplication;
}
