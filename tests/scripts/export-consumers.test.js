import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exportConsumerModule from '../../scripts/check-export-consumers.js';

const { checkExportConsumers } = exportConsumerModule;

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
  it('exports only the fixed complete checker and rejects every CLI scope selector', () => {
    expect(Object.keys(exportConsumerModule)).toEqual(['checkExportConsumers']);
    const checkerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check-export-consumers.js');
    const checkerSource = readFileSync(checkerPath, 'utf8');
    expect(checkerSource).not.toMatch(/node:vm|SourceTextModule/);
    expect(checkerSource).not.toMatch(/\bcomplete\s*[=:]/);
    const help = execFileSync(process.execPath, [checkerPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('fixed complete repository export boundary');
    for (const argument of ['--scope=phase-one', '--phase-one', '--complete', '--root']) {
      expect(() => execFileSync(process.execPath, [checkerPath, argument], { stdio: 'pipe' })).toThrow();
    }
    const current = fixture({
      'src/contracts/a.ts': 'export const contract = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/runtime/c.ts': 'export const runtime = 1;\n',
    });
    const result = checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
    expect(result.ownership.candidateFiles).toEqual(['src/contracts/a.ts', 'src/runtime/c.ts', 'src/schemas/b.ts', 'web/src/fixture.ts']);
    current.close();
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
      'src/consumer.ts': "import { schema } from './schemas/b.js'; void schema;\n",
      'tests/reflection.test.ts': [
        "import * as contracts from '../src/contracts/a.js';",
        "// exact reflective evidence: src/contracts/a.ts entry",
        "void Object.keys(contracts).includes('entry');",
      ].join('\n'),
    }, [{
      module: 'src/contracts/a.ts', export: 'entry', kind: 'reflective-consumer', consumer: 'tests/reflection.test.ts', reason: 'Exact external reflection intentionally observes this named export',
    }]);
    expect(reflective.failures).toEqual([]);

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

describe('complete export analysis', () => {
  it('adds inferred ordinary declaration dependencies from whole live contracts but not dead outers', () => {
    const result = runFixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/hidden.ts': [
        'export interface Hidden { value: string }',
        'export function makeHidden() { return { value: "hidden" } as Hidden; }',
        'export interface DeadHidden { dead: true }',
        'export function makeDeadHidden() { return { dead: true } as DeadHidden; }',
        'export type Constraint = { id: string };',
        'export class Base {}',
      ].join('\n'),
      'src/handler-context.ts': 'export type Handler<K extends string> = (kind: K) => void; export function makeHandler<K extends string>(kind: K) { return ((_value: K) => void kind) as Handler<K>; }\n',
      'src/service.ts': [
        'import { makeHidden } from "./hidden.js";',
        'import { makeHandler } from "./handler-context.js";',
        'export class Service { public read() { return makeHidden(); } }',
        'export class MultiMember { public first() { return makeHidden(); } public second() { return makeHidden(); } }',
        'export function buildHandlers() { return { run: makeHandler("run") }; }',
      ].join('\n'),
      'src/whole-contract.ts': [
        'import { makeHidden, type Constraint, Base } from "./hidden.js";',
        'export class Whole<T extends Constraint = Constraint> extends Base {',
        '  constructor(public value = makeHidden()) { super(); }',
        '  protected cached = makeHidden();',
        '  public unused() { return makeHidden(); }',
        '  private privateExplicit: Constraint = { id: "private" };',
        '}',
        'export interface WholeInterface<T extends Constraint = Constraint> { unused(): ReturnType<typeof makeHidden>; }',
        'export type WholeAlias<T extends Constraint = Constraint> = { value: ReturnType<typeof makeHidden>; nested: T };',
        'export const wholeObject = { unused: () => makeHidden() };',
        'export function overloaded(value: string): ReturnType<typeof makeHidden>;',
        'export function overloaded(value: number): ReturnType<typeof makeHidden>;',
        'export function overloaded() { return makeHidden(); }',
      ].join('\n'),
      'src/dead.ts': 'import { makeDeadHidden } from "./hidden.js"; export function DeadOuter() { return makeDeadHidden(); }\n',
      'src/consumer.ts': 'import { Service, MultiMember, buildHandlers } from "./service.js"; import { Whole, type WholeInterface, type WholeAlias, wholeObject, overloaded } from "./whole-contract.js"; void [new Service(), MultiMember, buildHandlers(), Whole, wholeObject, overloaded]; type Keep = WholeInterface | WholeAlias; void (null as unknown as Keep);\n',
    });

    for (const name of ['Hidden', 'Constraint', 'Base']) expect(record(result, 'src/hidden.ts', name).classification).toBe('production-consumed');
    expect(record(result, 'src/handler-context.ts', 'Handler').classification).toBe('production-consumed');
    expect(record(result, 'src/hidden.ts', 'DeadHidden').classification).toBe('local-only');
    expect(record(result, 'src/service.ts', 'Service').declarationPaths).toEqual([]);
    expect(record(result, 'src/hidden.ts', 'Hidden').declarationPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        seed: { module: 'src/service.ts', export: 'Service', classification: 'production-consumed' },
        edges: expect.arrayContaining([expect.objectContaining({
          sourceSurface: { module: 'src/service.ts', export: 'Service' },
          targetSurface: { module: 'src/hidden.ts', export: 'Hidden' },
          memberPath: expect.stringContaining('method:read'),
        })]),
      }),
    ]));
    expect(record(result, 'src/handler-context.ts', 'Handler').declarationPaths.some((item) => item.seed.export === 'buildHandlers')).toBe(true);
    const multiMemberPaths = record(result, 'src/hidden.ts', 'Hidden').declarationPaths
      .filter((item) => item.seed.module === 'src/service.ts' && item.seed.export === 'MultiMember');
    expect(multiMemberPaths).toHaveLength(2);
    expect(multiMemberPaths.map((item) => item.edges[0].memberPath)).toEqual([
      expect.stringContaining('method:first'),
      expect.stringContaining('method:second'),
    ]);
    expect(multiMemberPaths.every((item) => item.edges[0].sourceSurface.export === 'MultiMember' && item.edges[0].targetSurface.export === 'Hidden')).toBe(true);
  });

  it('keeps explicit source references direct in every declaration context', () => {
    const result = runFixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/target.ts': 'export interface Target { value: string } export interface SignatureOnly { dead: true } export class SignatureAndBody {}\n',
      'src/contexts.ts': [
        'import { type Target, type SignatureOnly, SignatureAndBody } from "./target.js";',
        'export type ExportedAlias = Target;',
        'type LocalAlias = Target;',
        'export interface ExportedInterface { value: Target }',
        'interface LocalInterface { value: Target }',
        'export function signature(value: Target): Target { return value; }',
        'function localSignature(value: Target): Target { return value; }',
        'export class Contexts { public value!: Target; protected kept!: Target; private hidden!: Target; }',
        'const initialized: Target = { value: "x" };',
        'export function deadSignature(value: SignatureOnly): void { void value; }',
        'export function signatureAndBody(value: SignatureAndBody): SignatureAndBody { return value ?? new SignatureAndBody(); }',
        'void [null as unknown as LocalAlias, null as unknown as LocalInterface, localSignature, initialized];',
      ].join('\n'),
      'src/consumer.ts': 'import { Contexts } from "./contexts.js"; void Contexts;\n',
    });
    const target = record(result, 'src/target.ts', 'Target');
    expect(target.directClassification).toBe('production-consumed');
    expect(target.productionLocations.length).toBeGreaterThanOrEqual(9);
    expect(record(result, 'src/target.ts', 'SignatureOnly').directClassification).toBe('production-consumed');
    expect(record(result, 'src/target.ts', 'SignatureAndBody').productionLocations.length).toBeGreaterThanOrEqual(3);
  });

  it('retains exact barrel routes, aliases, cycles, same-module support, and production precedence', () => {
    const files = {
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/target.ts': 'export interface Target { value: string } export interface TestTarget { test: true } export function makeTestTarget() { return { test: true } as TestTarget; } export default class DefaultTarget {}\n',
      'src/a.ts': 'export { Target } from "./target.js";\n',
      'src/b.ts': 'export { Target } from "./target.js";\n',
      'src/factory.ts': 'import type DefaultTarget, { Target as Named } from "./target.js"; export function named(): Named { return { value: "x" }; } export function defaulted(): DefaultTarget { return null as unknown as DefaultTarget; }\n',
      'src/service.ts': 'import { named } from "./factory.js"; type LocalSupport = ReturnType<typeof named>; export { LocalSupport }; export class Service { public cached!: LocalSupport; unused() { return named(); } }\n',
      'src/test-service.ts': 'import { makeTestTarget } from "./target.js"; export class TestService { unused() { return makeTestTarget(); } }\n',
      'src/cycle-a.ts': 'import type { CycleB } from "./cycle-b.js"; export interface CycleA { b: CycleB } export interface SelfCycle { self: SelfCycle }\n',
      'src/cycle-b.ts': 'import type { CycleA } from "./cycle-a.js"; export interface CycleB { a: CycleA }\n',
      'src/consumer.ts': 'import { Target as ATarget } from "./a.js"; import { Target as BTarget } from "./b.js"; import { Service } from "./service.js"; import type { CycleA, SelfCycle } from "./cycle-a.js"; void [null as unknown as ATarget, null as unknown as BTarget, Service, null as unknown as CycleA, null as unknown as SelfCycle];\n',
      'tests/target.test.ts': 'import type { Target } from "../src/target.js"; void (null as unknown as Target);\n',
      'tests/test-service.test.ts': 'import { TestService } from "../src/test-service.js"; void TestService;\n',
    };
    const result = runFixture(files);
    const repeated = runFixture(files);
    for (const module of ['src/target.ts', 'src/a.ts', 'src/b.ts']) expect(record(result, module, 'Target').classification).toBe('production-consumed');
    const target = record(result, 'src/target.ts', 'Target');
    expect(target.testLocations).toEqual([expect.stringMatching(/^tests\/target\.test\.ts:/)]);
    expect(target.declarationPaths.some((item) => item.seed.module === 'src/service.ts' && item.seed.export === 'Service')).toBe(true);
    expect(record(result, 'src/service.ts', 'LocalSupport').classification).toBe('local-only');
    expect(record(result, 'src/target.ts', 'TestTarget').classification).toBe('test-only');
    expect(record(result, 'src/cycle-a.ts', 'CycleA').declarationPaths.length).toBeGreaterThan(0);
    expect(record(result, 'src/cycle-b.ts', 'CycleB').declarationPaths.length).toBeGreaterThan(0);
    expect(record(result, 'src/cycle-a.ts', 'SelfCycle').classification).toBe('production-consumed');
    for (const item of result.records) {
      const paths = item.declarationPaths.map((declarationPath) => JSON.stringify(declarationPath));
      expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    }
    expect(repeated.records.map((item) => item.declarationPaths)).toEqual(result.records.map((item) => item.declarationPaths));
  });

  it('retains both distinct declaration paths when branches converge on one target', () => {
    const result = runFixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/deep.ts': 'export interface Deep { value: string } export function makeDeep() { return { value: "deep" } as Deep; }\n',
      'src/converged.ts': 'import { makeDeep } from "./deep.js"; export class Converged { deep() { return makeDeep(); } } export function makeConverged() { return new Converged(); }\n',
      'src/left.ts': 'import { makeConverged } from "./converged.js"; export class Left { result() { return makeConverged(); } }\n',
      'src/right.ts': 'import { makeConverged } from "./converged.js"; export class Right { result() { return makeConverged(); } }\n',
      'src/root.ts': 'import { Left } from "./left.js"; import { Right } from "./right.js"; export class Root { public left = new Left(); public right = new Right(); }\n',
      'src/consumer.ts': 'import { Root } from "./root.js"; void Root;\n',
    });
    const converged = record(result, 'src/converged.ts', 'Converged');
    const rootPaths = converged.declarationPaths.filter((item) => item.seed.module === 'src/root.ts' && item.seed.export === 'Root');
    expect(rootPaths).toHaveLength(2);
    expect(rootPaths.map((item) => item.edges.map((edge) => `${edge.sourceSurface.module}->${edge.targetSurface.module}`))).toEqual([
      ['src/root.ts->src/left.ts', 'src/left.ts->src/converged.ts'],
      ['src/root.ts->src/right.ts', 'src/right.ts->src/converged.ts'],
    ]);
    expect(new Set(rootPaths.map((item) => JSON.stringify(item))).size).toBe(2);
    const downstreamRootPaths = record(result, 'src/deep.ts', 'Deep').declarationPaths
      .filter((item) => item.seed.module === 'src/root.ts' && item.seed.export === 'Root');
    expect(downstreamRootPaths).toHaveLength(1);
  });

  it('attributes ordinary candidate TS4023, TS4053, and TS4058 declaration failures', () => {
    const result = runFixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/private-factory.ts': 'const privateKey: unique symbol = Symbol("private"); export function makePrivate() { return { [privateKey]: true }; }\n',
      'src/variable.ts': 'import { makePrivate } from "./private-factory.js"; export const exposedVariable = makePrivate();\n',
      'src/method.ts': 'import { makePrivate } from "./private-factory.js"; export class ExposedClass { method() { return makePrivate(); } }\n',
      'src/function.ts': 'import { makePrivate } from "./private-factory.js"; export function exposedFunction() { return makePrivate(); }\n',
      'tests/unrelated.test.ts': 'const invalid: string = 1; void invalid;\n',
    });
    const diagnostics = result.failures.filter((item) => item.category === 'declaration-diagnostic');
    expect(diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^TS4023:/),
      expect.stringMatching(/^TS4053:/),
      expect.stringMatching(/^TS4058:/),
    ]));
    expect(diagnostics.every((item) => !item.module.startsWith('tests/'))).toBe(true);
  });

  it('reports fileless global errors under deterministic context keys and never writes declaration output', () => {
    const current = fixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export const schema = 1;\n',
      'src/owner.ts': 'export const value = 1;\n',
    });
    try {
      const config = JSON.parse(readFileSync(path.join(current.root, 'tsconfig.json'), 'utf8'));
      config.compilerOptions.noLib = true;
      config.compilerOptions.checkJs = true;
      write(current.root, 'tsconfig.json', JSON.stringify(config));
      const before = readdirSync(current.root, { recursive: true }).map(String).sort();
      const first = checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      const second = checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      const after = readdirSync(current.root, { recursive: true }).map(String).sort();
      const contextFailures = first.failures.filter((item) => item.category === 'declaration-diagnostic' && item.module === '@declaration-context/root');
      expect(contextFailures.length).toBeGreaterThan(0);
      expect(contextFailures.every((item) => item.consumer === '@declaration-context/root')).toBe(true);
      expect(second.failures).toEqual(first.failures);
      expect(after).toEqual(before);
    } finally {
      current.close();
    }
  });

  it('keeps SFCs semantic-only while ordinary web candidates resolve them as declaration targets', () => {
    const result = runFixture({
      'src/contracts/phase.ts': 'export const phase = 1;\n',
      'src/schemas/schema.ts': 'export interface Prop { value: string }\n',
      'web/src/Child.vue': '<script lang="ts">export type ChildKind = "child";</script><script setup lang="ts">import type { Prop } from "../../src/schemas/schema.js"; const props = defineProps<Prop>(); const maybe: { value: string } | null = null;</script><template><span>{{ props.value }} {{ maybe.value }}</span></template>\n',
      'web/src/Host.vue': '<script setup lang="ts">import Child from "./Child.vue";</script><template><Child/></template>\n',
      'web/src/component-owner.ts': 'import Child from "./Child.vue"; export type ChildComponent = typeof Child; export const childComponent: ChildComponent = Child;\n',
      'web/src/consumer.ts': 'import { childComponent, type ChildComponent } from "./component-owner"; void childComponent; void (null as unknown as ChildComponent);\n',
    });
    expect(record(result, 'web/src/Child.vue', 'default').classification).toBe('production-consumed');
    expect(record(result, 'web/src/Child.vue', 'ChildKind')).toBeDefined();
    expect(record(result, 'web/src/Child.vue', 'default').declarationPaths.some((item) => item.seed.module === 'web/src/component-owner.ts')).toBe(true);
    expect(record(result, 'src/schemas/schema.ts', 'Prop').productionLocations.some((item) => item.startsWith('web/src/Child.vue:'))).toBe(true);
    expect(result.ownership.declarationUnitFiles.some((file) => file.endsWith('.vue'))).toBe(false);
    expect(result.records.flatMap((item) => item.declarationPaths).flatMap((item) => item.edges).some((edge) => edge.sourceSurface.module.endsWith('.vue'))).toBe(false);
    expect(result.failures.filter((item) => item.category === 'declaration-diagnostic' && item.consumer.includes('.vue'))).toEqual([]);
  });

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
      const result = checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      expect(result.ownership.candidateFiles).toEqual(expect.arrayContaining([
        'src/owner.ts', 'src/owner.tsx', 'src/owner.mts', 'src/owner.cts', 'src/consumer.d.tsx', 'web/src/Widget.vue',
      ]));
      expect(result.ownership.candidateFiles).not.toEqual(expect.arrayContaining([
        'src/owner.d.ts', 'src/owner.d.mts', 'src/owner.d.cts', 'src/owner.test.ts', 'web/src/Widget.test.vue', 'web/src/Widget.spec.vue', 'web/src/__tests__/Widget.vue',
      ]));
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
    const result = runFixture({
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
      const result = runFixture({
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
    const result = runFixture({
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
      const result = checkExportConsumers({ root: current.root, trackedFiles: current.trackedFiles });
      expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: '/src/api/client.ts' }));
    } finally {
      current.close();
    }
  });

  it('uses exact explicit SFC lazy defaults, not bare imports, and fails malformed SFCs', () => {
    const explicit = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Widget.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/router.ts': 'const load = () => import("./Widget.vue").then((module) => module.default); void load;\n',
    });
    expect(record(explicit, 'web/src/Widget.vue', 'default').classification).toBe('production-consumed');

    const bare = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Widget.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/router.ts': 'const load = () => import("./Widget.vue"); void load;\n',
    });
    expect(record(bare, 'web/src/Widget.vue', 'default').classification).toBe('zero-use');

    const malformed = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Broken.vue': '<template src="./elsewhere.html"/><script setup lang="js">export const bad = 1;</script>\n',
    });
    expect(malformed.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'web/src/Broken.vue' }));
  });

  it('composes ordinary/setup/template SFC semantics with exact bindings and canonical source locations', () => {
    const result = runFixture({
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
    const result = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/Broken.vue': source,
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported', module: 'web/src/Broken.vue' }));
  });

  it('maps clean-tree dist JS imports and keeps symbol use binding-aware', () => {
    const result = runFixture({
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
    const result = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'src/owner.ts': 'export default 1; export const value = 2;\n',
      'tests/unsupported.js': source,
    });
    expect(result.failures).toContainEqual(expect.objectContaining({ category: 'unsupported' }));
  });

  it('treats the exact raw SFC glob as source-text loading without component consumption', () => {
    const result = runFixture({
      'src/contracts/a.ts': 'export const phase = 1;\n',
      'src/schemas/b.ts': 'export const schema = 1;\n',
      'web/src/components/debug/StatePanel.vue': '<script setup lang="ts">const value = 1; void value;</script>\n',
      'web/src/__tests__/raw.test.ts': "const sources = import.meta.glob('../components/debug/*Panel.vue', { eager: true, query: '?raw', import: 'default' }); void sources;\n",
    });
    expect(record(result, 'web/src/components/debug/StatePanel.vue', 'default').classification).toBe('zero-use');
    expect(result.failures.filter((failure) => failure.category === 'unsupported')).toEqual([]);
  });
});

