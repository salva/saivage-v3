import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activeOperatorDocPaths,
  extractImplementedRoutes,
  verifyAgentToolDocs,
  verifyConfigDocs,
  verifyDocRoutes,
  verifyDocSourceContracts,
  verifyRuntimeControlDocs,
} from '../scripts/verify-doc-routes.js';

const projectRoot = process.cwd();

function withFixtureProject(docContent: string, fn: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'saivage-doc-routes-'));
  try {
    mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'docs', 'operation.md'), docContent);
    fn(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function withRuntimeControlFixture(serverSource: string, routesSource: string, fn: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-docs-'));
  try {
    mkdirSync(join(fixtureRoot, 'src', 'server', 'routes'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'src', 'server', 'server.ts'), serverSource);
    writeFileSync(join(fixtureRoot, 'src', 'server', 'routes', 'runtime-config-notes.ts'), routesSource);
    fn(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('operator-facing documentation source-contract verification', () => {
  it('passes for the current active docs and source contract tables', () => {
    const result = verifyDocSourceContracts({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.routeResult.documentedRoutes.map((mention) => mention.key)).toContain('GET /health');
    expect(result.routeResult.implementedRoutes.has('POST /api/runtime/dispatch')).toBe(false);
  });

  it('checks all existing current markdown docs from the documentation inventory', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'saivage-doc-routes-inventory-'));
    try {
      mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'docs', 'operation.md'), 'Current guide: `GET /health`.\n');
      writeFileSync(join(fixtureRoot, 'docs', 'agents.md'), 'Bad current reference outside the old subset: `POST /api/runtime/dispatch`.\n');
      writeFileSync(join(fixtureRoot, 'docs', 'historical.md'), 'Historical stale route: `POST /api/runtime/dispatch`.\n');
      writeFileSync(join(fixtureRoot, 'README.md'), 'Root current readme.\n');
      writeFileSync(join(fixtureRoot, 'docs', 'documentation-inventory.md'), [
        '# Documentation inventory',
        '',
        '| Path | Classification | Rationale |',
        '|---|---|---|',
        '| `docs/operation.md` | current | Current operator guide. |',
        '| `docs/agents.md` | current | Current architecture guide outside the old operator subset. |',
        '| `README.md` | current | Current root readme. |',
        '| `docs/.vitepress/config.ts` | current | Non-markdown docs config. |',
        '| `docs/historical.md` | historical | Historical only. |',
        '| `missing-current.md` | current | Missing path should not be scanned. |',
        '',
      ].join('\n'));

      const checkedDocs = activeOperatorDocPaths(fixtureRoot);
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        implementedRoutes: extractImplementedRoutes(projectRoot),
        routeInventoryRows: Array.from(extractImplementedRoutes(projectRoot)).map((key) => ({
          key,
          anchor: 'src/server/server.ts:1',
        })),
      });

      expect(checkedDocs).toEqual(['docs/operation.md', 'docs/agents.md', 'README.md']);
      expect(result.ok).toBe(false);
      expect(result.checkedDocs).toEqual(checkedDocs);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'removed-route',
          route: 'POST /api/runtime/dispatch',
          file: 'docs/agents.md',
        }),
      ]));
      expect(result.failures).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ file: 'docs/historical.md' }),
      ]));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('passes for a known-good fixture that references implemented routes', () => {
    withFixtureProject('Use `GET /health` and `POST /api/runtime/pause` for operator checks.\n', (fixtureRoot) => {
      const implementedRoutes = new Set(['GET /health', 'POST /api/runtime/pause']);
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes,
        routeInventoryRows: [
          { key: 'GET /health', anchor: 'docs/operation.md:1' },
          { key: 'POST /api/runtime/pause', anchor: 'docs/operation.md:1' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });



  it('accepts an operator route inventory row with a context-quoted source anchor', () => {
    withFixtureProject('Use `GET /api/example` for the fixture route.\n', (fixtureRoot) => {
      mkdirSync(join(fixtureRoot, 'src', 'server', 'routes'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'src', 'server', 'routes', 'example.ts'), "fastify.get('/api/example', async () => ({ ok: true }));\n");

      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /api/example']),
        routeInventoryRows: [
          { key: 'GET /api/example', anchor: 'src/server/routes/example.ts:1 "fastify.get(\'/api/example\'"' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('fails when a route inventory context-quoted anchor points near stale source text', () => {
    withFixtureProject('Use `GET /api/example` for the fixture route.\n', (fixtureRoot) => {
      mkdirSync(join(fixtureRoot, 'src', 'server', 'routes'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'src', 'server', 'routes', 'example.ts'), "fastify.get('/api/example', async () => ({ ok: true }));\n");

      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /api/example']),
        routeInventoryRows: [
          { key: 'GET /api/example', anchor: 'src/server/routes/example.ts:1 "fastify.post(\'/api/example\'"' },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'anchor-source-mismatch' }),
      ]));
    });
  });

  it('fails when a route inventory context-quoted anchor points to a missing source file', () => {
    withFixtureProject('Use `GET /api/example` for the fixture route.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /api/example']),
        routeInventoryRows: [
          { key: 'GET /api/example', anchor: 'src/server/routes/missing-example.ts:1 "fastify.get(\'/api/example\'"' },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'bad-anchor' }),
      ]));
    });
  });

  it('fails for a synthetic fixture that references an unimplemented route', () => {
    withFixtureProject('Future guidance: `POST /api/runtime/not-a-real-route` should do work.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /health']),
        routeInventoryRows: [{ key: 'GET /health', anchor: 'docs/operation.md:1' }],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'missing-route', route: 'POST /api/runtime/not-a-real-route' }),
      ]));
    });
  });

  it('fails when the operator route inventory lists a route absent from Fastify source', () => {
    withFixtureProject('Use `GET /health`.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /health']),
        routeInventoryRows: [
          { key: 'GET /health', anchor: 'docs/operation.md:1' },
          { key: 'POST /api/runtime/dispatch', anchor: 'docs/operation.md:1' },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'route-inventory-missing', route: 'POST /api/runtime/dispatch' }),
      ]));
    });
  });

  it('fails for a synthetic fixture that references removed runtime dispatch', () => {
    withFixtureProject('Legacy guidance: `POST /api/runtime/dispatch` should start work.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /health']),
        routeInventoryRows: [{ key: 'GET /health', anchor: 'docs/operation.md:1' }],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'removed-route', route: 'POST /api/runtime/dispatch' }),
      ]));
    });
  });

  it('fails when the operator route inventory omits or duplicates implemented routes', () => {
    withFixtureProject('Use `GET /health`.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /health', 'GET /api/state']),
        routeInventoryRows: [
          { key: 'GET /health', anchor: 'docs/operation.md:1' },
          { key: 'GET /health', anchor: 'docs/operation.md:1' },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'route-inventory-count', route: 'GET /health' }),
        expect.objectContaining({ type: 'route-inventory-count', route: 'GET /api/state' }),
      ]));
    });
  });

  it('fails when a route inventory code anchor is invalid', () => {
    withFixtureProject('Use `GET /health`.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: new Set(['GET /health']),
        routeInventoryRows: [{ key: 'GET /health', anchor: 'missing.ts:999' }],
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'bad-anchor' }),
      ]));
    });
  });

  it('fails when documented agent tools drift from the implemented tool matrix', () => {
    const result = verifyAgentToolDocs({
      projectRoot,
      expectedTools: new Map([['planner', ['activate_card', 'get_card']]]),
      documentedTools: new Map([['planner', { tools: ['get_card'], anchor: 'src/agents/agent-adapter.ts:56' }]]),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent-tool-parity', role: 'planner' }),
    ]));
  });

  it('fails when runtime-control request or response shapes drift', () => {
    const result = verifyRuntimeControlDocs({
      projectRoot,
      rows: new Map([
        ['POST /api/runtime/pause', { request: 'body-required', response: 'status-object', anchor: 'src/server/routes/runtime-config-notes.ts:184' }],
        ['POST /api/runtime/resume', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:185' }],
        ['POST /api/runtime/freeze', { request: 'optional-object:{reason?:string}', response: 'freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:186' }],
        ['POST /api/runtime/resume-from-freeze', { request: 'empty-or-null-json-object', response: 'resume-from-freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:187' }],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'runtime-control-shape', route: 'POST /api/runtime/pause' }),
    ]));
  });


  it('passes runtime-control source checks when anchors point to tolerant control implementations', () => {
    const serverSource = [
      "fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {",
      "  const rawBody = String(body);",
      "  if (rawBody.trim() === '') done(null, null);",
      "});",
    ].join('\n');
    const routesSource = [
      "fastify.post('/api/runtime/pause', async () => result.state ?? readRuntimeState(projectRoot));",
      "fastify.post('/api/runtime/resume', async () => result.state ?? readRuntimeState(projectRoot));",
      "fastify.post('/api/runtime/freeze', async () => body?.reason);",
      "fastify.post('/api/runtime/resume-from-freeze', async () => activeRuntime.resumeFromFreeze());",
    ].join('\n');

    withRuntimeControlFixture(serverSource, routesSource, (fixtureRoot) => {
      const result = verifyRuntimeControlDocs({
        projectRoot: fixtureRoot,
        rows: new Map([
          ['POST /api/runtime/pause', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:1' }],
          ['POST /api/runtime/resume', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:2' }],
          ['POST /api/runtime/freeze', { request: 'optional-object:{reason?:string}', response: 'freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:3' }],
          ['POST /api/runtime/resume-from-freeze', { request: 'empty-or-null-json-object', response: 'resume-from-freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:4' }],
        ]),
      });

      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('fails runtime-control source checks when empty JSON body tolerance is removed', () => {
    const serverSource = "fastify.addContentTypeParser('application/json', {}, (_request, body, done) => done(null, JSON.parse(String(body))));\n";
    const routesSource = [
      "fastify.post('/api/runtime/pause', async () => result.state ?? readRuntimeState(projectRoot));",
      "fastify.post('/api/runtime/resume', async () => result.state ?? readRuntimeState(projectRoot));",
      "fastify.post('/api/runtime/freeze', async () => body?.reason);",
      "fastify.post('/api/runtime/resume-from-freeze', async () => activeRuntime.resumeFromFreeze());",
    ].join('\n');

    withRuntimeControlFixture(serverSource, routesSource, (fixtureRoot) => {
      const result = verifyRuntimeControlDocs({
        projectRoot: fixtureRoot,
        rows: new Map([
          ['POST /api/runtime/pause', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:1' }],
          ['POST /api/runtime/resume', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:2' }],
          ['POST /api/runtime/freeze', { request: 'optional-object:{reason?:string}', response: 'freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:3' }],
          ['POST /api/runtime/resume-from-freeze', { request: 'empty-or-null-json-object', response: 'resume-from-freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:4' }],
        ]),
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'runtime-control-empty-json-parser' }),
      ]));
    });
  });

  it('fails runtime-control source checks when RuntimeState anchors no longer point to RuntimeState responses', () => {
    const serverSource = [
      "fastify.addContentTypeParser('application/json', {}, (_request, body, done) => {",
      "  const rawBody = String(body);",
      "  if (rawBody.trim() === '') done(null, null);",
      "});",
    ].join('\n');
    const routesSource = [
      "fastify.post('/api/runtime/pause', async () => ({ status: 'paused' }));",
      "fastify.post('/api/runtime/resume', async () => result.state ?? readRuntimeState(projectRoot));",
      "fastify.post('/api/runtime/freeze', async () => body?.reason);",
      "fastify.post('/api/runtime/resume-from-freeze', async () => activeRuntime.resumeFromFreeze());",
    ].join('\n');

    withRuntimeControlFixture(serverSource, routesSource, (fixtureRoot) => {
      const result = verifyRuntimeControlDocs({
        projectRoot: fixtureRoot,
        rows: new Map([
          ['POST /api/runtime/pause', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:1' }],
          ['POST /api/runtime/resume', { request: 'empty-or-null-json-object', response: 'RuntimeState', anchor: 'src/server/routes/runtime-config-notes.ts:2' }],
          ['POST /api/runtime/freeze', { request: 'optional-object:{reason?:string}', response: 'freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:3' }],
          ['POST /api/runtime/resume-from-freeze', { request: 'empty-or-null-json-object', response: 'resume-from-freeze-summary', anchor: 'src/server/routes/runtime-config-notes.ts:4' }],
        ]),
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'anchor-source-mismatch' }),
      ]));
    });
  });

  it('fails when configuration docs drift from config-schema fields', () => {
    const result = verifyConfigDocs({
      projectRoot,
      expectedConfig: new Map([['runtime', ['continuous_improvement', 'max_review_retries', 'process_timeouts']]]),
      documentedConfig: new Map([['runtime', { fields: ['continuousImprovement'], anchor: 'src/agents/config-schema.ts:226' }]]),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'config-schema-parity', section: 'runtime' }),
    ]));
  });
});
