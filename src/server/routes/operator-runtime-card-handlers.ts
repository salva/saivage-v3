import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import type { CardStore } from '../../cards/store-api.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorAvailabilityContext & {
  cardStoreProvider: () => CardStore | undefined;
};

function requireCardStore(provider: () => CardStore | undefined): CardStore {
  const store = provider();
  if (!store) throw new Error('CardStore is unavailable. Start runtime or provide a server-owned CardStore.');
  return store;
}

export function buildRuntimeCardOperatorContractHandlers(options: RuntimeCardOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;

  return {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).listCards(),
    'cards.get': ({ params }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStoreProvider)).diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplicationProvider()?.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot, requireCardStore(options.cardStoreProvider)) }),
  };
}
