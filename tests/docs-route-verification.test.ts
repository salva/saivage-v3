import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractImplementedRoutes, verifyDocRoutes } from '../scripts/verify-doc-routes.js';

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
