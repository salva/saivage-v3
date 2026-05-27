import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/index.js';
import { operatorApiContracts } from '../../contracts/index.js';
import { CardsReadModelService } from '../../application/read-models/index.js';
import { buildServerAvailability } from '../availability.js';
import { ContractRuntime, type ContractHandler } from '../contract-runtime.js';

export function registerOperatorContractRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
  activeRuntimeProvider?: () => ActiveRuntime | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
}): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const cardsReadModel = new CardsReadModelService(projectRoot);

  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => cardsReadModel.getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => cardsReadModel.listCards(),
    'cards.get': ({ params }) => cardsReadModel.getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => cardsReadModel.listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return cardsReadModel.getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => cardsReadModel.diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
