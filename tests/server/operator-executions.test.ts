import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  CardService,
  TEST_RUNTIME_WORKFLOWS,
  initProjectTree,
} from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { executionOperatorApiContracts } from '../../src/contracts/operator-api-executions.js';
import { filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { createEventLog } from '../../src/observability/index.js';
import {
  appendCardExecutions,
  type CardExecutionStart,
  type CardExecutionFinish,
} from '../../src/persistence/card-execution-log.js';
import { cardExecutionFile } from '../../src/persistence/layout.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { parseOperatorResponse } from '../../src/contracts/index.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import {
  invokeObservationPlugin,
  observationCanaries,
  observationInputs,
  observationOutputs,
} from '../helpers/execution-observation-fixture.js';

describe('exact authenticated execution evidence APIs', () => {
  let root: string;
  let server: FastifyInstance;
  let cards: CardService;
  const headers = { authorization: 'Bearer fixture-token' };
  const start = (): CardExecutionStart => ({
    kind: 'invocation_started',
    row_id: randomUUID(),
    invocation_id: randomUUID(),
    card_id: 'project',
    timestamp: new Date().toISOString(),
    operation: 'shell.run',
    contract_version: 1,
    provider: { kind: 'builtin', name: 'shell' },
    binding: { kind: 'node', activation_id: randomUUID(), node_id: 'check', ordinal: 2 },
    input: [],
    config: [{ name: 'private', type: 'string', value: 'PRIVATE-CONFIG-MARKER' }],
    shell: { script: 'printf "safe"', cwd: '.', argv: [], env: { PRIVATE: 'PRIVATE-ENV-MARKER' } },
  });
  const finish = (s: CardExecutionStart, paths: string[]): CardExecutionFinish => ({
    kind: 'invocation_finished',
    row_id: randomUUID(),
    invocation_id: s.invocation_id,
    card_id: s.card_id,
    timestamp: new Date().toISOString(),
    disposition: 'returned',
    summary: 'Observed',
    leader_exit: null,
    leader_error: null,
    interruption: null,
    timeout_reason: null,
    process: null,
    outcome: 'passed',
    values: [{ name: 'exit_code', type: 'integer', value: 0 }],
    files: paths.map((path) => ({
      kind: 'artifact',
      path,
      observed_at: new Date().toISOString(),
      size: 10,
      source: 'current',
    })),
    absent_artifacts: ['absent.txt'],
    external_effects: 'unknown',
  });
  const get = (path = '', authorized = true) =>
    server.inject({
      method: 'GET',
      url: `/api/cards/project/executions${path}`,
      headers: authorized ? headers : {},
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'execution-api-'));
    initProjectTree(root);
    cards = new CardService(root);
    server = Fastify({ logger: false });
    new ContractRuntime({
      authPolicy: new AuthPolicy({ apiToken: 'fixture-token' }),
      eventLogger: createEventLog(root),
      fatalPort: testApplicationFatalPort,
    }).mount(
      server,
      {
        ...executionOperatorApiContracts,
        'files.content': filesDebugOperatorApiContracts['files.content'],
      },
      buildFilesDebugOperatorContractHandlers({
        projectRoot: root,
        cardServiceProvider: () => cards,
        configAuthority: createTestConfigAuthority(root),
        workflows: TEST_RUNTIME_WORKFLOWS,
      }),
    );
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['input', 'values'] as const)(
    'neutralizes secret-named compiled plugin %s at the authenticated route, not in raw facts',
    async (side) => {
      const { invocation, received, selected } = await invokeObservationPlugin(root);
      expect(received).toEqual([observationInputs]);
      expect(invocation.result.values).toEqual(observationOutputs);
      expect(selected.routeId).toBe('original-secret-value');
      expect(selected.result.values).toEqual(observationOutputs);
      const path = cardExecutionFile(root, 'project');
      const bytes = readFileSync(path);
      const raw = readCardExecutions(root, 'project');
      expect(raw.map((row) => row.kind)).toEqual(['invocation_started', 'invocation_finished']);
      const input = raw[0];
      const output = raw[1];
      if (input?.kind !== 'invocation_started' || output?.kind !== 'invocation_finished')
        throw new Error('Expected real invocation evidence.');
      expect(Object.fromEntries(input.input.map(({ name, value }) => [name, value]))).toEqual(observationInputs);
      expect(Object.fromEntries(output.values.map(({ name, value }) => [name, value]))).toEqual(observationOutputs);
      expect(input.input.map(({ type }) => type)).toEqual([
        'string', 'strings', 'integer', 'boolean', 'strings', 'string',
        'strings', 'integer', 'boolean', 'strings', 'string', 'strings',
      ]);
      expect(output.values.map(({ type }) => type)).toEqual(input.input.map(({ type }) => type));
      for (const canary of [...observationCanaries.input, ...observationCanaries.output])
        expect(bytes.toString()).toContain(canary);
      expect((await get(`/${invocation.invocationId}`, false)).statusCode).toBe(401);
      const response = await get(`/${invocation.invocationId}`);
      expect(response.statusCode).toBe(200);
      const detail = parseOperatorResponse('cards.executions.get', 200, response.json());
      // The outbound read must not rewrite or neutralize canonical evidence or internal values.
      expect(readFileSync(path)).toEqual(bytes);
      expect(readCardExecutions(root, 'project')).toEqual(raw);
      expect(received).toEqual([observationInputs]);
      expect(detail).toMatchObject({ disposition: 'returned', outcome: 'observed', shell: null });
      expect(response.body).not.toMatch(/PRIVATE-OBSERVATION-CONFIG|"config"|"env"/u);
      const original = side === 'input' ? observationInputs : observationOutputs;
      expect(detail[side]).toEqual([
        { name: 'api_token', type: 'string', value: '[REDACTED]' },
        { name: 'access_token', type: 'strings', value: ['[REDACTED]', '[REDACTED]'] },
        { name: 'count_secret', type: 'integer', value: 0 },
        { name: 'enabled_secret', type: 'boolean', value: false },
        { name: 'empty_secret', type: 'strings', value: [] },
        { name: 'label', type: 'string', value: original.label },
        { name: 'labels', type: 'strings', value: original.labels },
        { name: 'count', type: 'integer', value: original.count },
        { name: 'enabled', type: 'boolean', value: original.enabled },
        { name: 'empty', type: 'strings', value: [] },
        { name: 'note', type: 'string', value: redactTextForOutbound(original.note) },
        { name: 'notes', type: 'strings', value: original.notes.map(redactTextForOutbound) },
      ]);
      for (const canary of [...observationCanaries.input, ...observationCanaries.output])
        expect(response.body).not.toContain(canary);
      expect(response.body).not.toContain('ordinary-input-text-canary');
      expect(response.body).not.toContain('ordinary-output-list-canary');
    },
  );

  it('authenticates before consuming even malformed canonical evidence, including downloads', async () => {
    writeFileSync(cardExecutionFile(root, 'project'), 'MALFORMED\n');
    const id = randomUUID();
    for (const path of [
      '',
      `/${id}`,
      `/${id}/files/${randomUUID()}:0`,
      `/${id}/files/${randomUUID()}:0/download`,
    ])
      expect((await get(path, false)).statusCode).toBe(401);
  });

  it('keeps ordinary outbound filtering on known list/detail text fields and preserves identities', async () => {
    const text = 'api_key: known-field-canary';
    const projected = redactTextForOutbound(text);
    const s = start();
    s.provider.name = text;
    s.binding = { kind: 'node', activation_id: randomUUID(), node_id: text, ordinal: 0 };
    s.shell = { script: text, cwd: text, argv: [text], env: { PRIVATE: 'PRIVATE-ENV-MARKER' } };
    const f = finish(s, [text]);
    f.summary = text;
    f.leader_exit = { exit_code: 3, signal: text, observed_at: f.timestamp };
    f.leader_error = { diagnostic: text, observed_at: f.timestamp };
    f.interruption = text;
    f.timeout_reason = text;
    f.process = {
      id: randomUUID(), group: 'absent', group_diagnostic: text,
      stdout: 'eof', stderr: 'eof', stdout_error: text, stderr_error: text,
    };
    f.absent_artifacts = [text];
    appendCardExecutions(root, 'project', [s, f]);
    const bytes = readFileSync(cardExecutionFile(root, 'project'));
    const response = await get(`/${s.invocation_id}`);
    expect(response.statusCode).toBe(200);
    const detail = parseOperatorResponse('cards.executions.get', 200, response.json());
    expect(detail).toMatchObject({
      invocation_id: s.invocation_id,
      provider: { kind: 'builtin', name: projected },
      binding: { ...s.binding, node_id: projected },
      started_at: s.timestamp, finished_at: f.timestamp,
      shell: { script: projected, cwd: projected, argv: [projected] },
      summary: projected,
      leader_exit: { ...f.leader_exit, signal: projected },
      leader_error: { ...f.leader_error, diagnostic: projected },
      interruption: projected, timeout_reason: projected,
      process: { ...f.process, group_diagnostic: projected, stdout_error: projected, stderr_error: projected },
      files: [{ key: `${f.row_id}:0`, label: projected, source: 'current' }],
      absent_artifacts: [projected],
    });
    const listResponse = await get();
    const list = parseOperatorResponse('cards.executions.list', 200, listResponse.json());
    expect(list.rows.map((row) => row.binding)).toEqual([
      { ...s.binding, node_id: projected }, { ...s.binding, node_id: projected },
    ]);
    expect(response.body + listResponse.body).not.toMatch(/known-field-canary|PRIVATE-/u);
    expect(readFileSync(cardExecutionFile(root, 'project'))).toEqual(bytes);
  });

  it('keeps lazy absence and incomplete evidence distinct, paginates by exact row, redacts private configuration', async () => {
    expect((await get()).json()).toEqual({ rows: [], next_cursor: null });
    expect(existsSync(cardExecutionFile(root, 'project'))).toBe(false);
    const first = start();
    const second = start();
    appendCardExecutions(root, 'project', [first, second, finish(second, [])]);
    const page = await get('?limit=1');
    expect(page.statusCode).toBe(200);
    expect(page.json().rows.map((row: any) => row.row_id)).toEqual([first.row_id]);
    expect(page.json().next_cursor).toBe(first.row_id);
    const next = await get(`?after=${first.row_id}`);
    expect(next.json().rows).toHaveLength(2);
    expect(next.json().next_cursor).toBeNull();
    const detail = await get(`/${first.invocation_id}`);
    expect(detail.json()).toMatchObject({
      completion: 'no completion retained; effects unknown',
      disposition: null,
      finished_at: null,
      shell: { script: 'printf "safe"' },
    });
    expect(detail.body).not.toMatch(/PRIVATE-|"env"|"config"|"running"/u);
    const rawLog = await server.inject({
      method: 'GET',
      url: `/api/files/content?path=${encodeURIComponent(relative(root, cardExecutionFile(root, 'project')))}`,
      headers,
    });
    expect(rawLog.statusCode).toBe(404);
    expect(rawLog.body).not.toMatch(/PRIVATE-|"env"|"config"/u);
    expect((await get(`?after=${randomUUID()}`)).statusCode).toBe(400);
    expect((await get('?limit=101')).statusCode).toBe(400);
    expect((await get(`/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('?path=secret')).statusCode).toBe(400);
  });

  it('strictly consumes the whole log for list/detail/files; only identifiable torn suffix is truncated', async () => {
    const first = start();
    const closing = finish(first, ['safe.txt']);
    appendCardExecutions(root, 'project', [first, closing]);
    const path = cardExecutionFile(root, 'project');
    const prefix = readFileSync(path);
    appendFileSync(path, 'torn');
    expect((await get(`/${first.invocation_id}`)).statusCode).toBe(200);
    expect(readFileSync(path)).toEqual(prefix);
    appendFileSync(
      path,
      `${JSON.stringify({ version: 1, type: 'card-execution', rows: [{ ...closing, row_id: randomUUID() }] })}\npartial`,
    );
    const corrupt = readFileSync(path);
    for (const suffix of [
      '?limit=1',
      `/${first.invocation_id}`,
      `/${first.invocation_id}/files/${closing.row_id}:0`,
    ]) {
      const result = await get(suffix);
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({
        error: 'InternalServerError',
        message: 'Internal server error',
      });
    }
    expect(readFileSync(path)).toEqual(corrupt);
  });

  it('selects only exact logged row/reference ordinals, uses current mutable source and redacts preview and download', async () => {
    writeFileSync(
      join(root, 'safe.txt'),
      'safe output\nAuthorization: Bearer fixture-secret-token-123456789\n',
    );
    const s = start();
    const f = finish(s, ['safe.txt', 'gone.txt']);
    appendCardExecutions(root, 'project', [s, f]);
    const detail = (await get(`/${s.invocation_id}`)).json();
    expect(detail.files).toHaveLength(2);
    expect(detail.files[0]).toMatchObject({ key: `${f.row_id}:0`, source: 'current' });
    expect(detail.absent_artifacts).toEqual(['absent.txt']);
    expect(detail.files.some((file: any) => file.label === 'absent.txt')).toBe(false);
    for (const suffix of ['', '/download']) {
      const response = await get(`/${s.invocation_id}/files/${f.row_id}:0${suffix}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('safe output');
      expect(response.body).not.toContain('fixture-secret-token');
      if (suffix) expect(response.headers['content-disposition']).toContain('attachment');
    }
    writeFileSync(join(root, 'safe.txt'), 'new current source');
    expect((await get(`/${s.invocation_id}/files/${f.row_id}:0`)).json().content).toBe(
      'new current source',
    );
    expect((await get(`/${s.invocation_id}/files/${f.row_id}:1`)).statusCode).toBe(404);
    expect((await get(`/${s.invocation_id}/files/${f.row_id}:2`)).statusCode).toBe(404);
    expect((await get(`/${randomUUID()}/files/${f.row_id}:0`)).statusCode).toBe(404);
    expect((await get(`/${s.invocation_id}/files/${randomUUID()}:0`)).statusCode).toBe(404);
  });

  it('refuses blocked secret and attic aliases before content and returns safe errors, with bounded text only', async () => {
    mkdirSync(join(root, '.saivage/repair-attic/fixture'), { recursive: true });
    writeFileSync(join(root, '.saivage/repair-attic/fixture/private.txt'), 'ATTIC-PRIVATE');
    symlinkSync(join(root, '.saivage/repair-attic/fixture/private.txt'), join(root, 'alias.txt'));
    const cases = [
      { path: '.env', status: 403 },
      { path: '.saivage/repair-attic/fixture/private.txt', status: 403 },
      { path: 'alias.txt', status: 403 },
      { path: 'huge.txt', status: 413, bytes: Buffer.alloc(1_048_577, 0x61) },
      { path: 'binary.txt', status: 415, bytes: Buffer.from([0xff, 0xfe, 0x01, 0x02]) },
      { path: 'nul.txt', status: 415, bytes: Buffer.from(`${'a'.repeat(4096)}\u0000`) },
      {
        path: 'malformed.txt',
        status: 415,
        bytes: Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0x80])]),
      },
      {
        path: 'raster.png',
        status: 415,
        bytes: await sharp({
          create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
        })
          .png()
          .toBuffer(),
      },
    ];
    for (const testCase of cases) {
      if (testCase.bytes) writeFileSync(join(root, testCase.path), testCase.bytes);
    }
    const s = start();
    const f = finish(s, cases.map(({ path }) => path));
    appendCardExecutions(root, 'project', [s, f]);
    for (const [ordinal, testCase] of cases.entries()) {
      for (const suffix of ['', '/download']) {
        const result = await get(`/${s.invocation_id}/files/${f.row_id}:${ordinal}${suffix}`);
        expect(result.statusCode).toBe(testCase.status);
        expect(result.body).not.toMatch(/ATTIC-PRIVATE|private.txt|\.env/u);
        expect(result.body).not.toContain(testCase.path);
        expect(result.body).not.toContain(root);
      }
    }
  });

  it('does not consume evidence in an unlinked child namespace', async () => {
    const path = cardExecutionFile(root, 'card-z');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'private malformed\n');
    expect(
      (await server.inject({ method: 'GET', url: '/api/cards/card-z/executions', headers }))
        .statusCode,
    ).toBe(404);
    expect(readFileSync(path, 'utf8')).toBe('private malformed\n');
  });

  it('retains supported exact tombstoned card evidence without opening unlinked descendants', async () => {
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Disposable execution',
      bootstrap_content: 'Finite fixture',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const s = { ...start(), card_id: child.id };
    appendCardExecutions(root, child.id, [s]);
    cards.deleteSubtrees([child.id], () => true, 'analyst');
    const response = await server.inject({
      method: 'GET',
      url: `/api/cards/${child.id}/executions/${s.invocation_id}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().completion).toBe('no completion retained; effects unknown');
  });
});
