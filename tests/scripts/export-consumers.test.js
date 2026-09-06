import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOVERNED_ROOTS,
  checkExportConsumers,
  discoverGovernedFiles,
} from '../../scripts/check-export-consumers.js';

function write(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function fixture(files, allowlist = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'saivage-export-consumers-'));
  const base = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: { '@fixture/*': ['./src/*'] } },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    }),
    'web/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', paths: { '@fixture/*': ['../src/*'] } },
      include: ['src/**/*.ts'],
    }),
    'scripts/export-consumer-allowlist.json': `${JSON.stringify(allowlist, null, 2)}\n`,
    'web/src/fixture.ts': 'export {};\n',
    ...files,
  };
  for (const [relativePath, content] of Object.entries(base)) write(root, relativePath, content);
  return { root, trackedFiles: Object.keys(base).sort(), close: () => rmSync(root, { recursive: true, force: true }) };
}

function runFixture(files, allowlist) {
  const current = fixture(files, allowlist);
  try {
    return checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
  } finally {
    current.close();
  }
}

function record(result, module, name) {
  return result.records.find((item) => item.module === module && item.export === name);
}

describe('export consumer checker', () => {
  it('has a fixed two-root scope and fails absent or empty roots', () => {
    expect(GOVERNED_ROOTS).toEqual(['src/contracts', 'src/schemas']);
    expect(() => discoverGovernedFiles(['src/contracts/a.ts'])).toThrow('src/schemas');
    expect(() => discoverGovernedFiles(['src/contracts/a.ts', 'src/schemas/readme.md'])).toThrow('src/schemas');
    expect(discoverGovernedFiles(['src/contracts/a.ts', 'src/schemas/b.ts', 'src/runtime/c.ts']).files).toEqual([
      'src/contracts/a.ts',
      'src/schemas/b.ts',
    ]);
  });

  it('classifies compiler-semantic named, default, type, alias, routed, dynamic, namespace, local, zero, and test-only use', () => {
    const result = runFixture({
      'src/contracts/a.ts': [
        'export default function defaultValue() { return 1; }',
        'export interface Shape { size: number }',
        'export const named = 1;',
        'export const namedViaStar = 1;',
        'export const aliased = 2;',
        'export const dynamic = 3;',
        'export const dynamicDestructure = 3;',
        'export const namespaceDot = 4;',
        'export const namespaceElement = 5;',
        'export const namespaceDestructure = 6;',
        'export const tested = 7;',
        'export const localOnly = 8; export const localResult = localOnly + 1;',
        'export const zeroUse = 9;',
      ].join('\n'),
      'src/contracts/barrel.ts': "export { named as routed } from './a.js';\n",
      'src/contracts/star-barrel.ts': "export * from './a.js';\n",
      'src/schemas/b.ts': 'export interface SchemaType { ok: true }\n',
      'src/consumer.ts': [
        "import defaultValue, { type Shape, aliased as localAlias, localResult } from './contracts/a.js';",
        "import { routed } from './contracts/barrel.js';",
        "import { namedViaStar } from './contracts/star-barrel.js';",
        "import type { SchemaType } from './schemas/b.js';",
        "import * as values from './contracts/a.js';",
        'const shape: Shape = { size: defaultValue() };',
        'const schema: SchemaType = { ok: true };',
        'void [shape, schema, localAlias, localResult, routed, namedViaStar, values.namespaceDot, values[\'namespaceElement\']];',
        'const { namespaceDestructure } = values; void namespaceDestructure;',
        "void (await import('./contracts/a.js')).dynamic;",
        "const { dynamicDestructure } = await import('./contracts/a.js'); void dynamicDestructure;",
      ].join('\n'),
      'tests/consumer.test.ts': "import { tested } from '../src/contracts/a.js'; void tested;\n",
    });

    expect(record(result, 'src/contracts/a.ts', 'default').classification).toBe('production-consumed');
    for (const name of ['Shape', 'aliased', 'dynamic', 'dynamicDestructure', 'namespaceDot', 'namespaceElement', 'namespaceDestructure', 'named']) {
      expect(record(result, 'src/contracts/a.ts', name).classification).toBe('production-consumed');
    }
    expect(record(result, 'src/contracts/barrel.ts', 'routed').classification).toBe('production-consumed');
    expect(record(result, 'src/contracts/a.ts', 'namedViaStar').classification).toBe('production-consumed');
    expect(record(result, 'src/contracts/star-barrel.ts', 'namedViaStar').classification).toBe('production-consumed');
    expect(record(result, 'src/contracts/a.ts', 'tested').classification).toBe('test-only');
    expect(record(result, 'src/contracts/a.ts', 'tested').testLocations).toEqual([expect.stringMatching(/^tests\/consumer\.test\.ts:/)]);
    expect(record(result, 'src/contracts/a.ts', 'localOnly').classification).toBe('local-only');
    expect(record(result, 'src/contracts/a.ts', 'zeroUse').classification).toBe('zero-use');
  });

  it('fails stale imports while import and re-export bookkeeping do not fake consumption', () => {
    const result = runFixture({
      'src/contracts/a.ts': 'export const stale = 1; export const routed = 2;\n',
      'src/contracts/barrel.ts': "export { routed } from './a.js';\n",
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/consumer.ts': "import { stale } from './contracts/a.js'; import { schema } from './schemas/b.js'; void schema;\n",
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'stale-import', module: 'src/contracts/a.ts', export: 'stale' }));
    expect(record(result, 'src/contracts/a.ts', 'routed').classification).toBe('zero-use');
    expect(record(result, 'src/contracts/barrel.ts', 'routed').classification).toBe('zero-use');
  });

  it('fails unresolved governed names and unknown query transforms', () => {
    const result = runFixture({
      'src/contracts/a.ts': 'export const existing = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/consumer.ts': [
        "// @ts-expect-error missing export is intentional",
        "import { missing } from './contracts/a.js';",
        "import transformed from './contracts/a.ts?custom';",
        "import { schema } from './schemas/b.js';",
        'void [missing, transformed, schema];',
      ].join('\n'),
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unresolved-edge', module: 'src/contracts/a.ts', export: 'missing' }));
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'src/contracts/a.ts', export: '*' }));
  });

  it('treats raw, mock spread, broad reflection, and string-only negative checks as non-consumption', () => {
    const result = runFixture({
      'src/contracts/a.ts': 'export const reflected = 1; export const spreadOnly = 2; export const rawOnly = 3;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/consumer.ts': [
        "import * as ns from './contracts/a.js';",
        "import raw from './contracts/a.ts?raw';",
        "void Object.keys(ns).includes('reflected');",
        'const mock = { ...ns }; void [mock, raw];',
        "void ('RemovedExport' in ns);",
        "import { schema } from './schemas/b.js'; void schema;",
      ].join('\n'),
    });
    expect(record(result, 'src/contracts/a.ts', 'reflected').classification).toBe('zero-use');
    expect(record(result, 'src/contracts/a.ts', 'spreadOnly').classification).toBe('zero-use');
    expect(record(result, 'src/contracts/a.ts', 'rawOnly').classification).toBe('zero-use');
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'src/contracts/a.ts', export: 'reflected' }));
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'src/contracts/a.ts', export: '*' }));
  });

  it('validates exact allowlist schema, evidence, and staleness', () => {
    const files = {
      'src/contracts/a.ts': 'export const entry = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/consumer.ts': "import { schema } from './schemas/b.js'; void schema;\n",
      'bin/entry.js': "// invokes entry from src/contracts/a.ts outside TypeScript analysis\nvoid 'entry';\n",
    };
    const allowed = runFixture(files, [{
      module: 'src/contracts/a.ts', export: 'entry', kind: 'unobservable-entrypoint', consumer: 'bin/entry.js', reason: 'Executable bootstrap names this exact export for invocation',
    }]);
    expect(allowed.ok).toBe(true);

    const stale = runFixture(files, [{
      module: 'src/contracts/a.ts', export: 'missing', kind: 'unobservable-entrypoint', consumer: 'bin/entry.js', reason: 'Executable bootstrap names this exact export for invocation',
    }]);
    expect(stale.failures).toContainEqual(expect.objectContaining({ category: 'allowlist-stale', export: 'missing' }));

    const reflective = runFixture({
      'src/contracts/a.ts': 'export const entry = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/reflection.ts': [
        "import * as contracts from './contracts/a.js';",
        "// exact reflective evidence: src/contracts/a.ts entry",
        "void Object.keys(contracts).includes('entry');",
        "import { schema } from './schemas/b.js'; void schema;",
      ].join('\n'),
    }, [{
      module: 'src/contracts/a.ts', export: 'entry', kind: 'reflective-consumer', consumer: 'src/reflection.ts', reason: 'Exact external reflection intentionally observes this named export',
    }]);
    expect(reflective.ok).toBe(true);

    const invalid = fixture(files);
    try {
      write(invalid.root, 'scripts/export-consumer-allowlist.json', '{}\n');
      const checked = checkExportConsumers({ root: invalid.root, trackedFiles: invalid.trackedFiles });
      expect(checked.failures).toContainEqual(expect.objectContaining({ category: 'allowlist', message: 'allowlist must be a top-level array' }));
    } finally {
      invalid.close();
    }
  });

  it('sorts diagnostics by module, export, category, and consumer', () => {
    const result = runFixture({
      'src/contracts/z.ts': 'export const z = 1; export const a = 2;\n',
      'src/schemas/b.ts': 'export const b = 1;\n',
    });
    const keys = result.failures.map((failure) => [failure.module, failure.export, failure.category, failure.consumer].join('\0'));
    expect(keys).toEqual([...keys].sort());
  });
});

describe('repository governed export scope', () => {
  it('equals the independently derived tracked paths and pins 35/22/57', () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean);
    const independentlyDerived = tracked.filter((file) => file.endsWith('.ts') && GOVERNED_ROOTS.some((root) => file.startsWith(`${root}/`))).sort();
    const discovered = discoverGovernedFiles(tracked);

    expect(discovered.files).toEqual(independentlyDerived);
    expect(discovered.byRoot['src/contracts']).toHaveLength(35);
    expect(discovered.byRoot['src/schemas']).toHaveLength(22);
    expect(discovered.files).toHaveLength(57);
  });
});
