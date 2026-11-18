import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkTestPartitions, parseDiscovery, PROJECT_NAMES } from '../../scripts/check-test-partitions.js';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
const configSource = readFileSync(path.join(repository, 'scripts/jest-focused.config.cjs'), 'utf8');
const owners = {
  storage: ['cards', 'persistence', 'workspace'],
  execution: ['agents', 'runtime', 'notifications', 'observability'],
  interfaces: ['application', 'auth', 'boot', 'cli', 'mcp', 'permissions', 'server', 'tools'],
  configuration: ['config', 'contracts', 'schemas', 'quality', 'retrieval'],
  tooling: ['architecture', 'scripts', 'utils'],
};
const isolated = ['tests/boot/app-terminal-child-process.test.ts', 'tests/utils/redaction-key-progress.test.ts'];

function put(root, file, text = 'throw new Error("discovery must not execute fixtures");\n') {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'focused jest space '));
  try {
    put(root, 'package.json', JSON.stringify(pkg));
    put(root, 'scripts/jest-focused.config.cjs', configSource);
    symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'));
    for (const directories of Object.values(owners)) {
      for (const directory of directories) put(root, `tests/${directory}/ordinary.test.js`);
    }
    for (const file of isolated) put(root, file);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function npm(root, script, args = []) {
  return spawnSync('npm', ['run', '--silent', script, '--', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}

function listing(root, script, args = []) {
  return parseDiscovery(npm(root, script, [...args, '--listTests', '--json', '--runInBand']), script, root);
}

function changePackage(root, mutate) {
  const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  mutate(current);
  put(root, 'package.json', JSON.stringify(current));
}

describe('installed Jest focused partitions', () => {
  it('preserves both canonical match families, root/nested ownership, extensions and exact isolation', () => fixture((root) => {
    const extra = [];
    for (const extension of ['js', 'jsx', 'ts', 'tsx']) {
      for (const file of [
        `tests/root.spec.${extension}`,
        `tests/__tests__/nested/root-helper.${extension}`,
        `tests/cards/deep/owner.test.${extension}`,
        `tests/cards/deep/__tests__/deeper/helper.${extension}`,
      ]) {
        put(root, file);
        extra.push(file);
      }
    }
    const siblings = [
      'tests/boot/app-terminal-child-process.test.ts.test.ts',
      'tests/boot/app-terminal-child-processXtest.ts',
      'tests/utils/redaction-key-progress.test.ts.test.ts',
      'tests/utils/redaction-key-progressXtest.ts',
    ];
    // Xtest names need a canonical suffix to be suites.
    siblings[1] += '.spec.ts';
    siblings[3] += '.spec.ts';
    for (const file of siblings) put(root, file);
    for (const file of ['tests/e2e/excluded.test.ts', 'tests/playwright/excluded.spec.js',
      'tests/scripts/node-owned.test.cjs', 'tests/cards/not-a-suite.ts']) put(root, file);
    const result = checkTestPartitions(root);
    expect(result.ordinary).toEqual(expect.arrayContaining([...extra, ...siblings]));
    expect(result.ordinary).not.toEqual(expect.arrayContaining(isolated));
    expect(result.complete).toHaveLength(result.ordinary.length + 2);
    expect(result.complete.some((file) => /\/(e2e|playwright)\//.test(file))).toBe(false);
    expect(result.complete).not.toContain('tests/scripts/node-owned.test.cjs');
    expect(result.projects.tooling).toEqual(expect.arrayContaining(extra.filter((file) => !file.startsWith('tests/cards/'))));
    const selected = listing(root, 'test:focus', ['--selectProjects', 'storage', 'execution']);
    expect(selected).toEqual([...result.projects.storage, ...result.projects.execution].sort());
    expect(listing(root, 'test:focus')).toEqual(result.ordinary);
  }), 60000);

  it('reports an unassigned directory with exact missing paths', () => fixture((root) => {
    put(root, 'tests/new-owner/future.test.ts');
    expect(() => checkTestPartitions(root)).toThrow('focused union: missing tests/new-owner/future.test.ts');
  }), 60000);

  it('reports duplicate ownership and missing coverage from the actual projects', () => fixture((root) => {
    put(root, 'scripts/jest-focused.config.cjs', configSource
      + '\nmodule.exports.projects[1].testMatch.push("<rootDir>/tests/cards/**/*.test.js");\n'
      + 'module.exports.projects[0].testMatch = ["<rootDir>/tests/cards/**/*.test.js"];\n');
    expect(() => checkTestPartitions(root)).toThrow(/duplicate ownership: tests\/cards\/ordinary.test.js[\s\S]*focused union: missing tests\/persistence\/ordinary.test.js/);
  }), 60000);

  it('rejects unknown/missing/duplicate project names', () => fixture((root) => {
    for (const mutation of [
      'module.exports.projects[0].displayName = "unknown";',
      'module.exports.projects.pop();',
      'module.exports.projects[0].displayName = "execution";',
    ]) {
      // New config path identity per case avoids Node require-cache reuse.
      const separate = mkdtempSync(path.join(root, 'names-'));
      put(separate, 'package.json', '{}');
      put(separate, 'scripts/jest-focused.config.cjs', `module.exports = ${JSON.stringify({
        projects: PROJECT_NAMES.map((displayName) => ({ displayName })),
      })};\n${mutation}`);
      expect(() => checkTestPartitions(separate)).toThrow('unknown, missing or duplicate focused project names');
    }
  }));

  it.each([
    ['malformed', 'node -e \'console.log("not JSON")\'', 'malformed Jest discovery JSON'],
    ['failed', 'node -e \'process.exit(7)\'', 'Jest discovery failed (7)'],
    ['empty', 'node -e \'console.log("[]")\'', 'zero or invalid Jest discovery'],
  ])('rejects %s subprocess discovery rather than accepting an empty inventory', (_label, command, message) => fixture((root) => {
    // npm appends Jest arguments; -- stops Node interpreting them as Node options.
    changePackage(root, (current) => { current.scripts['test:direct'] = `${command} --`; });
    expect(() => checkTestPartitions(root)).toThrow(message);
  }), 60000);

  it('rejects invalid, duplicate and interrupted structured results', () => {
    for (const stdout of ['{}', '["relative.test.js"]', '["/a.test.js","/a.test.js"]']) {
      expect(() => parseDiscovery({ status: 0, stdout }, 'fixture', '/')).toThrow();
    }
    expect(() => parseDiscovery({ status: null, signal: 'SIGTERM' }, 'fixture', '/')).toThrow('SIGTERM');
    expect(() => parseDiscovery({ status: null, error: new Error('spawn failed') }, 'fixture', '/')).toThrow('spawn failed');
  });

  it('forwards spaced path/name narrowing, serial and worker modes directly to Jest with natural exits', () => fixture((root) => {
    const file = 'tests/cards/space case.test.js';
    put(root, file, `import { test, expect } from '@jest/globals';
test('chosen name with spaces', () => expect(2 + 2).toBe(4));
test('unselected failing assertion', () => { throw new Error('name filter lost'); });
`);
    const args = ['--runTestsByPath', file, '--testNamePattern=chosen name with spaces', '--json'];
    for (const mode of ['--runInBand', '--maxWorkers=2']) {
      for (const script of ['test:direct', 'test:focus:storage']) {
        const result = npm(root, script, [...args, mode]);
        expect({ status: result.status, signal: result.signal, stderr: result.status ? result.stderr : '' })
          .toEqual({ status: 0, signal: null, stderr: '' });
        const report = JSON.parse(result.stdout);
        expect(report.numPassedTests).toBe(1);
        expect(report.numPendingTests).toBe(1);
        expect(report.testResults.map((test) => path.relative(root, test.name))).toEqual([file]);
      }
    }
    for (const [script, selection] of [
      ['test:focus:storage', ['--runTestsByPath', 'tests/config/ordinary.test.js']],
      ['test:focus:storage', ['--runTestsByPath', 'tests/cards/missing.test.js']],
      ['test:focus', ['--selectProjects', 'unknown']],
    ]) {
      const result = npm(root, script, [...selection, '--runInBand']);
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      if (selection.includes('unknown')) expect(result.stdout + result.stderr).toContain('no projects were found matching the selection');
    }
    const unmatched = npm(root, 'test:focus:storage', [
      '--runTestsByPath', file, '--testNamePattern=absent name', '--runInBand', '--json',
    ]);
    // Jest name-only no-match is a skipped suite, unlike an empty path selection.
    expect(unmatched.status).toBe(0);
    expect(JSON.parse(unmatched.stdout).numPassedTests).toBe(0);
  }), 60000);
});
