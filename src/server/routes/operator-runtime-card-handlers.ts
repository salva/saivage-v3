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
  let cardsReadModel: CardsReadModelService | null = null;
  const getCardsReadModel = () => {
    cardsReadModel ??= new CardsReadModelService(projectRoot, requireCardStore(options.cardStore));
    return cardsReadModel;
  };

  return {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const ready = serverAvailability?.components.persistence.state !== 'unavailable';
      return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => getCardsReadModel().getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => getCardsReadModel().listCards(),
    'cards.get': ({ params }) => getCardsReadModel().getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => getCardsReadModel().listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return getCardsReadModel().getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => getCardsReadModel().diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime status.');
      return { body: buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) };
    },
    'runtime.pause': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime pause.');
      options.runtimeApplication.runtimeControl.pause({ actor: 'user', surface: 'rest', paramsSummary: '{}' });
      return { body: buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) };
    },
    'runtime.resume': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime resume.');
      options.runtimeApplication.runtimeControl.resume({ actor: 'user', surface: 'rest', paramsSummary: '{}' });
      return { body: buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) };
    },
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot, requireCardStore(options.cardStore)) }),
  };
}