describe('repository complete export boundary', () => {
  it('reproduces complete candidate/consumer parity and the cleanup-complete inventory', () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean);
    const result = checkExportConsumers({ root: repositoryRoot, trackedFiles: tracked });
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
    expect(result.ownership.declarationFiles).toEqual(['scripts/verify-doc-routes.d.ts', 'web/env.d.ts']);
    expect(result.ownership.typescriptOrdinaryFiles).toEqual(tsFamily.filter((file) => !declarations.includes(file)));
    expect(Object.fromEntries(['production-consumed', 'test-only', 'local-only', 'zero-use'].map((classification) => [classification, result.records.filter((item) => item.directClassification === classification).length]))).toEqual({
      'production-consumed': 1676, 'test-only': 204, 'local-only': 2, 'zero-use': 0,
    });
    expect(result.records).toHaveLength(1882);
    expect(result.totals).toEqual({ 'production-consumed': 1678, 'test-only': 204, 'local-only': 0, 'zero-use': 0 });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.staleImports).toBe(0);
    expect(result.unsupported).toBe(0);
    expect(result.allowlistEntries).toBe(0);
    expect(result.failures.filter((failure) => failure.category === 'declaration-diagnostic')).toEqual([]);
    expect(result.ownership.declarationUnitFiles).toHaveLength(339);
    expect(result.ownership.declarationUnitFiles.some((file) => file.endsWith('.vue'))).toBe(false);
    expect(result.records.flatMap((item) => item.declarationPaths).flatMap((item) => item.edges).some((edge) => edge.sourceSurface.module.endsWith('.vue'))).toBe(false);
    const promoted = result.records.filter((item) => item.classification !== item.directClassification);
    expect(promoted.map((item) => `${item.module}::${item.export}`)).toEqual([
      'src/application/read-models/agent-conversation-read-model.ts::FoldedConversation',
      'src/server/routes/operator-handler-context.ts::OperatorContractHandler',
    ]);
    expect(promoted[0].declarationPaths.length).toBeGreaterThan(0);
    expect(new Set(promoted[0].declarationPaths.map((item) => JSON.stringify(item.seed)))).toEqual(new Set([
      JSON.stringify({ module: 'src/application/read-models/agent-operator-read-model.ts', export: 'AgentOperatorReadModelService', classification: 'production-consumed' }),
    ]));
    expect([...new Set(promoted[1].declarationPaths.map((item) => `${item.seed.module}::${item.seed.export}`))]).toEqual([
      'src/server/routes/operator-agent-handlers.ts::buildAgentOperatorContractHandlers',
      'src/server/routes/operator-chat-handlers.ts::buildChatOperatorContractHandlers',
      'src/server/routes/operator-config-handlers.ts::buildConfigOperatorContractHandlers',
      'src/server/routes/operator-events-handlers.ts::buildEventsOperatorContractHandlers',
      'src/server/routes/operator-files-debug-handlers.ts::buildFilesDebugOperatorContractHandlers',
      'src/server/routes/operator-mcp-handlers.ts::buildMcpOperatorContractHandlers',
      'src/server/routes/operator-process-handlers.ts::buildProcessOperatorContractHandlers',
      'src/server/routes/operator-runtime-card-handlers.ts::buildRuntimeCardOperatorContractHandlers',
    ]);
    for (const item of promoted) {
      const identities = item.declarationPaths.map((declarationPath) => JSON.stringify(declarationPath));
      expect(new Set(identities).size).toBe(identities.length);
    }
    expect(result.records.filter((item) => item.directClassification === 'test-only' && item.classification === 'production-consumed')).toEqual([]);

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
