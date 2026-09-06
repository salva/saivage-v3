import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOVERNED_ROOTS,
  analyzeCompleteExportConsumers,
  checkExportConsumers,
  discoverCompleteOwnership,
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

function runCompleteFixture(files, allowlist) {
  const current = fixture(files, allowlist);
  try {
    return analyzeCompleteExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
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

describe('complete export analysis behind phase-one enforcement', () => {
  it('discovers every production TypeScript spelling, excludes only declarations and tests, and hosts all consumers', () => {
    const current = fixture({
      'src/contracts/a.ts': 'export interface Governed { ok: true } export interface TestGoverned { test: true } export interface SfcTestOnly { sfc: true }\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/owner.ts': 'export const tsOwner = 1;\n',
      'src/owner.tsx': 'export const tsxOwner = 1;\n',
      'src/owner.mts': 'export const mtsOwner = 1;\n',
      'src/owner.cts': 'export const ctsOwner = 1;\n',
      'src/owner.d.ts': "import type { Governed } from './contracts/a.js'; export type Decl = Governed;\n",
      'src/owner.d.mts': "import type { Governed } from './contracts/a.js'; export type DeclM = Governed;\n",
      'src/owner.d.cts': "import type { Governed } from './contracts/a.js'; export type DeclC = Governed;\n",
      'src/consumer.d.tsx': "import type { Governed } from './contracts/a.js'; export type OrdinaryTsx = Governed;\n",
      'tests/only-consumer.d.ts': "import type { TestGoverned } from '../src/contracts/a.js'; export type TestOnlyDeclarationUse = TestGoverned;\n",
      'tests/consumer.mjs': 'export {};\n',
      'tests/consumer.cjs': 'void 0;\n',
      'src/owner.test.ts': 'export const notACandidate = 1;\n',
      'web/src/Widget.vue': '<template><span>{{ schema }}</span></template><script setup lang="ts">import { schema } from "../../src/schemas/b.js";</script>\n',
      'web/src/Widget.test.vue': '<script setup lang="ts">import type { SfcTestOnly } from "../../src/contracts/a.js"; const value = null as unknown as SfcTestOnly; void value;</script>\n',
      'web/src/Widget.spec.vue': '<script setup lang="ts">import type { SfcTestOnly } from "../../src/contracts/a.js"; const value = null as unknown as SfcTestOnly; void value;</script>\n',
      'web/src/__tests__/Widget.vue': '<script setup lang="ts">import type { SfcTestOnly } from "../../../src/contracts/a.js"; const value = null as unknown as SfcTestOnly; void value;</script>\n',
    });
    try {
      const discovery = discoverCompleteOwnership(current.trackedFiles);
      expect(discovery.files).toEqual(expect.arrayContaining([
        'src/owner.ts', 'src/owner.tsx', 'src/owner.mts', 'src/owner.cts', 'src/consumer.d.tsx', 'web/src/Widget.vue',
      ]));
      expect(discovery.files).not.toEqual(expect.arrayContaining([
        'src/owner.d.ts', 'src/owner.d.mts', 'src/owner.d.cts', 'src/owner.test.ts', 'web/src/Widget.test.vue', 'web/src/Widget.spec.vue', 'web/src/__tests__/Widget.vue',
      ]));
      const result = analyzeCompleteExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      expect(result.ownership.declarationFiles).toEqual(['src/owner.d.cts', 'src/owner.d.mts', 'src/owner.d.ts', 'tests/only-consumer.d.ts']);
      expect(result.ownership.typescriptConsumerFiles).toEqual(expect.arrayContaining(['src/consumer.d.tsx', 'src/owner.d.ts', 'src/owner.d.mts', 'src/owner.d.cts']));
      expect(result.ownership.sfcConsumerFiles).toEqual(expect.arrayContaining(['web/src/Widget.vue', 'web/src/Widget.test.vue', 'web/src/Widget.spec.vue', 'web/src/__tests__/Widget.vue']));
      expect(result.ownership.jsConsumerFiles).toEqual(expect.arrayContaining(['tests/consumer.mjs', 'tests/consumer.cjs']));
      expect(record(result, 'src/contracts/a.ts', 'Governed').classification).toBe('production-consumed');
      expect(record(result, 'src/contracts/a.ts', 'TestGoverned').classification).toBe('test-only');
      expect(record(result, 'src/contracts/a.ts', 'SfcTestOnly').classification).toBe('test-only');
      expect(record(result, 'src/consumer.d.tsx', 'OrdinaryTsx')).toBeDefined();
      expect(result.failures).not.toContainEqual(expect.objectContaining({ message: 'compiler declaration status disagrees with exact declaration suffix partition' }));
    } finally {
      current.close();
    }
  });

  it('maps canonical browser-root literals identically across TS, SFC, JS, arbitrary receivers, and fake page objects', () => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/api/client.ts': 'export const testA = 1; export const testB = 2; export const webUse = 3; export const sfcUse = 4; export const jsUse = 5; export const untouched = 6;\n',
      'tests/browser.test.ts': 'declare const page: { evaluate<T>(fn: () => T): T }; page.evaluate(async () => { const client = await import("/src/api/client.ts"); void [client.testA, client.testB]; });\n',
      'web/src/receiver.ts': 'const differentlyNamed = { execute: async (fn: () => unknown) => fn() }; differentlyNamed.execute(async () => { const client = await import("/src/api/client.ts"); void client.webUse; }); const page = { evaluate: async (fn: () => unknown) => fn() }; page.evaluate(async () => { const client = await import("/src/api/client.ts"); void client.webUse; });\n',
      'web/src/Host.vue': '<template><span>{{ value }}</span></template><script setup lang="ts">import { sfcUse as value } from "/src/api/client.ts";</script>\n',
      'tests/root-consumer.js': 'const { jsUse } = await import("/src/api/client.ts"); void jsUse;\n',
      'tests/import-only.test.ts': 'import "/src/api/client.ts"; import * as unused from "/src/api/client.ts"; void 0;\n',
    });
    expect(record(result, 'web/src/api/client.ts', 'testA').classification).toBe('test-only');
    expect(record(result, 'web/src/api/client.ts', 'testB').classification).toBe('test-only');
    expect(record(result, 'web/src/api/client.ts', 'webUse').classification).toBe('production-consumed');
    expect(record(result, 'web/src/api/client.ts', 'sfcUse').classification).toBe('production-consumed');
    expect(record(result, 'web/src/api/client.ts', 'jsUse').classification).toBe('test-only');
    expect(record(result, 'web/src/api/client.ts', 'untouched').classification).toBe('zero-use');
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'stale-import', module: 'web/src/api/client.ts' }));
    expect(record(result, 'web/src/api/client.ts', 'testA').testLocations).toHaveLength(1);
  });

  it('rejects computed browser-root imports regardless of receiver spelling', () => {
    for (const source of [
      'const root = "/src/api/client.ts"; await import(root);',
      'const page = { evaluate: async (fn: () => unknown) => fn() }; page.evaluate(async () => { const root = "/src/api/client.ts"; await import(root); });',
    ]) {
      const result = runCompleteFixture({
        'src/contracts/a.ts': 'export const phase = 1;\n',
        'src/schemas/b.ts': 'export const schema = 1;\n',
        'web/src/api/client.ts': 'export const value = 1;\n',
        'tests/computed.test.ts': source,
      });
      expect(result.failures.filter((failure) => failure.category === 'unsupported')).toEqual([
        expect.objectContaining({ module: '/src/api/client.ts', message: 'computed root-relative dynamic import is unsupported' }),
      ]);
      expect(record(result, 'web/src/api/client.ts', 'value').classification).toBe('zero-use');
    }
  });

  it.each([
    '/src/api/client.ts?raw',
    '/src/api/client.ts#part',
    '/src/../api/client.ts',
    '/src/./api/client.ts',
    '/src//api/client.ts',
    '/web/api/client.ts',
    '/src/api/client.js',
    '/src/api/missing.ts',
  ])('rejects malformed or unresolved root-relative literal %s', (specifier) => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/api/client.ts': 'export const value = 1;\n',
      'tests/malformed.test.ts': `await import(${JSON.stringify(specifier)});\n`,
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: specifier }));
  });

  it('fails an ambiguous canonical browser-root target', () => {
    const current = fixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/api/client.ts': 'export const value = 1;\n',
      'tests/ambiguous.test.ts': 'await import("/src/api/client.ts");\n',
    });
    try {
      current.trackedFiles.push('web\\src\\api\\client.ts');
      const result = analyzeCompleteExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: '/src/api/client.ts' }));
    } finally {
      current.close();
    }
  });

  it('uses exact explicit SFC lazy defaults, not bare imports, and fails malformed SFCs', () => {
    const explicit = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Widget.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/router.ts': 'const load = () => import("./Widget.vue").then((module) => module.default); void load;\n',
    });
    expect(record(explicit, 'web/src/Widget.vue', 'default').classification).toBe('production-consumed');

    const bare = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Widget.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/router.ts': 'const load = () => import("./Widget.vue"); void load;\n',
    });
    expect(record(bare, 'web/src/Widget.vue', 'default').classification).toBe('zero-use');

    const malformed = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Broken.vue': '<template src="./elsewhere.html"/><script setup lang="js">export const bad = 1;</script>\n',
    });
    expect(malformed.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'web/src/Broken.vue' }));
  });

  it('composes ordinary/setup/template SFC semantics with exact bindings and canonical source locations', () => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/support.ts': 'export const helper = 1; export const vFocus = {}; export const stale = 3; export interface Props { value: string }\n',
      'web/src/Child.vue': '<script setup lang="ts">const child = 1; void child;</script>\n',
      'web/src/Composed.vue': [
        '<script lang="ts">export type ExplicitKind = "composed";</script>',
        '<script setup lang="ts">',
        'import ChildAlias from "./Child.vue";',
        'import { helper, vFocus, stale, type Props } from "./support";',
        'const props = defineProps<{ value: string }>(); const typed = null as unknown as Props; void typed;',
        'const shorthand = { helper }; const renamed = { value: helper }; void [shorthand, renamed];',
        '</script>',
        '<template><component :is="ChildAlias" v-focus><template #default="{ item }"><span>{{ item.name }} {{ props.value }} {{ helper }}</span></template></component></template>',
      ].join('\n'),
      'web/src/owner.ts': 'import type { ExplicitKind } from "./Composed.vue"; const kind: ExplicitKind = "composed"; void kind;\n',
    });
    expect(record(result, 'web/src/Composed.vue', 'ExplicitKind').classification).toBe('production-consumed');
    expect(record(result, 'web/src/Child.vue', 'default').classification).toBe('production-consumed');
    for (const name of ['helper', 'vFocus', 'Props']) {
      const item = record(result, 'web/src/support.ts', name);
      expect(item.classification).toBe('production-consumed');
      expect(item.productionLocations.some((at) => at.startsWith('web/src/Composed.vue:'))).toBe(true);
    }
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'stale-import', module: 'web/src/support.ts', export: 'stale' }));
  });

  it.each([
    '<template/><script setup lang="ts" src="./external.ts"/>',
    '<template/><script setup lang="js">const value = 1;</script>',
    '<template><span/></template>',
    '<template/><script setup lang="ts">export const invalid = 1;</script>',
    '<script setup lang="ts">const a = 1;</script><script setup lang="ts">const b = 2;</script>',
  ])('fails unsupported SFC descriptor form %#', (source) => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Broken.vue': source,
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'web/src/Broken.vue' }));
  });

  it('maps clean-tree dist JS imports and keeps symbol use binding-aware', () => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/cli.ts': 'export const run = () => 1; export const other = 2;\n',
      'bin/entry.js': 'const { run } = await import("../dist/src/cli.js"); { const run = 2; void run; } void run;\n',
      'tests/stale.js': 'import { other } from "../src/cli.js"; function f(other) { return other; } void f;\n',
    });
    expect(record(result, 'src/cli.ts', 'run').classification).toBe('production-consumed');
    expect(record(result, 'src/cli.ts', 'other').classification).toBe('zero-use');
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'stale-import', module: 'src/cli.ts', export: 'other' }));
  });

  it.each([
    'import value from "../src/owner.js"; void value;',
    'import * as values from "../src/owner.js"; void values;',
    'export { value } from "../src/owner.js";',
    'const value = require("../src/owner.js"); void value;',
    'const specifier = "../src/owner.js"; await import(specifier);',
    'const values = await import("../src/owner.js"); void values[name];',
    'import { value } from "../src/owner.ts?custom"; void value;',
  ])('fails closed on unsupported JavaScript governed form %#', (source) => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/owner.ts': 'export default 1; export const value = 2;\n',
      'tests/unsupported.js': source,
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported' }));
  });

  it('treats the exact raw SFC glob as source-text loading without component consumption', () => {
    const result = runCompleteFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/components/debug/StatePanel.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/__tests__/raw.test.ts': "const sources = import.meta.glob('../components/debug/*Panel.vue', { eager: true, query: '?raw', import: 'default' }); void sources;\n",
    });
    expect(record(result, 'web/src/components/debug/StatePanel.vue', 'default').classification).toBe('zero-use');
    expect(result.failures.filter((failure) => failure.category === 'unsupported')).toEqual([]);
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

  it('reproduces complete candidate/consumer parity and the authoritative pre-cleanup inventory', () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean);
    const result = analyzeCompleteExportConsumers({ root: repositoryRoot, trackedFiles: tracked });
    const testPath = (file) => file.startsWith('tests/') || file.includes('/__tests__/') || /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue)$/.test(file) || /(?:^|\/)vitest\.config\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file);
    const tsFamily = tracked.filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file)).sort();
    const declarations = tsFamily.filter((file) => /\.d\.(?:ts|mts|cts)$/.test(file));
    const sfcConsumers = tracked.filter((file) => file.startsWith('web/src/') && file.endsWith('.vue')).sort();
    const independentCandidates = tracked.filter((file) =>
      ((/\.(?:ts|tsx|mts|cts)$/.test(file) && !/\.d\.(?:ts|mts|cts)$/.test(file)) || file.endsWith('.vue')) &&
      (file.startsWith('src/') || file.startsWith('web/src/')) &&
      !testPath(file)).sort();
    const jsFamily = tracked.filter((file) => /\.(?:js|mjs|cjs)$/.test(file)).sort();
    expect(result.ownership.candidateFiles).toEqual(independentCandidates);
    expect(result.ownership.typescriptConsumerFiles).toEqual(tsFamily);
    expect(result.ownership.declarationFiles).toEqual(declarations);
    expect(result.ownership.sfcConsumerFiles).toEqual(sfcConsumers);
    expect(result.ownership.sfcCandidateFiles).toEqual(sfcConsumers.filter((file) => !testPath(file)));
    expect(result.ownership.jsConsumerFiles).toEqual(jsFamily);
    const assignedTs = ['root', 'web', 'docs'].flatMap((host) => result.ownership.hostAssignments[host]).filter((file) => !file.endsWith('.vue.__export_consumer__.ts')).sort();
    expect(assignedTs).toEqual(tsFamily);
    expect(new Set(assignedTs)).toHaveProperty('size', tsFamily.length);
    expect(result.ownership.candidateFiles).toHaveLength(391);
    expect(result.ownership.typescriptConsumerFiles).toHaveLength(734);
    expect(result.ownership.typescriptOrdinaryFiles).toHaveLength(732);
    expect(result.ownership.declarationFiles).toEqual(['scripts/verify-doc-routes.d.ts', 'web/env.d.ts']);
    expect(result.ownership.sfcCandidateFiles).toHaveLength(51);
    expect(result.ownership.sfcConsumerFiles).toHaveLength(51);
    expect(result.ownership.jsConsumerFiles).toHaveLength(25);
    expect(result.totals).toEqual({ 'production-consumed': 1668, 'test-only': 218, 'local-only': 331, 'zero-use': 165 });
    const remaining = result.records.filter((item) => !GOVERNED_ROOTS.some((root) => item.module.startsWith(`${root}/`)));
    expect(remaining).toHaveLength(1739);
    expect(Object.fromEntries(['production-consumed', 'test-only', 'local-only', 'zero-use'].map((classification) => [classification, remaining.filter((item) => item.classification === classification).length]))).toEqual({
      'production-consumed': 1125, 'test-only': 118, 'local-only': 331, 'zero-use': 165,
    });
    expect(result.staleImports).toBe(5);
    expect(result.unsupported).toBe(0);
    expect(result.failures.filter((failure) => failure.category === 'stale-import').map(({ module, export: name }) => `${module}::${name}`)).toEqual([
      'src/persistence/authored-record-files.ts::AuthoredRecordNotFoundError',
      'src/persistence/layout.ts::cardConversationVersionIndexFile',
      'src/runtime/actors/llm-actor.ts::LLMProviderPort',
      'src/runtime/actors/llm-invocation.ts::CanonicalLlmInvocationInput',
      'src/runtime/process-runner.ts::ProcessRunner',
    ]);

    const sfcReclassified = [
      'web/src/components/nav/types.ts::NavItem',
      'web/src/composables/useAgentTimeline.ts::useAgentTimeline',
      'web/src/composables/useCardBrowserReadModel.ts::useCardBrowserReadModel',
      'web/src/composables/useDashboardReadModel.ts::useDashboardReadModel',
      'web/src/composables/useSelectedConversation.ts::useSelectedConversation',
      'web/src/stores/cards.ts::cardRouteChain',
      'web/src/stores/cards.ts::CardTreeNode',
      'web/src/stores/cards.ts::ChildrenLoadState',
      'web/src/stores/files.ts::useFileStore',
      'web/src/stores/mcp.ts::useMcpStore',
      'web/src/stores/runtime-read-model.ts::selectSocketDetail',
      'web/src/stores/runtime-read-model.ts::selectSocketLabel',
      'web/src/utils/agent-timeline/index.ts::AgentTimeline',
      'web/src/utils/auth-events.ts::API_AUTH_REQUIRED_EVENT',
      'web/src/utils/format-json.ts::formatJson',
      'web/src/utils/highlight.ts::highlight',
      'web/src/utils/sanitize-card-history.ts::sanitizeCardHistoryValue',
      'web/src/utils/status.ts::labelForCardType',
      'web/src/utils/status.ts::statusForCard',
      'web/src/utils/timestamp.ts::formatRecentTimestamp',
      'web/src/utils/timestamp.ts::formatTimestamp',
      'web/src/utils/timestamp.ts::timestampTitle',
      'web/src/utils/tool-friendly.ts::buildToolDisplay',
      'web/src/utils/tool-friendly.ts::ToolDisplayModel',
      'web/src/utils/agent-timeline/index.ts::ToolGroup',
      'web/src/utils/agent-timeline/index.ts::ToolListItem',
    ];
    expect(sfcReclassified).toHaveLength(26);
    for (const key of sfcReclassified) {
      const separator = key.lastIndexOf('::');
      const item = record(result, key.slice(0, separator), key.slice(separator + 2));
      expect(item).toBeDefined();
      expect(item.classification).toBe('production-consumed');
      expect(item.productionLocations.some((location) => location.startsWith('web/src/') && location.includes('.vue:'))).toBe(true);
    }
    for (const view of ['DashboardView.vue', 'CardsView.vue', 'AgentsView.vue', 'FilesView.vue', 'DebugView.vue', 'NotFound.vue']) {
      expect(record(result, `web/src/views/${view}`, 'default').classification).toBe('production-consumed');
    }
    expect(record(result, 'web/src/components/debug/AgentsPanel.vue', 'AgentDebugKind').classification).toBe('production-consumed');
    for (const name of ['getChatEntries', 'sendChatMessage']) {
      const item = record(result, 'web/src/api/client.ts', name);
      expect(item.classification).toBe('production-consumed');
      expect(item.testLocations.some((location) => location.startsWith('tests/playwright/browser-client/chat-api-client-browser.spec.ts:'))).toBe(true);
    }
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    expect(packageJson.devDependencies['@vue/compiler-sfc']).toBe('3.5.34');
    expect(packageJson.devDependencies['source-map-js']).toBe('1.2.1');
    expect(packageJson.devDependencies['@vue/compiler-dom']).toBeUndefined();
    expect(readFileSync(path.join(repositoryRoot, 'scripts/check-export-consumers.js'), 'utf8')).not.toContain("from '@vue/compiler-dom'");
  });
});
