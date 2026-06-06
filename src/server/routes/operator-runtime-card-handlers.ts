import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorCardStoreContext,
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorAvailabilityContext & OperatorCardStoreContext;

function requireCardStore(store: RuntimeCardOperatorHandlerOptions['cardStore']) {
  if (!store) throw new Error('CardStore is unavailable. Use the production server composition or provide a route test store.');
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
    'runtime.getState': () => new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).listCards(),
    'cards.get': ({ params }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => new CardsReadModelService(projectRoot, requireCardStore(options.cardStore)).diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication?.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot, requireCardStore(options.cardStore)) }),
  };
}
