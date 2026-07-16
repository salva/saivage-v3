import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorCardServiceContext,
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorAvailabilityContext & OperatorCardServiceContext;

function requireCardService(service: RuntimeCardOperatorHandlerOptions['cardStore']) {
  if (!service) throw new Error('Card service is unavailable. Use the production server composition or provide a route test service.');
  return service;
}

export function buildRuntimeCardOperatorContractHandlers(options: RuntimeCardOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  let cardsReadModel: CardsReadModelService | null = null;
  const getCardsReadModel = () => {
    if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime state.');
    cardsReadModel ??= new CardsReadModelService(projectRoot, requireCardService(options.cardStore), options.runtimeApplication.runtimeApi);
    return cardsReadModel;
  };

  return {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const ready = serverAvailability?.components.runtime.state !== 'unavailable';
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
      return { body: { ...buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    'runtime.pause': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime pause.');
      options.runtimeApplication.runtimeControl.pause({ actor: 'user', surface: 'rest', paramsSummary: '{}' });
      return { body: { ...buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    'runtime.resume': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime resume.');
      options.runtimeApplication.runtimeControl.resume({ actor: 'user', surface: 'rest', paramsSummary: '{}' });
      return { body: { ...buildRuntimeStatusReadModel({ projectRoot, runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    stop_project: async () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for project stop.');
      try { return { body: await options.runtimeApplication.runtimeControl.stopProject({ actor: 'user', surface: 'rest', paramsSummary: '{}' }) }; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'runtime_control_conflict') return { statusCode: 409, body: { code: 'runtime_control_conflict', message: error.message } };
        throw error;
      }
    },
    restart_server: ({ reply }) => {
      if (!options.restartServerAvailable) return { statusCode: 403, body: { code: 'restart_unavailable', message: 'restart unavailable: operator authentication disabled' } };
      if (!options.restartPort) throw new Error('Restart port is unavailable.');
      options.restartPort.schedule();
      reply.raw.once('finish', () => { void options.restartPort!.acknowledge(); });
      return { body: { status: 'restart_scheduled' } };
    },
    'runtime.cardRuns': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime card runs.');
      return { body: buildCardRunsResponse(projectRoot, requireCardService(options.cardStore), options.runtimeApplication.runtimeApi) };
    },
  };
}
