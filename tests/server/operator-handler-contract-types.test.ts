import { describe, expect, it } from '@jest/globals';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  SaivageConfig,
} from '../../src/schemas/saivage-config.js';
import type {
  OperatorApiBody,
  OperatorApiHandlerResult,
  OperatorApiParams,
  OperatorApiQuery,
} from '../../src/contracts/index.js';
import {
  defineOperatorContractHandlers,
  type OperatorContractHandlerMap,
} from '../../src/server/routes/operator-handler-context.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';
import { buildProcessOperatorContractHandlers } from '../../src/server/routes/operator-process-handlers.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';
import { ContractRuntime, type ContractPreSendReply } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { buildRuntimeCardOperatorContractHandlers } from '../../src/server/routes/operator-runtime-card-handlers.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';
import type { CardService } from '../../src/cards/card-api.js';
import type { McpToolsReadModelProvider } from '../../src/mcp/manager-api.js';

declare const runtimeApplication: RuntimeApplication;
declare const saivageConfig: SaivageConfig;
declare const processRunner: ProcessRunner;
declare const cardStore: CardService;
declare const mcpToolsProvider: McpToolsReadModelProvider;
const serverAvailability = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  components: {
    api: { state: 'available' as const, source: 'health-check' as const, checkedAt: '2026-01-01T00:00:00.000Z' },
    runtime: { state: 'degraded' as const, source: 'runtime-application' as const, checkedAt: '2026-01-01T00:00:00.000Z' },
    mcp: { state: 'idle' as const, source: 'mcp-manager' as const, checkedAt: '2026-01-01T00:00:00.000Z' },
  },
};
const actorRuntime = { pauseMode: 'idle' as const, cards: [] };

function chatFactoryDependencyTypeFixtures(): void {
  buildChatOperatorContractHandlers({ projectRoot: '.', runtimeApplication, saivageConfig });
  // @ts-expect-error Chat composition requires the runtime application.
  buildChatOperatorContractHandlers({ projectRoot: '.', saivageConfig });
  // @ts-expect-error Chat composition requires the startup-selected Saivage config.
  buildChatOperatorContractHandlers({ projectRoot: '.', runtimeApplication });
}

function processFactoryDependencyTypeFixtures(): void {
  buildProcessOperatorContractHandlers({ projectRoot: '.', processRunner });
  // @ts-expect-error Process composition requires the application-owned runner.
  buildProcessOperatorContractHandlers({ projectRoot: '.' });
}

function runtimeAndMcpFactoryDependencyTypeFixtures(): void {
  const serverAvailabilityProvider = () => serverAvailability;
  buildRuntimeCardOperatorContractHandlers({ projectRoot: '.', cardStore, runtimeApplication, serverAvailabilityProvider });
  buildMcpOperatorContractHandlers({ mcpToolsProvider });
  // @ts-expect-error Runtime/card composition requires the card service.
  buildRuntimeCardOperatorContractHandlers({ projectRoot: '.', runtimeApplication, serverAvailabilityProvider });
  // @ts-expect-error Runtime/card composition requires the runtime application.
  buildRuntimeCardOperatorContractHandlers({ projectRoot: '.', cardStore, serverAvailabilityProvider });
  // @ts-expect-error Runtime/card composition requires the availability provider.
  buildRuntimeCardOperatorContractHandlers({ projectRoot: '.', cardStore, runtimeApplication });
  // @ts-expect-error MCP composition requires the tools read-model provider.
  buildMcpOperatorContractHandlers({});
}

function contractRuntimeDependencyTypeFixtures(): void {
  new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: null as never, fatalPort: testApplicationFatalPort });
}

const handlers = defineOperatorContractHandlers({
  'cards.history.get': ({ params }) => {
    const parsed: { id: string; version: number } = params;
    void parsed.version;
    return { statusCode: 500, body: { error: 'InternalServerError', message: 'Internal server error' } };
  },
  'cards.diff': ({ params, query }) => {
    const parsedParams: { id: string } = params;
    const parsedQuery: { from: number; to?: number | 'current' } = query;
    void `${parsedParams.id}:${String(parsedQuery.from)}`;
    return { statusCode: 500, body: { error: 'InternalServerError', message: 'Internal server error' } };
  },
  'chats.send': ({ body, request, reply }) => {
    const parsedBody: { content: string; workspaceContext?: { view: string | null; entityId: string | null; refinement: Record<string, string> | null } } = body;
    const rawRequest: FastifyRequest = request;
    const preSendReply: ContractPreSendReply = reply;
    preSendReply.header('x-type-fixture', 'ok');
    // @ts-expect-error Contract handlers cannot send responses directly.
    reply.send({});
    // @ts-expect-error Contract handlers cannot select response status directly.
    reply.status(500);
    // @ts-expect-error The narrowed capability is not a FastifyReply.
    const rawReply: FastifyReply = reply;
    void `${String(parsedBody.content)}:${rawRequest.id}:${String(rawReply)}`;
    return { statusCode: 500, body: { error: 'InternalServerError', message: 'Internal server error' } };
  },
});

