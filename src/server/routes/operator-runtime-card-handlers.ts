import {
  buildContentPolicyReadModel,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/index.js';
import type { OperatorApiHandlerResult } from '../../contracts/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorCardServiceContext,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { SAIVAGE_VERSION } from '../../version.js';
import { createEventLog } from '../../observability/index.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext &
  OperatorRuntimeProviderContext &
  OperatorAvailabilityContext &
  OperatorCardServiceContext;

function rejectSuppliedRuntimeControlBody(
  body: unknown,
): Extract<OperatorApiHandlerResult<'runtime.pause'>, { statusCode: 400 }> | null {
  if (body === undefined) return null;
  return {
    statusCode: 400,
    body: {
      error: 'ValidationError',
      message: 'Runtime control request must not include a body',
      issues: [{ path: 'body', message: 'Request body must be absent' }],
    },
  };
}

export function buildRuntimeCardOperatorContractHandlers(
  options: RuntimeCardOperatorHandlerOptions,
) {
  const { projectRoot } = options;
  const eventLog = createEventLog(projectRoot);
  let cardsReadModel: CardsReadModelService | null = null;
  const getCardsReadModel = () => {
    cardsReadModel ??= new CardsReadModelService(
      projectRoot,
      options.cardStore,
      options.runtimeApplication.runtimeApi,
    );
    return cardsReadModel;
  };

  return defineOperatorContractHandlers({
    'health.liveness': () => ({
      body: { status: 'ok', version: SAIVAGE_VERSION, project: 'saivage-v3' },
    }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider();
      return { body: { status: 'ready', serverAvailability } };
    },
    'runtime.getState': () =>
      getCardsReadModel().getRuntimeState(options.serverAvailabilityProvider()),
    'runtime.contentPolicy': () => ({ body: buildContentPolicyReadModel(projectRoot) }),
    'cards.children': ({ params }) => getCardsReadModel().getChildren(params.id),
    'cards.get': ({ params }) => getCardsReadModel().getCard(params.id),
    'cards.records.list': ({ params }) => getCardsReadModel().listRecords(params.id),
    'cards.records.get': ({ params }) => getCardsReadModel().getRecord(params.id, params.name),
    'cards.records.history.list': ({ params }) =>
      getCardsReadModel().listRecordHistory(params.id, params.name),
    'cards.records.versions.get': ({ params }) =>
      getCardsReadModel().getRecordVersion(params.id, params.name, params.version),
    'cards.records.diff': ({ params, query }) =>
      getCardsReadModel().diffRecord(params.id, params.name, query),
    'cards.history.list': ({ params }) => getCardsReadModel().listHistory(params.id),
    'cards.history.get': ({ params }) =>
      getCardsReadModel().getHistoryEntry(params.id, params.version),
    'cards.diff': ({ params, query }) => getCardsReadModel().diffCard(params.id, query),
    'runtime.status': () => {
      return {
        body: buildRuntimeStatusReadModel({
          runtimeApi: options.runtimeApplication.runtimeApi,
          serverAvailability: options.serverAvailabilityProvider(),
          restartCapability: options.restartCapability,
          oversight: options.runtimeApplication.getOversightStatus(),
        }),
      };
    },
    'runtime.pause': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) {
        eventLog.appendEvent({
          kind: 'operator_runtime_control',
          actor: 'operator',
          surface: 'operator_api',
          result: { operation: 'pause_runtime', outcome: 'rejected', reason: 'body_not_allowed' },
        });
        return rejection;
      }
      options.runtimeApplication.runtimeApi.pause();
      const response = {
        body: buildRuntimeStatusReadModel({
          runtimeApi: options.runtimeApplication.runtimeApi,
          serverAvailability: options.serverAvailabilityProvider(),
          restartCapability: options.restartCapability,
          oversight: options.runtimeApplication.getOversightStatus(),
        }),
      };
      eventLog.appendEvent({
        kind: 'operator_runtime_control',
        actor: 'operator',
        surface: 'operator_api',
        result: {
          operation: 'pause_runtime',
          outcome: 'returned',
          runtime_status: response.body.runtime,
        },
      });
      return response;
    },
    'runtime.resume': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) {
        eventLog.appendEvent({
          kind: 'operator_runtime_control',
          actor: 'operator',
          surface: 'operator_api',
          result: { operation: 'resume_runtime', outcome: 'rejected', reason: 'body_not_allowed' },
        });
        return rejection;
      }
      options.runtimeApplication.runtimeApi.resume();
      const response = {
        body: buildRuntimeStatusReadModel({
          runtimeApi: options.runtimeApplication.runtimeApi,
          serverAvailability: options.serverAvailabilityProvider(),
          restartCapability: options.restartCapability,
          oversight: options.runtimeApplication.getOversightStatus(),
        }),
      };
      eventLog.appendEvent({
        kind: 'operator_runtime_control',
        actor: 'operator',
        surface: 'operator_api',
        result: {
          operation: 'resume_runtime',
          outcome: 'returned',
          runtime_status: response.body.runtime,
        },
      });
      return response;
    },
    stop_project: async ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) {
        eventLog.appendEvent({
          kind: 'operator_runtime_control',
          actor: 'operator',
          surface: 'operator_api',
          result: { operation: 'stop_project', outcome: 'rejected', reason: 'body_not_allowed' },
        });
        return rejection;
      }
      const body = await options.runtimeApplication.runtimeApi.stopProject();
      eventLog.appendEvent({
        kind: 'operator_runtime_control',
        actor: 'operator',
        surface: 'operator_api',
        result: {
          operation: 'stop_project',
          outcome: 'returned',
          status: body.status,
          contained: body.contained,
        },
      });
      return { body };
    },
    restart_server: ({ reply }) => {
      if (!options.restartCapability.available) {
        eventLog.appendEvent({
          kind: 'operator_runtime_control',
          actor: 'operator',
          surface: 'operator_api',
          result: {
            operation: 'restart_server',
            outcome: 'rejected',
            reason: 'restart_unavailable',
          },
        });
        return {
          statusCode: 403,
          body: {
            code: 'restart_unavailable',
            message: 'restart unavailable: operator authentication disabled',
          },
        };
      }
      const restartPort = options.restartCapability.port;
      restartPort.schedule();
      eventLog.appendEvent({
        kind: 'operator_runtime_control',
        actor: 'operator',
        surface: 'operator_api',
        result: { operation: 'restart_server', outcome: 'restart_scheduled' },
      });
      reply.raw.once('finish', () => {
        void restartPort.acknowledge();
      });
      return { body: { status: 'restart_scheduled' } };
    },
  });
}
