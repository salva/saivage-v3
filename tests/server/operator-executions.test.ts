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
import Fastify, { type FastifyInstance } from 'fastify';
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
    root = mkdtempSync('/home/salva/g/ml/tmp/execution-api-');
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
    writeFileSync(join(root, 'huge.txt'), 'x'.repeat(1_048_577));
    writeFileSync(join(root, 'binary.txt'), Buffer.from([0, 1, 2]));
    const s = start();
    const f = finish(s, [
      '.env',
      '.saivage/repair-attic/fixture/private.txt',
      'alias.txt',
      'huge.txt',
      'binary.txt',
    ]);
    appendCardExecutions(root, 'project', [s, f]);
    for (const [ordinal, expected] of [
      [0, 403],
      [1, 403],
      [2, 403],
      [3, 413],
      [4, 415],
    ]) {
      for (const suffix of ['', '/download']) {
        const result = await get(`/${s.invocation_id}/files/${f.row_id}:${ordinal}${suffix}`);
        expect(result.statusCode).toBe(expected);
        expect(result.body).not.toMatch(/ATTIC-PRIVATE|private.txt|\.env/u);
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