const noParams: OperatorApiParams<'health.liveness'> = undefined;
const noQuery: OperatorApiQuery<'health.liveness'> = undefined;
const noBody: OperatorApiBody<'health.liveness'> = undefined;
// @ts-expect-error Operations without a params schema expose undefined.
const invalidNoParams: OperatorApiParams<'health.liveness'> = {};
// @ts-expect-error Operations without a query schema expose undefined.
const invalidNoQuery: OperatorApiQuery<'health.liveness'> = {};
// @ts-expect-error Operations without a body schema expose undefined.
const invalidNoBody: OperatorApiBody<'health.liveness'> = {};

const implicitSuccess: OperatorApiHandlerResult<'health.liveness'> = {
  body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' },
};
const explicitSuccess: OperatorApiHandlerResult<'health.liveness'> = {
  statusCode: 200,
  body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' },
};
const readinessReady: OperatorApiHandlerResult<'health.readiness'> = { body: { status: 'ready', serverAvailability } };
const nullRuntimeState: OperatorApiHandlerResult<'runtime.getState'> = { body: { projectRoot: '/project', projectId: 'project', runtime: null, serverAvailability } };
const stoppedRuntimeStatus: OperatorApiHandlerResult<'runtime.status'> = { body: { runtime: 'stopped', currentCardId: null, started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 1, actorRuntime, serverAvailability } };
// @ts-expect-error Readiness requires concrete availability.
const readinessWithoutAvailability: OperatorApiHandlerResult<'health.readiness'> = { body: { status: 'ready' } };
// @ts-expect-error Runtime get-state requires concrete availability even when runtime state is null.
const stateWithoutAvailability: OperatorApiHandlerResult<'runtime.getState'> = { body: { projectRoot: '/project', projectId: 'project', runtime: null } };
// @ts-expect-error Runtime status requires concrete availability even when runtime is stopped.
const statusWithoutAvailability: OperatorApiHandlerResult<'runtime.status'> = { body: { runtime: 'stopped', currentCardId: null, started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 1, actorRuntime } };
// @ts-expect-error 418 is not declared by the readiness operation.
const undeclaredStatus: OperatorApiHandlerResult<'health.readiness'> = { statusCode: 418, body: { error: 'teapot' } };
// @ts-expect-error cards.get does not declare the history-entry 404 body.
const wrongNotFoundBody: OperatorApiHandlerResult<'cards.get'> = { statusCode: 404, body: { error: 'Card history entry not found', cardId: 'project', version_seq: 1 } };
// @ts-expect-error A success payload cannot be returned under a declared 404 status.
const successUnderNotFound: OperatorApiHandlerResult<'files.content'> = { statusCode: 404, body: { path: 'README.md', content: '', size: 0, contentType: 'text/plain', redacted: false, sensitivity: 'public' } };
// @ts-expect-error Every handler result has a response body.
const missingBody: OperatorApiHandlerResult<'health.liveness'> = {};

// @ts-expect-error A complete assembly cannot omit registry operations.
const incompleteAssembly: OperatorContractHandlerMap = handlers;

describe('operator handler contract type fixtures', () => {
  it('retains only compile-time contract fixtures at runtime', () => {
    expect(Object.keys(handlers)).toEqual(['cards.history.get', 'cards.diff', 'chats.send']);
    expect([
      noParams,
      noQuery,
      noBody,
      invalidNoParams,
      invalidNoQuery,
      invalidNoBody,
      implicitSuccess.statusCode,
      explicitSuccess.statusCode,
      readinessReady.statusCode,
      nullRuntimeState,
      stoppedRuntimeStatus,
      readinessWithoutAvailability,
      stateWithoutAvailability,
      statusWithoutAvailability,
      undeclaredStatus.statusCode,
      wrongNotFoundBody.statusCode,
      successUnderNotFound.statusCode,
      missingBody,
      incompleteAssembly,
      chatFactoryDependencyTypeFixtures,
      processFactoryDependencyTypeFixtures,
      runtimeAndMcpFactoryDependencyTypeFixtures,
      contractRuntimeDependencyTypeFixtures,
    ]).toBeDefined();
  });
});
