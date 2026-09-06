import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { CardService, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { DoctorResponseSchema, filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { appLogFile, cardNamespace } from '../../src/persistence/layout.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { createEventLog } from '../../src/observability/index.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../../src/contracts/publication-outcome.js';

describe('operator files and debug contract handlers', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  let cards: CardService;
  let cardServiceProvider: jest.Mock<() => CardService>;
  const authHeaders = { authorization: 'Bearer route-token' };

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-files-routes-'));
    initProjectTree(projectRoot);
    cards = new CardService(projectRoot);
    cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cardServiceProvider = jest.fn(() => cards);
    fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'route-token' }), eventLogger: createEventLog(projectRoot), fatalPort: testApplicationFatalPort }).mount(
      fastify,
      filesDebugOperatorApiContracts,
      buildFilesDebugOperatorContractHandlers({ projectRoot, cardServiceProvider, configAuthority: createTestConfigAuthority(projectRoot), workflows: TEST_RUNTIME_WORKFLOWS }),
    );
    await fastify.ready();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fastify.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('short-circuits authentication before CardService or Files work', async () => {
    const list = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards' });
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fcard.json' });

    expect(list.statusCode).toBe(401);
    expect(content.statusCode).toBe(401);
    expect(cardServiceProvider).not.toHaveBeenCalled();
  });

  it('declares exact status-local Files error structures', () => {
    const list = filesDebugOperatorApiContracts['files.list'].response;
    const content = filesDebugOperatorApiContracts['files.content'].response;
    const validation = { error: 'ValidationError', message: 'invalid query', issues: [{ path: 'path', message: 'Expected string' }] };
    const errorOnly = { error: 'Path cannot be resolved.' };
    const withPath = { error: 'File not found', path: 'missing.txt' };
    const tooLarge = { error: 'File exceeds maximum size.', path: 'large.txt', size: 2_000_000, maxSize: 1_048_576 };

    expect(list[400].parse(validation)).toEqual(validation);
    expect(list[400].parse(withPath)).toEqual(withPath);
    expect(list[403].parse(errorOnly)).toEqual(errorOnly);
    expect(list[404].parse(withPath)).toEqual(withPath);
    expect(content[400].parse(errorOnly)).toEqual(errorOnly);
    expect(content[400].parse(withPath)).toEqual(withPath);
    expect(content[403].parse(errorOnly)).toEqual(errorOnly);
    expect(content[403].parse(withPath)).toEqual(withPath);
    expect(content[404].parse(withPath)).toEqual(withPath);
    expect(content[413].parse(tooLarge)).toEqual(tooLarge);
    expect(content[415].parse(withPath)).toEqual(withPath);

    for (const schema of [list[400], list[403], list[404], content[400], content[403], content[404], content[413], content[415]]) {
      expect(schema.safeParse({ ...withPath, unexpected: true }).success).toBe(false);
    }
    expect(content[413].safeParse({ error: tooLarge.error, path: tooLarge.path, size: tooLarge.size }).success).toBe(false);
    expect(list[403].safeParse(withPath).success).toBe(false);
  });

  it('returns an exact empty Debug error projection when the log is missing', async () => {
    const errors = await fastify.inject({ method: 'GET', url: '/api/debug/errors', headers: authHeaders });
    expect(errors.statusCode).toBe(200);
    expect(errors.json()).toEqual({ errors: [], total: 0 });
  });

  it('registers Doctor and returns its exact ok projection', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/api/debug/doctor', headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: [{ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' }],
      issues: [],
    });
    expect(DoctorResponseSchema.parse(response.json())).toEqual(response.json());
  });

  it('authenticates Doctor before route work', async () => {
    cardServiceProvider.mockClear();
    const response = await fastify.inject({ method: 'GET', url: '/api/debug/doctor' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', statusCode: 401 });
    expect(cardServiceProvider).not.toHaveBeenCalled();
  });

  it('normalizes hostile Doctor authentication evaluation without route work', async () => {
    const authPolicy = new AuthPolicy();
    jest.spyOn(authPolicy, 'validateHttpRequest').mockImplementation(() => { throw new Error('hostile auth'); });
    const list = jest.fn();
    const { handler, request, reply } = mountedDoctorHandler({
      projectRoot,
      cardServiceProvider: () => ({ list } as unknown as CardService),
      authPolicy,
      fatalPort: testApplicationFatalPort,
    });

    await handler(request, reply.value);

    expect(list).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' });
    expect(request.log.error).toHaveBeenCalledWith(
      { operation: 'debug.doctor', failureCode: 'auth_evaluation_failed' },
      'Operator contract operation failed',
    );
  });

  it('accepts only the two coherent exact Doctor projections', () => {
    const failed = {
      status: 'issues_found',
      checks: [{ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' }],
      issues: [{ severity: 'error', message: 'Cards failed to load.' }],
    } as const;
    expect(DoctorResponseSchema.parse(failed)).toEqual(failed);
    for (const invalid of [
      { status: 'ok', checks: failed.checks, issues: [] },
      { status: 'ok', checks: [{ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' }], issues: failed.issues },
      { ...failed, unexpected: true },
      { ...failed, issues: [] },
    ]) expect(DoctorResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('keeps an ordinary Doctor list failure as one safe diagnostic and exact issues_found response', async () => {
    const marker = 'hostile-doctor-list';
    const list = jest.fn(() => { throw new Error(marker); });
    const { handler, request, reply } = mountedDoctorHandler({
      projectRoot,
      cardServiceProvider: () => ({ list } as unknown as CardService),
      authPolicy: new AuthPolicy(),
      fatalPort: testApplicationFatalPort,
    });

    await handler(request, reply.value);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      status: 'issues_found',
      checks: [{ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' }],
      issues: [{ severity: 'error', message: 'Cards failed to load.' }],
    });
    expect(request.log.error).toHaveBeenCalledTimes(1);
    expect(request.log.error).toHaveBeenCalledWith(
      { operation: 'debug.doctor', failureCode: 'cards_load_failed' },
      'Operator Doctor card check failed',
    );
    expect(JSON.stringify(request.log.error.mock.calls)).not.toContain(marker);
  });

  it('delivers the same publication-unknown Doctor failure to the fatal port without response or ordinary diagnostics', async () => {
    const publicationError = new PublicationOutcomeUnknownError();
    const sentinel = new Error('fatal sentinel');
    const publicationOutcomeUnknown = jest.fn((_error: PublicationOutcomeUnknownError): never => { throw sentinel; });
    const { handler, request, reply, appendEventPrepared } = mountedDoctorHandler({
      projectRoot,
      cardServiceProvider: () => ({ list: () => { throw publicationError; } } as unknown as CardService),
      authPolicy: new AuthPolicy(),
      fatalPort: { publicationOutcomeUnknown } satisfies ApplicationFatalPort,
    });

    await expect(handler(request, reply.value)).rejects.toBe(sentinel);
    expect(publicationOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(publicationOutcomeUnknown).toHaveBeenCalledWith(publicationError);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect(request.log.error).not.toHaveBeenCalled();
    expect(appendEventPrepared).not.toHaveBeenCalled();
  });

  it('normalizes a Doctor outer failure once through ContractRuntime', async () => {
    const { handler, request, reply } = mountedDoctorHandler({
      projectRoot,
      cardServiceProvider: () => ({ list: () => { throw new Error('inner'); } } as unknown as CardService),
      authPolicy: new AuthPolicy(),
      fatalPort: testApplicationFatalPort,
    });
    request.log.error.mockImplementationOnce(() => { throw new Error('outer'); });

    await handler(request, reply.value);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' });
    expect(request.log.error).toHaveBeenCalledTimes(2);
    expect(request.log.error.mock.calls[1]?.[0]).toEqual({ operation: 'debug.doctor', failureCode: 'handler_failed' });
  });

  it('fails a malformed Doctor handler projection through response-contract validation', async () => {
    const { handler, request, reply, appendEventPrepared } = mountedDoctorHandler({
      projectRoot,
      cardServiceProvider: () => cards,
      authPolicy: new AuthPolicy(),
      fatalPort: testApplicationFatalPort,
      doctorHandler: () => ({ body: { status: 'ok', checks: [], issues: [] } }),
    });

    await handler(request, reply.value);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' });
    expect(appendEventPrepared).toHaveBeenCalledTimes(1);
    expect((appendEventPrepared.mock.calls[0]?.[0] as () => unknown)()).toEqual(expect.objectContaining({
      kind: 'runtime_actionable_error',
      actionable_error: expect.objectContaining({ code: 'contract_response_violation' }),
    }));
  });

  it('authenticates and returns the strict non-disclosing startup graph projection', async () => {
    const unauthorized = await fastify.inject({ method: 'GET', url: '/api/debug/graphs' });
    expect(unauthorized.statusCode).toBe(401);
    const response = await fastify.inject({ method: 'GET', url: '/api/debug/graphs', headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.graphs).toHaveLength(9);
    expect(body.graphs.map((graph: { card_type: string }) => graph.card_type)).toEqual(['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
    expect(body.graphs[0]).toEqual(expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ entry: 'STOPPED', node_id: 'recover' })]), terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }] }));
    expect(body.graphs[0].nodes[0].model.candidates[0]).toEqual({ provider: 'test', model: 'test-model' });
    const keys = (value: unknown): string[] => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]) : [];
    expect(keys(body)).not.toEqual(expect.arrayContaining(['account', 'text', 'path']));
    expect(JSON.stringify(body)).not.toMatch(/\.saivage|contractDescription/i);
  });

  it('returns exact canonical error events in physical order', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const first = { id: 'event-1', timestamp, kind: 'runtime_diagnostic' as const, card_id: 'card-a', error_message: 'first' };
    const second = { id: 'event-2', timestamp: '2026-01-01T00:00:01.000Z', kind: 'mcp_tool_invocation' as const, server: 'tools', tool: 'inspect', success: false, duration_ms: 4, error: 'second' };
    appendAppLogEntry(projectRoot, 'event', () => ({ type: 'event', data: first }));
    appendAppLogEntry(projectRoot, 'event', () => ({ type: 'event', data: second }));

    const errors = await fastify.inject({ method: 'GET', url: '/api/debug/errors', headers: authHeaders });
    expect(errors.statusCode).toBe(200);
    expect(errors.json()).toEqual({ errors: [first, second], total: 2 });
  });

  it('fails each explicit Debug read on a complete malformed app-log row without changing bytes', async () => {
    const path = appLogFile(projectRoot);
    const malformed = '{"version":1,"type":"app_log","rows":[{"complete":"invalid"}]}\n';
    const timestamp = '2026-01-01T00:00:00.000Z';
    appendAppLogEntry(projectRoot, 'event', () => ({ type: 'event', data: { id: 'event-before-malformed', timestamp, kind: 'runtime_diagnostic', error_message: 'before' } }));
    writeFileSync(path, malformed, 'utf8');
    for (const url of ['/api/debug/errors']) {
      const response = await fastify.inject({ method: 'GET', url, headers: authHeaders });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(readFileSync(path, 'utf8')).toBe(malformed);
    }
  });

  it('navigates from the generic metadata root through the canonical virtual card subtree', async () => {
    const request = async (path: string) => fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: authHeaders });
    const root = await request('.');
    const metadata = await request('.saivage');
    const cardsRoot = await request('.saivage/cards');
    const project = await request('.saivage/cards/project');
    const children = await request('.saivage/cards/project/children');
    const leafChildren = await request('.saivage/cards/project/children/a/children');

    for (const response of [root, metadata, cardsRoot, project, children, leafChildren]) expect(response.statusCode).toBe(200);
    expect(metadata.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: cards.read('project')!.updated_at }),
    ]));
    expect(cardsRoot.json()).toEqual({ path: '.saivage/cards', files: [expect.objectContaining({ name: 'project', path: '.saivage/cards/project' })] });
    expect(project.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'children', path: '.saivage/cards/project/children', type: 'directory' }),
      expect.objectContaining({ name: 'card.json', path: '.saivage/cards/project/card.json', type: 'file' }),
    ]));
    expect(children.json().files).toEqual([expect.objectContaining({ name: 'a', path: '.saivage/cards/project/children/a' })]);
    expect(leafChildren.json()).toEqual({ path: '.saivage/cards/project/children/a/children', files: [] });
  });

  it('returns declared content and opaque reserved-path envelopes', async () => {
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fbrief.md', headers: authHeaders });
    const malformedLayout = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards%2Fproject%2Fconversations', headers: authHeaders });
    const aliasSpelling = await fastify.inject({ method: 'GET', url: '/api/files?path=.%2F.saivage%2Fcards', headers: authHeaders });

    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual(expect.objectContaining({ path: '.saivage/cards/project/brief.md', contentType: 'text/markdown', redacted: true, modifiedAt: expect.any(String) }));
    expect(malformedLayout.statusCode).toBe(404);
    expect(malformedLayout.json()).toEqual({ error: 'Path not found', path: '.saivage/cards/project/conversations' });
    expect(aliasSpelling.statusCode).toBe(404);
    expect(aliasSpelling.json()).toEqual({ error: 'Path not found', path: './.saivage/cards' });
  });

  it('wraps semantic current and explicit card-version documents without exposing physical layout', async () => {
    const current = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent('.saivage/cards/project/card.json')}`, headers: authHeaders });
    const historical = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent('.saivage/cards/project/card.json?v=1')}`, headers: authHeaders });
    for (const [response,version] of [[current,2],[historical,1]] as const) {
      expect(response.statusCode).toBe(200); const body=response.json(); const document=JSON.parse(body.content);
      expect(body).toMatchObject({contentType:'application/json',redacted:true,sensitivity:'sensitive-redacted',version});
      expect(document).toMatchObject({format_version:2,kind:'card-version',card_id:'project',version});
      expect(document.card).toMatchObject({ child_membership: expect.any(Array), active_child_order: expect.any(Array) });
      expect(document.card).not.toHaveProperty('children');
      expect(body.content.endsWith('\n')).toBe(true); expect(body.content).not.toContain('filename');
    }
  });

  it('lists and reads adjacent-dot filenames while rejecting exact parent segments', async () => {
    mkdirSync(join(projectRoot, 'docs'));
    writeFileSync(join(projectRoot, 'docs', 'v1..v2.md'), 'adjacent dots\n', 'utf8');

    const listing = await fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent('docs')}`, headers: authHeaders });
    const content = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent('docs/v1..v2.md')}`, headers: authHeaders });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'v1..v2.md', path: 'docs/v1..v2.md', type: 'file' }),
    ]));
    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual(expect.objectContaining({ path: 'docs/v1..v2.md', content: 'adjacent dots\n' }));

    for (const path of ['..', '../x', 'a/../b']) {
      for (const endpoint of ['/api/files', '/api/files/content']) {
        const response = await fastify.inject({ method: 'GET', url: `${endpoint}?path=${encodeURIComponent(path)}`, headers: authHeaders });
        expect(response.statusCode).toBe(403);
      }
    }
  });

  it('ignores a noncanonical legacy record file in listing and explicit semantic reads', async () => {
    writeFileSync(join(cardNamespace(projectRoot, 'project'), 'status.jsonl'), 'complete malformed envelope\n', 'utf8');
    const listing = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards%2Fproject', headers: authHeaders });
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fstatus.md', headers: authHeaders });

    expect(listing.statusCode).toBe(200);
    expect(listing.json().files).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'status.md', type: 'file' })]));
    expect(content.statusCode).toBe(404);
  });

  it('keeps project and work card aliases opaque while lexical blocked aliases retain 403 and omission', async () => {
    const cardsRoot = join(projectRoot, '.saivage', 'cards');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'saivage.json'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'work', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'work', '.env'), 'dir');

    const request = async (path: string) => fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: authHeaders });
    expect((await request('.saivage/card-alias')).statusCode).toBe(404);
    expect((await request('work:///card-alias')).statusCode).toBe(404);
    expect((await request('.saivage/saivage.json')).statusCode).toBe(403);
    expect((await request('work:///.env')).statusCode).toBe(403);
    expect(cardServiceProvider).not.toHaveBeenCalled();

    const metadataNames = (await request('.saivage')).json().files.map(({ name }: { name: string }) => name);
    expect(metadataNames).toContain('cards');
    expect(metadataNames).not.toContain('card-alias');
    expect(metadataNames).not.toContain('saivage.json');
    const workNames = (await request('.saivage/work')).json().files.map(({ name }: { name: string }) => name);
    expect(workNames).not.toContain('card-alias');
    expect(workNames).not.toContain('.env');
    expect(cardServiceProvider).toHaveBeenCalledTimes(1);
  });
});

