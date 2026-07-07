import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverOperatorContractRouteSources,
  discoverOperatorContractSourceFiles,
  extractImplementedRoutes,
  formatVerificationResult,
  verifyDocSourceContracts,
} from '../../scripts/verify-doc-routes.js';

function withFixture(files, testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-doc-route-discovery-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('verify-doc-routes operator contract discovery', () => {
  it('discovers current operator contract route slices without a manually maintained route list', () => {
    const projectRoot = process.cwd();
    const routeSources = discoverOperatorContractRouteSources(projectRoot);

    expect(routeSources).toEqual([
      'src/contracts/operator-api-agents.ts',
      'src/contracts/operator-api-auth.ts',
      'src/contracts/operator-api-chats.ts',
      'src/contracts/operator-api-config.ts',
      'src/contracts/operator-api-events.ts',
      'src/contracts/operator-api-files-debug.ts',
      'src/contracts/operator-api-mcp.ts',
      'src/contracts/operator-api-processes.ts',
      'src/contracts/operator-api-runtime-cards.ts',
    ]);
    expect(discoverOperatorContractSourceFiles(projectRoot)).toContain('src/contracts/operator-api-core.ts');
    expect(routeSources).not.toContain('src/contracts/operator-api-core.ts');
    expect(routeSources).not.toContain('src/contracts/operator-api-availability.ts');
    expect(routeSources).not.toContain('src/contracts/operator-api.ts');

    const routes = extractImplementedRoutes(projectRoot);
    expect([...routes]).toEqual(expect.arrayContaining([
      'GET /api/events',
      'GET /api/processes',
      'GET /api/config',
      'GET /api/mcp/status',
      'POST /api/debug/runtime/start',
      'GET /api/debug/doctor',
      'GET /api/debug/supervision',
      'GET /api/debug/state',
      'GET /api/debug/errors',
      'GET /api/debug/timeline',
      'POST /api/auth/ws-ticket',
      'GET /health',
      'GET /health/ready',
    ]));
  });

  it('classifies every /api/debug route into the internal debug inventory', () => {
    const projectRoot = process.cwd();
    const result = verifyDocSourceContracts({ projectRoot });
    const debugRoutes = result.routeResult.internalDebugRows.map((row) => row.key).sort();

    expect(debugRoutes).toEqual([
      'GET /api/debug/doctor',
      'GET /api/debug/errors',
      'GET /api/debug/state',
      'GET /api/debug/supervision',
      'GET /api/debug/timeline',
      'POST /api/debug/runtime/start',
    ]);
    expect(result.routeResult.routeInventoryRows.map((row) => row.key)).not.toEqual(expect.arrayContaining(debugRoutes));
  });

  it('reports discovered route-bearing contract sources in docs verification output', () => {
    const projectRoot = process.cwd();
    const output = formatVerificationResult(verifyDocSourceContracts({ projectRoot }), projectRoot);

    expect(output).toContain('src/contracts/operator-api-events.ts');
    expect(output).toContain('src/contracts/operator-api-processes.ts');
    expect(output).toContain('src/contracts/operator-api-config.ts');
    expect(output).not.toContain('src/contracts/operator-api-core.ts');
    expect(output).not.toContain('src/contracts/operator-api-availability.ts');
  });

  it('discovers future operator-api slices and ignores helper slices without route literals', () => {
    withFixture({
      'src/contracts/operator-api-z-helper.ts': 'export const helper = true;\n',
      'src/contracts/operator-api-z-test.ts': `export const zTestOperatorApiContracts = {
  test: {
    method: 'GET',
    path: '/api/z-test',
  },
} as const;
`,
      'src/contracts/not-operator-api.ts': `export const ignored = {
  method: 'GET',
  path: '/api/ignored',
} as const;
`,
    }, (projectRoot) => {
      expect(discoverOperatorContractSourceFiles(projectRoot)).toEqual([
        'src/contracts/operator-api-z-helper.ts',
        'src/contracts/operator-api-z-test.ts',
      ]);
      expect(discoverOperatorContractRouteSources(projectRoot)).toEqual(['src/contracts/operator-api-z-test.ts']);
      expect(extractImplementedRoutes(projectRoot)).toEqual(new Set(['GET /api/z-test']));
    });
  });
});
