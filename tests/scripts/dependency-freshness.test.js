import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDependencyFreshness } from '../../scripts/check-dependency-freshness.js';

function writeJson(root, relativePath, value) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
}

function withRepo(overrides, testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-deps-freshness-'));
  try {
    writeJson(root, 'package.json', {
      dependencies: { fastify: '^5.0.0', zod: '^3.0.0' },
      devDependencies: { jest: '^29.0.0' },
    });
    writeJson(root, 'web/package.json', {
      dependencies: { vue: '^3.0.0', pinia: '^2.0.0' },
      devDependencies: { vite: '^6.0.0' },
    });
    writeJson(root, 'package-lock.json', { name: 'root', lockfileVersion: 3, packages: {} });
    writeJson(root, 'web/package-lock.json', { name: 'web', lockfileVersion: 3, packages: {} });
    writeJson(root, 'fixtures/root-outdated.json', {});
    writeJson(root, 'fixtures/web-outdated.json', {});
    for (const [relativePath, value] of Object.entries(overrides)) {
      if (value === null) {
        continue;
      }
      writeJson(root, relativePath, value);
    }
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function check(root, extra = {}) {
  return checkDependencyFreshness({
    root,
    fixtures: {
      root: 'fixtures/root-outdated.json',
      web: 'fixtures/web-outdated.json',
    },
    now: new Date('2026-05-21T00:00:00Z'),
    ...extra,
  });
}

describe('dependency freshness checker', () => {
  it('passes when no direct runtime dependencies are outdated', () => {
    withRepo({}, (root) => {
      const result = check(root);
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.ecosystems.find((entry) => entry.name === 'root')?.directRuntime).toEqual([]);
    });
  });

  it('reports direct runtime staleness without failing during calibration', () => {
    withRepo({
      'fixtures/root-outdated.json': {
        fastify: { current: '5.0.0', wanted: '5.1.0', latest: '6.0.0', type: 'dependencies' },
      },
    }, (root) => {
      const result = check(root);
      expect(result.ok).toBe(true);
      expect(result.warnings).toContainEqual(expect.stringContaining('root direct runtime dependencies are stale: fastify 5.0.0->6.0.0'));
    });
  });

  it('can fail direct runtime staleness when the required threshold is enabled', () => {
    withRepo({
      'fixtures/web-outdated.json': {
        vue: { current: '3.0.0', wanted: '3.5.0', latest: '4.0.0', type: 'dependencies' },
      },
    }, (root) => {
      const result = check(root, { requiredDirectRuntimeStaleness: true });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('web direct runtime dependencies are stale: vue 3.0.0->4.0.0');
    });
  });

  it('keeps dev-only outdated dependencies advisory', () => {
    withRepo({
      'fixtures/root-outdated.json': {
        jest: { current: '29.0.0', wanted: '29.7.0', latest: '30.0.0', type: 'devDependencies' },
      },
    }, (root) => {
      const result = check(root, { requiredDirectRuntimeStaleness: true });
      expect(result.ok).toBe(true);
      expect(result.warnings).toContain('root has 1 dev-only and 0 transitive/other outdated package(s); advisory only');
    });
  });

  it('runs npm outdated in each ecosystem when fixtures are not supplied', () => {
    withRepo({}, (root) => {
      const calls = [];
      const result = checkDependencyFreshness({
        root,
        now: new Date('2026-05-21T00:00:00Z'),
        commandRunner: (cwd, ecosystem) => {
          calls.push({ cwd, ecosystem: ecosystem.name });
          return ecosystem.name === 'root'
            ? JSON.stringify({ fastify: { current: '5.0.0', wanted: '5.1.0', latest: '6.0.0', type: 'dependencies' } })
            : '{}';
        },
      });

      expect(result.ok).toBe(true);
      expect(calls).toEqual([
        { cwd: root, ecosystem: 'root' },
        { cwd: join(root, 'web'), ecosystem: 'web' },
      ]);
      expect(result.warnings).toContainEqual(expect.stringContaining('root direct runtime dependencies are stale: fastify 5.0.0->6.0.0'));
    });
  });

  it('parses npm outdated stdout from the standard nonzero outdated exit', () => {
    withRepo({}, (root) => {
      const error = new Error('npm outdated exited with packages');
      error.status = 1;
      error.stdout = JSON.stringify({ vue: { current: '3.0.0', wanted: '3.5.0', latest: '4.0.0', type: 'dependencies' } });
      error.stderr = '';
      const result = checkDependencyFreshness({
        root,
        now: new Date('2026-05-21T00:00:00Z'),
        commandRunner: (_cwd, ecosystem) => {
          if (ecosystem.name === 'web') {
            throw error;
          }
          return '{}';
        },
      });

      expect(result.ok).toBe(true);
      expect(result.warnings).toContainEqual(expect.stringContaining('web direct runtime dependencies are stale: vue 3.0.0->4.0.0'));
    });
  });

  it('fails clearly on npm outdated registry or command failures without JSON stdout', () => {
    withRepo({}, (root) => {
      const error = new Error('registry unavailable');
      error.status = 1;
      error.stdout = '';
      error.stderr = 'npm ERR! 503 Service Unavailable';
      const result = checkDependencyFreshness({
        root,
        now: new Date('2026-05-21T00:00:00Z'),
        commandRunner: (_cwd, ecosystem) => {
          if (ecosystem.name === 'root') {
            throw error;
          }
          return '{}';
        },
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toContain('root npm outdated exited 1: npm ERR! 503 Service Unavailable');
    });
  });

  it('fails clearly when npm outdated returns invalid JSON', () => {
    withRepo({}, (root) => {
      const result = checkDependencyFreshness({
        root,
        now: new Date('2026-05-21T00:00:00Z'),
        commandRunner: (_cwd, ecosystem) => (ecosystem.name === 'root' ? 'not-json' : '{}'),
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('root npm outdated returned invalid JSON'));
    });
  });

  it('does not call npm outdated when fixture mode is supplied', () => {
    withRepo({}, (root) => {
      const result = check(root, {
        commandRunner: () => {
          throw new Error('fixture mode should not call npm outdated');
        },
      });

      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('fails when a lockfile is downgraded from package-lock v3', () => {
    withRepo({ 'web/package-lock.json': { name: 'web', lockfileVersion: 2, packages: {} } }, (root) => {
      const result = check(root);
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('web/package-lock.json must use package-lock v3, found 2');
    });
  });

  it('fails expired waiver metadata', () => {
    withRepo({
      'docs/runbook/dependency-hygiene-waivers.json': {
        waivers: [{
          package: 'fastify',
          ecosystem: 'root',
          advisory: 'GHSA-synthetic',
          severity: 'high',
          owner: 'platform-maintainers',
          created: '2026-05-01',
          expires: '2026-05-20',
          reason: 'synthetic test',
          compensating_control: 'not exposed',
        }],
      },
    }, (root) => {
      const result = check(root);
      expect(result.ok).toBe(false);
      expect(result.failures).toContain('waiver[0] for fastify expired on 2026-05-20');
    });
  });

  it('accepts future-expiry waiver metadata without failing', () => {
    withRepo({
      'docs/runbook/dependency-hygiene-waivers.json': {
        waivers: [{
          package: 'fastify',
          ecosystem: 'root',
          advisory: 'GHSA-synthetic',
          severity: 'high',
          owner: 'platform-maintainers',
          created: '2026-05-01',
          expires: '2026-06-01',
          reason: 'synthetic test',
          compensating_control: 'not exposed',
        }],
      },
    }, (root) => {
      const result = check(root);
      expect(result.ok).toBe(true);
      expect(result.waiverCount).toBe(1);
    });
  });
});