function mountedDoctorHandler(options: {
  projectRoot: string;
  cardServiceProvider: () => CardService;
  authPolicy: AuthPolicy;
  fatalPort: ApplicationFatalPort;
  doctorHandler?: () => { body: unknown };
}) {
  let handler: ((request: unknown, reply: FastifyReply) => Promise<unknown>) | undefined;
  const fastify = {
    route: (route: { url: string; handler: unknown }) => {
      if (route.url === '/api/debug/doctor') handler = route.handler as typeof handler;
    },
  } as unknown as FastifyInstance;
  const appendEventPrepared = jest.fn();
  const handlers = {
    ...buildFilesDebugOperatorContractHandlers({
      projectRoot: options.projectRoot,
      cardServiceProvider: options.cardServiceProvider,
      configAuthority: createTestConfigAuthority(options.projectRoot),
      workflows: TEST_RUNTIME_WORKFLOWS,
    }),
    ...(options.doctorHandler ? { 'debug.doctor': options.doctorHandler } : {}),
  };
  new ContractRuntime({ authPolicy: options.authPolicy, eventLogger: { appendEventPrepared } as never, fatalPort: options.fatalPort }).mount(
    fastify,
    filesDebugOperatorApiContracts,
    handlers as never,
  );
  if (!handler) throw new Error('Doctor contract handler was not mounted.');
  const send = jest.fn();
  const status = jest.fn(() => ({ send }));
  const reply = { value: { status, send, raw: { once: jest.fn() }, header: jest.fn() } as unknown as FastifyReply, status, send };
  const request = { params: {}, query: {}, body: {}, headers: {}, log: { error: jest.fn() } };
  return { handler, request, reply, appendEventPrepared };
}
