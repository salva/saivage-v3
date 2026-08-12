import { describe, expect, it } from '@jest/globals';
import * as contractsModule from '../../src/contracts/index.js';
import * as operatorApiModule from '../../src/contracts/operator-api.js';
import { AvailabilityComponentSourceSchema, EventsQuerySchema, operatorApiContracts, operatorRouteInventory, parseOperatorResponse, UnauthorizedErrorSchema, type OperatorApiBody, type OperatorApiResponse, type OperatorApiResponseStatus } from '../../src/contracts/operator-api.js';
import type { CardDiffRow as OperatorApiCardDiffRow } from '../../src/contracts/operator-api.js';
import type { CardDiffRow as IndexCardDiffRow } from '../../src/contracts/index.js';
import { positiveSafeIntegerSchema } from '../../src/schemas/index.js';
import { allRepresentativeLoggedEvents } from '../helpers/logged-events.js';

const timestamp = '2026-01-01T00:00:00.000Z';

const runtimeState = {
  status: 'running',
  project_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
  current_card_id: 'project',
  updated_at: '2026-01-01T00:00:01.000Z',
  pid: 123,
};

const canonicalCard = {
  id: 'project', type: 'project', children: [], title: 'Project', subtype: null, tags: [], priority: 0,
  urgency: 'normal', created_by: 'analyst', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1,
  assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
  metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
  status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [],
} as const;
const canonicalCardDetail = { id:'project',type:'project',title:'Project',lifecycle:canonicalCard.lifecycle,version_seq:1,urgency:'normal',created_at:canonicalCard.created_at,updated_at:canonicalCard.updated_at,allowedActions:[] } as const;
const canonicalHierarchyCard = { id:'project',type:'project',title:'Project',status:'backlog' } as const;
const canonicalRecordDescriptors = [{ name: 'brief.md', format: 'markdown', schema: 'card-brief.v1', writers: ['analyst', 'planner'], bootstrap: true, current: null }] as const;
const canonicalCardKeys = ['id', 'type', 'children', 'title', 'subtype', 'tags', 'priority', 'urgency', 'created_by', 'created_at', 'updated_at', 'version_seq', 'assigned_to', 'depends_on', 'related', 'lifecycle', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text', 'status_text_updated_at', 'status_text_author_session_id', 'latest_self_report', 'metadata', 'pending_notifications'] as const;
const validOperatorApiRow: OperatorApiCardDiffRow = { field: 'title', before: null, after: 'new' };
// @ts-expect-error CardDiffRow requires before through operator-api.ts.
const missingBefore: OperatorApiCardDiffRow = { field: 'title', after: 'new' };
// @ts-expect-error CardDiffRow requires after through index.ts.
const missingAfter: IndexCardDiffRow = { field: 'title', before: null };
const validIndexRow: IndexCardDiffRow = validOperatorApiRow;

describe('operator API runtime contract without runtime ledgers', () => {
  it('reserves public contracts for the exact health probes and authenticates every operator API route', () => {
    const contracts = Object.values(operatorApiContracts);
    const inventoryByOperation = new Map(operatorRouteInventory().map((route) => [route.operationId, route]));
    const publicContracts = contracts.filter((contract) => contract.auth === 'public');

    expect(publicContracts.map(({ operationId, path }) => ({ operationId, path }))).toEqual([
      { operationId: 'health.liveness', path: '/health' },
      { operationId: 'health.readiness', path: '/health/ready' },
    ]);

    for (const contract of contracts) {
      if (contract.path.startsWith('/api/')) {
        expect(contract.auth).toBe('operator-session');
        expect(inventoryByOperation.get(contract.operationId)?.requiresAuth).toBe(true);
      }
      if (contract.auth === 'operator-session') expect(contract.response[401]).toBe(UnauthorizedErrorSchema);
    }

    for (const contract of publicContracts) expect(contract.response).not.toHaveProperty('401');
  });

  it('uses each operation response 200 schema as its exact success authority', () => {
    for (const contract of Object.values(operatorApiContracts)) {
      expect(contract.response).toHaveProperty('200');
      expect(contract.response[200]).toBe(contract.success);
    }
  });

  it('parses only the exact schema declared for the operation and status', () => {
    const success = parseOperatorResponse('providers.list', 200, {
      availabilityScope: 'process_local_reset_on_restart',
      providers: {},
    });
    expect(success.availabilityScope).toBe('process_local_reset_on_restart');

    const unauthorized: OperatorApiResponse<'providers.list', 401> = parseOperatorResponse(
      'providers.list',
      401,
      { error: 'Unauthorized', statusCode: 401 },
    );
    expect(unauthorized).toEqual({ error: 'Unauthorized', statusCode: 401 });

    const dynamicStatus: number = 200;
    const dynamicResponse: OperatorApiResponse<
      'providers.list',
      OperatorApiResponseStatus<'providers.list'>
    > = parseOperatorResponse('providers.list', dynamicStatus, success);
    expect(dynamicResponse).toEqual(success);

    expect(() => parseOperatorResponse('providers.list', 401, {
      error: 'Unauthorized',
    })).toThrow();
    expect(() => parseOperatorResponse('providers.list', 418, {
      error: 'Unauthorized',
      statusCode: 401,
    })).toThrow('does not declare response status 418');
  });

  it('exports one strict recursive card diff row contract through both backend public paths', () => {
    const recursiveRow = {
      field: 'metadata',
      before: { active: true, count: 3, note: 'old', nested: [null, [], {}] },
      after: { active: false, count: 4.5, nested: [{ label: 'new' }] },
    };

    expect(operatorApiModule.CardDiffRowSchema.parse(recursiveRow)).toEqual(recursiveRow);
    expect(contractsModule.CardDiffRowSchema.parse(recursiveRow)).toEqual(recursiveRow);
    expect([validOperatorApiRow, missingBefore, missingAfter, validIndexRow]).toEqual([
      validOperatorApiRow,
      { field: 'title', after: 'new' },
      { field: 'title', before: null },
      validOperatorApiRow,
    ]);
  });

  it('parses card diff status 200 only when every strict row contains recursive JSON values', () => {
    const payload = {
      card_id: 'card-a',
      from: 2,
      to: 3,
      diff: [{
        field: 'metadata',
        before: null,
        after: {
          boolean: true,
          string: 'value',
          finite: -2.5,
          array: [false, 'nested', 0, null, [], {}],
          object: { nested: { values: [1, 2, 3] } },
        },
      }],
    };

    expect(parseOperatorResponse('cards.diff', 200, payload)).toEqual(payload);

    const invalidPayloads = [
      { ...payload, diff: {} },
      { ...payload, diff: [{ before: null, after: 'new' }] },
      { ...payload, diff: [{ field: 'title', after: 'new' }] },
      { ...payload, diff: [{ field: 'title', before: null }] },
      { ...payload, diff: [{ field: '', before: null, after: 'new' }] },
      { ...payload, diff: [{ field: 1, before: null, after: 'new' }] },
      { ...payload, diff: [{ field: 'title', before: null, after: 'new', extra: true }] },
      { ...payload, diff: [{ field: 'metadata', before: { nested: undefined }, after: null }] },
      { ...payload, diff: [{ field: 'metadata', before: [null, undefined], after: null }] },
    ];
    for (const invalid of invalidPayloads) {
      expect(() => parseOperatorResponse('cards.diff', 200, invalid)).toThrow();
    }
  });

  it('rejects every non-JSON JavaScript value through the shared card diff row schema', () => {
    const invalidValues = [
      undefined,
      () => 'value',
      Symbol('value'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { nested: undefined },
      [null, undefined],
    ];

    for (const value of invalidValues) {
      expect(operatorApiModule.CardDiffRowSchema.safeParse({
        field: 'metadata',
        before: value,
        after: null,
      }).success).toBe(false);
    }
  });

  it('exposes only exact chat operations and no aggregate chat contract', () => {
    expect(operatorApiContracts).not.toHaveProperty('chats.list');
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'chats.get', method: 'GET', path: '/api/chat' }),
      expect.objectContaining({ operationId: 'chats.send', method: 'POST', path: '/api/chat' }),
    ]));
    expect(operatorRouteInventory()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/api/chats' }),
    ]));
    expect(operatorApiModule).not.toHaveProperty('ChatListResponseSchema');
    expect(contractsModule).not.toHaveProperty('ChatListResponseSchema');
  });

  it('registers Doctor as an authenticated files/debug contract operation', () => {
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'debug.doctor', method: 'GET', path: '/api/debug/doctor', requiresAuth: true, successSchemaName: 'DoctorResponse' }),
    ]));
    expect(operatorApiContracts['debug.doctor'].response).toEqual({
      200: contractsModule.DoctorResponseSchema,
      401: contractsModule.UnauthorizedErrorSchema,
      500: contractsModule.UnexpectedInternalServerErrorSchema,
    });
  });

  it('registers the authenticated content-policy high-water operation with one strict response', () => {
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'runtime.contentPolicy', method: 'GET', path: '/api/runtime/content-policy', requiresAuth: true, successSchemaName: 'ContentPolicyRuntimeResponse' }),
    ]));
    const body = { refusal_high_water: 1, latest: { card_id: 'card-a', session_id: 'agent:executor:card-a', marker_id: 'marker', evidence_url: '/agents/agent%3Aexecutor%3Acard-a?entry=marker', blocked_at: timestamp } };
    expect(contractsModule.ContentPolicyRuntimeResponseSchema.parse(body)).toEqual(body);
    expect(contractsModule.ContentPolicyRuntimeResponseSchema.safeParse({ ...body, latest: { ...body.latest, provider_response: 'forbidden' } }).success).toBe(false);
  });

  it('uses one strict unexpected-500 schema for every mounted operation', () => {
    const body = { error: 'InternalServerError', message: 'Internal server error' };
    expect(contractsModule.UNEXPECTED_INTERNAL_SERVER_ERROR).toEqual(body);
    expect(Object.isFrozen(contractsModule.UNEXPECTED_INTERNAL_SERVER_ERROR)).toBe(true);
    for (const contract of Object.values(operatorApiContracts)) {
      expect(contract.response[500]).toBe(contractsModule.UnexpectedInternalServerErrorSchema);
      expect(contract.response[500].parse(body)).toEqual(body);
      expect(contract.response[500].safeParse({ ...body, diagnostic: 'secret' }).success).toBe(false);
      expect(contract.response[500].safeParse({ error: 'anything', message: 'secret' }).success).toBe(false);
    }
  });

  it('uses exact strict runtime-generated 4xx bodies', () => {
    const validation = {
      error: 'ValidationError',
      message: 'request failed validation',
      issues: [{ path: 'query.path', message: 'Expected string' }],
    };
    expect(contractsModule.ValidationErrorSchema.parse(validation)).toEqual(validation);
    expect(contractsModule.ValidationErrorSchema.safeParse({ ...validation, unexpected: true }).success).toBe(false);
    expect(contractsModule.ValidationErrorSchema.safeParse({ ...validation, issues: [{ ...validation.issues[0], unexpected: true }] }).success).toBe(false);
    expect(contractsModule.ValidationErrorSchema.safeParse({ error: 'Request validation failed', message: validation.message, issues: [] }).success).toBe(false);
    expect(contractsModule.ValidationErrorSchema.safeParse({ error: 'ValidationError', issues: [] }).success).toBe(false);

    expect(contractsModule.UnauthorizedErrorSchema.parse({ error: 'Unauthorized', statusCode: 401 })).toEqual({ error: 'Unauthorized', statusCode: 401 });
    expect(contractsModule.UnauthorizedErrorSchema.safeParse({ error: 'Unauthorized' }).success).toBe(false);
    expect(contractsModule.ForbiddenErrorSchema.parse({ error: 'Forbidden', statusCode: 403 })).toEqual({ error: 'Forbidden', statusCode: 403 });
    expect(contractsModule.ForbiddenErrorSchema.parse({ error: 'Forbidden', statusCode: 403, message: 'denied' })).toEqual({ error: 'Forbidden', statusCode: 403, message: 'denied' });
    expect(contractsModule.ForbiddenErrorSchema.safeParse({ error: 'Forbidden', statusCode: 403, message: '' }).success).toBe(false);
  });

  it('rejects representative top-level and nested extras in every REST contract family', () => {
    const availability = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      components: {
        api: { state: 'available', source: 'startup', checkedAt: '2026-01-01T00:00:00.000Z' },
        runtime: { state: 'idle', source: 'runtime-application', checkedAt: '2026-01-01T00:00:00.000Z' },
        mcp: { state: 'unknown', source: 'mcp-manager', checkedAt: '2026-01-01T00:00:00.000Z' },
      },
    };
    expect(contractsModule.ServerAvailabilitySchema.safeParse({ ...availability, unexpected: true }).success).toBe(false);
    expect(contractsModule.ServerAvailabilitySchema.safeParse({ ...availability, components: { ...availability.components, api: { ...availability.components.api, unexpected: true } } }).success).toBe(false);

    expect(operatorApiModule.WebSocketTicketResponseSchema.safeParse({ ticket: 'ticket', expiresAt: timestamp, unexpected: true }).success).toBe(false);
    expect(contractsModule.HealthLivenessResponseSchema.safeParse({ status: 'ok', version: '1', project: 'project', unexpected: true }).success).toBe(false);

    const session = { id: 'agent:planner:project', agent_name: 'planner', session_scope: 'card', card_id: 'project', started_at: timestamp };
    expect(operatorApiModule.AgentListResponseSchema.safeParse({ sessions: [session], unexpected: true }).success).toBe(false);
    expect(operatorApiModule.AgentListResponseSchema.safeParse({ sessions: [{ ...session, unexpected: true }] }).success).toBe(false);
    expect(operatorApiModule.ChatSendRequestSchema.safeParse({ content: 'hello', unexpected: true }).success).toBe(false);
    expect(operatorApiModule.ChatSendRequestSchema.safeParse({ content: 'hello', workspaceContext: { view: null, entityId: null, refinement: null, unexpected: true } }).success).toBe(false);

    const file = { name: 'README.md', path: 'README.md', type: 'file', size: 10, modifiedAt: timestamp };
    expect(operatorApiModule.WorkspaceFilesListResponseSchema.safeParse({ path: '.', files: [file], unexpected: true }).success).toBe(false);
    expect(operatorApiModule.WorkspaceFilesListResponseSchema.safeParse({ path: '.', files: [{ ...file, unexpected: true }] }).success).toBe(false);
    expect(operatorApiModule.ProcessListResponseSchema.safeParse({ processes: [], unexpected: true }).success).toBe(false);
    expect(operatorApiModule.EventsListResponseSchema.safeParse({ events: [], total: 0, unexpected: true }).success).toBe(false);

    const provider = {
      priority: 1,
      models: ['model'],
      candidateCount: 1,
      availableCandidateCount: 1,
      capabilitiesByModel: { model: { deliberatelyOpaque: true } },
      availability: [{ candidate: { provider: 'provider', account: null, model: 'model' }, state: 'available' }],
    };
    expect(operatorApiModule.ProviderSummarySchema.parse(provider).capabilitiesByModel).toEqual(provider.capabilitiesByModel);
    expect(operatorApiModule.ProviderSummarySchema.safeParse({ ...provider, unexpected: true }).success).toBe(false);
    expect(operatorApiModule.ProviderSummarySchema.safeParse({ ...provider, availability: [{ ...provider.availability[0], unexpected: true }] }).success).toBe(false);
    expect(operatorApiModule.ProviderSummarySchema.safeParse({ ...provider, availability: [{ ...provider.availability[0], candidate: { ...provider.availability[0]!.candidate, unexpected: true } }] }).success).toBe(false);

    const mcp = { servers: [{ name: 'server', transport: 'stdio', status: 'running', toolCount: 1, tools: [{ name: 'tool', stats: { total: 1, success: 1, error: 0 } }] }] };
    expect(operatorApiModule.McpToolsResponseSchema.safeParse({ ...mcp, unexpected: true }).success).toBe(false);
    expect(operatorApiModule.McpToolsResponseSchema.safeParse({ servers: [{ ...mcp.servers[0], tools: [{ ...mcp.servers[0]!.tools[0], unexpected: true }] }] }).success).toBe(false);
  });

  it('declares failure identities only for canonical session and card parameters', () => {
    const identities = Object.values(operatorApiContracts)
      .filter((contract) => 'failureIdentity' in contract)
      .map((contract) => ({ operationId: contract.operationId, identity: contract.failureIdentity }));
    expect(identities).toEqual([
      { operationId: 'cards.children', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.get', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.records.list', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.records.get', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.records.history.list', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.records.versions.get', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.records.diff', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.history.list', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.history.get', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'cards.diff', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'agents.detail', identity: { kind: 'session', parameter: 'id' } },
      { operationId: 'agents.conversationVersions.list', identity: { kind: 'session', parameter: 'id' } },
      { operationId: 'agents.conversationVersions.get', identity: { kind: 'session', parameter: 'id' } },
      { operationId: 'agents.cardSessions', identity: { kind: 'card', parameter: 'id' } },
      { operationId: 'agents.conversation', identity: { kind: 'session', parameter: 'id' } },
      { operationId: 'agents.llmExchange', identity: { kind: 'session', parameter: 'id' } },
    ]);
  });

  it('declares Pause, Resume, and Stop as bodyless while Restart retains exact confirmation', () => {
    expect(operatorApiContracts['runtime.pause']).not.toHaveProperty('body');
    expect(operatorApiContracts['runtime.resume']).not.toHaveProperty('body');
    expect(operatorApiContracts.stop_project).not.toHaveProperty('body');
    expect(operatorApiContracts.restart_server.body.parse({ confirmation: 'RESTART SERVER' })).toEqual({ confirmation: 'RESTART SERVER' });

    const pauseBody: OperatorApiBody<'runtime.pause'> = undefined;
    const resumeBody: OperatorApiBody<'runtime.resume'> = undefined;
    const stopBody: OperatorApiBody<'stop_project'> = undefined;
    // @ts-expect-error Bodyless runtime control operations do not admit an empty object.
    const invalidPauseBody: OperatorApiBody<'runtime.pause'> = {};
    expect([pauseBody, resumeBody, stopBody, invalidPauseBody]).toEqual([undefined, undefined, undefined, {}]);
  });

  it('keeps Stop contained success and removes the application-close conflict response', () => {
    expect(operatorApiContracts.stop_project.success.parse({ status: 'stopped', contained: true })).toEqual({ status: 'stopped', contained: true });
    expect(operatorApiContracts.stop_project.success.parse({ status: 'stopped', contained: false })).toEqual({ status: 'stopped', contained: false });
    expect(operatorApiContracts.stop_project.response).not.toHaveProperty('409');
    expect(operatorApiModule).not.toHaveProperty('RuntimeControlConflictSchema');
  });

  it('parses runtime state/status without command/run/activation projections', () => {
    expect(parseOperatorResponse('runtime.getState', 200, { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState }).runtime).toEqual(runtimeState);
    const status = parseOperatorResponse('runtime.status', 200, {
      runtime: 'running',
      currentCardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      started_at: '2026-01-01T00:00:00.000Z',
      restart_server_available: false,
      pid: 123,
      actorRuntime: { pauseMode: 'running', cards: [] },
    });
    expect(status).not.toHaveProperty('lastCommand');
    expect(status).not.toHaveProperty('activeRun');
    expect(status).not.toHaveProperty('latestRun');
    expect(() => parseOperatorResponse('runtime.status', 200, { ...status, actorRuntime: { ...status.actorRuntime, agents: [] } })).toThrow();
  });

  it('rejects removed runtime ledger fields and public schema exports are absent', () => {
    expect(() => parseOperatorResponse('runtime.getState', 200, { projectRoot: '/work/test', projectId: 'test', runtime: { ...runtimeState, runtime_commands: [], runtime_runs: [], runtime_activations: [] } })).toThrow();
    expect(() => parseOperatorResponse('runtime.getState', 200, { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } })).toThrow();
    expect(operatorApiContracts['runtime.status'].success.keyof().options).not.toEqual(expect.arrayContaining(['lastCommand', 'activeRun', 'latestRun']));
    for (const removed of ['active_card_run', 'last_tick_at']) expect(() => parseOperatorResponse('runtime.getState', 200, { projectRoot: '/work/test', projectId: 'test', runtime: { ...runtimeState, [removed]: null } })).toThrow();
    const validStatus = { runtime: 'running', currentCardId: 'project', started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 123, actorRuntime: { pauseMode: 'running', cards: [] } };
    for (const removed of ['goalCount', 'lastTickAt']) expect(() => parseOperatorResponse('runtime.status', 200, { ...validStatus, [removed]: null })).toThrow();
    for (const removed of ['activeWork', 'diagnostics']) expect(() => parseOperatorResponse('runtime.status', 200, { ...validStatus, actorRuntime: { ...validStatus.actorRuntime, [removed]: removed === 'diagnostics' ? [] : 'none' } })).toThrow();
  });

  it('requires strict live process state and a nonnegative safe node ordinal', () => {
    const base = { runtime: 'running', currentCardId: 'project', started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 123, actorRuntime: { pauseMode: 'running', cards: [{ cardId: 'project', actorState: 'running', processState: { cardType: 'project', stateId: 'node:plan', kind: 'node', nodeId: 'plan', executionOrdinal: 0 } }] } };
    expect(parseOperatorResponse('runtime.status', 200, base)).toEqual(base);
    expect(() => parseOperatorResponse('runtime.status', 200, { ...base, actorRuntime: { ...base.actorRuntime, cards: [{ cardId: 'project', actorState: 'running' }] } })).toThrow();
    for (const executionOrdinal of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5]) expect(() => parseOperatorResponse('runtime.status', 200, { ...base, actorRuntime: { ...base.actorRuntime, cards: [{ ...base.actorRuntime.cards[0], processState: { ...base.actorRuntime.cards[0]!.processState, executionOrdinal } }] } })).toThrow();
  });

  it('removes audited dead operator routes and their public schema exports', () => {
    for (const operationId of ['runtime.cardRuns', 'processes.get', 'mcp.status']) {
      expect(operatorApiContracts).not.toHaveProperty(operationId);
    }
    const paths = operatorRouteInventory().map(({ path }) => path);
    expect(paths).not.toEqual(expect.arrayContaining([
      '/api/runtime/card-runs',
      '/api/processes/:id',
      '/api/mcp/status',
    ]));
    for (const schema of ['RuntimeCardRunsResponseSchema', 'ProcessDetailResponseSchema', 'McpStatusResponseSchema']) {
      expect(operatorApiModule).not.toHaveProperty(schema);
      expect(contractsModule).not.toHaveProperty(schema);
    }
  });

  it('retains concrete runtime response schemas without a runtime summary contract', () => {
    expect(operatorApiModule).not.toHaveProperty('RuntimeSummarySchema');
    expect(contractsModule).not.toHaveProperty('RuntimeSummarySchema');

    const stateSchema = operatorApiContracts['runtime.getState'].success;
    expect(stateSchema.keyof().options).toEqual(['projectRoot', 'projectId', 'runtime', 'serverAvailability']);
    expect(stateSchema.shape).not.toHaveProperty('summary');
    expect(stateSchema.shape).not.toHaveProperty('runtimeSummary');

    const statusSchema = operatorApiContracts['runtime.status'].success;
    expect(statusSchema.keyof().options).toEqual(['runtime', 'currentCardId', 'started_at', 'restart_server_available', 'pid', 'actorRuntime', 'serverAvailability']);
    expect(statusSchema.shape).not.toHaveProperty('summary');
    expect(statusSchema.shape).not.toHaveProperty('runtimeSummary');
  });

  it('does not expose the removed debug state operation or response schemas', () => {
    expect(operatorApiContracts).not.toHaveProperty('debug.state');
    expect(operatorRouteInventory()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/api/debug/state' }),
    ]));
    expect(operatorApiModule).not.toHaveProperty('DebugRuntimeStateSchema');
    expect(operatorApiModule).not.toHaveProperty('DebugStateResponseSchema');
    expect(contractsModule).not.toHaveProperty('DebugStateResponseSchema');
  });

  it('accepts only exact canonical event and Debug error rows with matching totals', () => {
    const error = allRepresentativeLoggedEvents[0]!;
    expect(parseOperatorResponse('debug.errors', 200, { errors: [error], total: 1 })).toEqual({ errors: [error], total: 1 });
    expect(parseOperatorResponse('events.list', 200, { events: allRepresentativeLoggedEvents, total: 3 }).events).toHaveLength(3);

    for (const invalid of [
      { errors: [{ ...error, error_message: 1 }], total: 1 },
      { errors: [{ ...error, extra: true }], total: 1 },
    ]) expect(() => parseOperatorResponse('debug.errors', 200, invalid)).toThrow();

    const event = allRepresentativeLoggedEvents[0]!;
    for (const invalid of [
      { events: [{ ...event, id: undefined }], total: 1 },
      { events: [{ ...event, extra: true }], total: 1 },
      { events: [{ ...event, kind: 'obsolete_event' }], total: 1 },
      { events: [{ ...event, error_message: 1 }], total: 1 },
    ]) expect(() => parseOperatorResponse('events.list', 200, invalid)).toThrow();
  });

  it('keeps the operator card route inventory read-only', () => {
    const cardRoutes = operatorRouteInventory().filter(({ path }) => path.startsWith('/api/cards'));

    expect(cardRoutes).toEqual([
      expect.objectContaining({ operationId: 'cards.children', method: 'GET', path: '/api/cards/:id/children' }),
      expect.objectContaining({ operationId: 'cards.get', method: 'GET', path: '/api/cards/:id' }),
      expect.objectContaining({ operationId: 'cards.records.list', method: 'GET', path: '/api/cards/:id/records' }),
      expect.objectContaining({ operationId: 'cards.records.get', method: 'GET', path: '/api/cards/:id/records/:name' }),
      expect.objectContaining({ operationId: 'cards.records.history.list', method: 'GET', path: '/api/cards/:id/records/:name/history' }),
      expect.objectContaining({ operationId: 'cards.records.versions.get', method: 'GET', path: '/api/cards/:id/records/:name/versions/:version' }),
      expect.objectContaining({ operationId: 'cards.records.diff', method: 'GET', path: '/api/cards/:id/records/:name/diff' }),
      expect.objectContaining({ operationId: 'cards.history.list', method: 'GET', path: '/api/cards/:id/history' }),
      expect.objectContaining({ operationId: 'cards.history.get', method: 'GET', path: '/api/cards/:id/history/:version' }),
      expect.objectContaining({ operationId: 'cards.diff', method: 'GET', path: '/api/cards/:id/diff' }),
      expect.objectContaining({ operationId: 'agents.cardSessions', method: 'GET', path: '/api/cards/:id/agent-sessions' }),
    ]);
    expect(cardRoutes.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('keeps hierarchy, displayed detail, records, and history as distinct exact shapes', () => {
    expect(parseOperatorResponse('cards.get', 200, { card: canonicalCardDetail }).card).toEqual(canonicalCardDetail);
    expect(parseOperatorResponse('cards.children', 200, { parent: canonicalHierarchyCard, children: [] }).parent).toEqual(canonicalHierarchyCard);
    expect(parseOperatorResponse('cards.records.list', 200, { card_id:'project',records:canonicalRecordDescriptors }).records).toEqual(canonicalRecordDescriptors);
    const record = parseOperatorResponse('cards.records.get', 200, { card_id:'project',record:{name:'brief.md',head_version:1,head_entry_id:'11111111-1111-4111-8111-111111111111',state:'closed',accepted:{source_version:1,source_entry_id:'11111111-1111-4111-8111-111111111111',committed_at:canonicalCard.created_at,writer_agent:'runtime:bootstrap',card_version_seq:1,content:'Brief',content_sha256:'a'.repeat(64),size_bytes:5},draft:null,discarded:null,effective_content_source:'accepted'} }).record;
    expect(record.accepted?.content).toBe('Brief');
    for (const forbidden of ['children','depends_on','assigned_to','started_at','records','operator_summary']) expect(() => parseOperatorResponse('cards.get', 200, { card: { ...canonicalCardDetail, [forbidden]: null } })).toThrow();
    for (const forbidden of ['children','has_children','descendant_count']) expect(() => parseOperatorResponse('cards.children', 200, { parent: canonicalHierarchyCard, children: [{ ...canonicalHierarchyCard,id:'card-a',type:'code',[forbidden]:[] }] })).toThrow();
    expect(() => parseOperatorResponse('cards.children', 200, { parent: canonicalHierarchyCard, children: [{ ...canonicalHierarchyCard,id:'card-a',type:'code' },{ ...canonicalHierarchyCard,id:'card-a',type:'code' }] })).toThrow();
    expect(() => parseOperatorResponse('cards.records.list', 200, { card_id:'project',records:[...canonicalRecordDescriptors,...canonicalRecordDescriptors] })).toThrow();
    expect(() => parseOperatorResponse('cards.records.list', 200, { card_id:'project',records:[{...canonicalRecordDescriptors[0],writers:['analyst','analyst']}] })).toThrow();
    expect(() => parseOperatorResponse('cards.records.list', 200, { card_id:'project',records:[{...canonicalRecordDescriptors[0],bootstrap:false}] })).toThrow();
    const record404 = operatorApiContracts['cards.records.get'].response[404];
    for (const body of [
      {error:'Card not found',cardId:'project'},
      {error:'Card record definition not found',cardId:'project',name:'brief.md'},
      {error:'Card record not found',cardId:'project',name:'brief.md'},
    ]) expect(record404.parse(body)).toEqual(body);
    expect(() => record404.parse({error:'Card record not found',cardId:'project',name:'brief.md',extra:true})).toThrow();
    const entry = { card_id: 'project', version: 1, entry_id: '11111111-1111-4111-8111-111111111111', published_at: '2026-01-01T00:00:00.000Z', artifact: { kind: 'card-version', card: canonicalCard, change: null } } as const;
    expect((parseOperatorResponse('cards.history.get', 200, entry) as any).artifact.card).toEqual(canonicalCard);

    for (const key of canonicalCardKeys) {
      const incompleteSnapshot = { ...canonicalCard } as Record<string, unknown>;
      delete incompleteSnapshot[key];
      expect(() => parseOperatorResponse('cards.history.get', 200, { ...entry, artifact: { ...entry.artifact, card: incompleteSnapshot } })).toThrow();
    }
  });

  it('uses resulting-version metadata and rejects embedded prior-snapshot history rows', () => {
    const version = { entry_id: '11111111-1111-4111-8111-111111111111', version: 1, published_at: '2026-01-01T00:00:00.000Z', content_availability: 'unchecked', artifact_kind: 'card-version', change: null };
    expect((parseOperatorResponse('cards.history.list', 200, { card_id: 'project', versions: [version], total: 1 }) as any).versions[0]).toEqual(version);
    expect(() => parseOperatorResponse('cards.history.list', 200, { history: [{ ...version, version_seq: 1, snapshot: canonicalCard }], total: 1 })).toThrow();
  });

  it('uses one canonical positive safe integer wire grammar', () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER]) expect(positiveSafeIntegerSchema.parse(value)).toBe(value);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(positiveSafeIntegerSchema.safeParse(value).success).toBe(false);
    const accepted = ['1', String(Number.MAX_SAFE_INTEGER)];
    for (const raw of accepted) {
      expect(contractsModule.canonicalPositiveSafeIntegerStringSchema.parse(raw)).toBe(Number(raw));
      expect(contractsModule.CardHistoryEntryParamsSchema.parse({ id: 'project', version: raw }).version).toBe(Number(raw));
      expect(contractsModule.CardDiffQuerySchema.parse({ from: raw, to: raw })).toEqual({ from: Number(raw), to: Number(raw) });
    }
    for (const raw of ['', '0', '+1', '-1', '1.0', '1.5', '1suffix', ' 1', '1 ', '01', '1e2', '１', '9007199254740992']) {
      expect(contractsModule.canonicalPositiveSafeIntegerStringSchema.safeParse(raw).success).toBe(false);
      expect(contractsModule.CardHistoryEntryParamsSchema.safeParse({ id: 'project', version: raw }).success).toBe(false);
      expect(contractsModule.CardDiffQuerySchema.safeParse({ from: raw }).success).toBe(false);
      expect(contractsModule.CardDiffQuerySchema.safeParse({ to: raw }).success).toBe(false);
    }
    expect(contractsModule.CardDiffQuerySchema.parse({ from: '1', to: 'current' })).toEqual({ from: 1, to: 'current' });
  });

  it('keeps card, history-entry, and diff-source 404 contracts exact and disjoint', () => {
    const card = { error: 'Card not found', cardId: 'project' };
    const entry = { error: 'historical_version_not_found', resource: 'card', owner_id: 'project', version: 1 };
    const diff = { error: 'historical_version_not_found', resource: 'card', owner_id: 'project', version: 2 };
    expect(contractsModule.CardNotFoundErrorSchema.parse(card)).toEqual(card);
    expect(contractsModule.CardHistoryEntryNotFoundUnionSchema.parse(entry)).toEqual(entry);
    expect(contractsModule.CardDiffNotFoundUnionSchema.parse(diff)).toEqual(diff);
    expect(contractsModule.CardHistoryEntryNotFoundUnionSchema.parse(diff)).toEqual(diff);
    expect(contractsModule.CardDiffNotFoundUnionSchema.parse(entry)).toEqual(entry);
    for (const invalid of [{ error: 'Card not found' }, { ...card, message: 'missing' }, { error: 'anything', message: 'missing' }]) {
      expect(contractsModule.CardNotFoundErrorSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('uses the exact card-not-found contract for card Agent sessions', () => {
    const contract = operatorApiContracts['agents.cardSessions'];
    const body = { error: 'Card not found', cardId: 'project' };
    expect(contract.error).toBe(contractsModule.CardNotFoundErrorSchema);
    expect(contract.response[404]).toBe(contractsModule.CardNotFoundErrorSchema);
    expect(contract.response[404].parse(body)).toEqual(body);
    for (const invalid of [
      { error: 'missing' },
      { error: 'Card not found', cardId: 'project', message: 'missing' },
    ]) expect(contract.response[404].safeParse(invalid).success).toBe(false);
  });

  it('accepts only current availability component sources', () => {
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-application').success).toBe(true);
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-state').success).toBe(false);
  });

  it('labels provider availability as process-local and resettable', () => {
    expect(parseOperatorResponse('providers.list', 200, { availabilityScope: 'process_local_reset_on_restart', providers: {} }))
      .toEqual({ availabilityScope: 'process_local_reset_on_restart', providers: {} });
    expect(() => parseOperatorResponse('providers.list', 200, { providers: {} })).toThrow();
  });

  it('requires present event pagination parameters to be non-negative integer strings', () => {
    expect(EventsQuerySchema.safeParse({}).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '1', offset: '10' }).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});
