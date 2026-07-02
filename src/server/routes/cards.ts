import type { FastifyInstance } from 'fastify';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { CardStore } from '../../cards/store-api.js';
import { registerOperatorContractRoutes } from './operator-contracts.js';
import { configureAuthPolicy } from '../auth-policy.js';

export function registerCardRoutes(fastify: FastifyInstance, projectRoot: string, runtimeApplication: RuntimeApplication | undefined, cardStore: CardStore): void {
  configureAuthPolicy({ apiToken: process.env['SAIVAGE_API_TOKEN'] });
  registerOperatorContractRoutes({ fastify, projectRoot, runtimeApplication, cardStore });
}
