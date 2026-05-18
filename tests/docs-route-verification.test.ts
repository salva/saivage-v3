import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeOperatorDocPaths, extractImplementedRoutes, verifyDocRoutes } from '../scripts/verify-doc-routes.js';

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

describe('operator-facing documentation route verification', () => {
  it('passes for the current active operator docs', () => {
    const result = verifyDocRoutes({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.documentedRoutes.map((mention) => mention.key)).toContain('GET /health');
    expect(result.implementedRoutes.has('POST /api/runtime/dispatch')).toBe(false);
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
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: extractImplementedRoutes(projectRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('fails for a synthetic fixture that references removed runtime dispatch', () => {
    withFixtureProject('Legacy guidance: `POST /api/runtime/dispatch` should start work.\n', (fixtureRoot) => {
      const result = verifyDocRoutes({
        projectRoot: fixtureRoot,
        docPaths: ['docs/operation.md'],
        implementedRoutes: extractImplementedRoutes(projectRoot),
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'removed-route', route: 'POST /api/runtime/dispatch' }),
      ]));
    });
  });
});
