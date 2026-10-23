import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XERJ_BINARY_SHA256, XERJ_MODEL_FILES } from '../../src/retrieval/collection-definitions.js';

// Only immutable dependency bytes are synthetic here. Prefix hashing stays real;
// the separately prepared native journey must verify the actual pinned assets.
const digests = new Map<string, string>([['fixture-executable', XERJ_BINARY_SHA256],
  ...Object.entries(XERJ_MODEL_FILES).map(([name, digest]) => [`fixture-${name}`, digest] as [string, string])]);
jest.unstable_mockModule('node:crypto', () => ({ ...crypto, createHash: (algorithm: string) => {
  const real = crypto.createHash(algorithm); let synthetic: string | undefined;
  return { update(value: string | Buffer) { synthetic = digests.get(value.toString()); real.update(value); return this; },
    digest(encoding: 'hex') { return synthetic ?? real.digest(encoding); } };
} }));
const { prepareObservedCollections } = await import('../../src/retrieval/xerj-deployment.js');
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'xerj-prepare-')); roots.push(base);
  const project = join(base, 'project'); const model = join(base, 'model'); const data = join(base, 'data');
  for (const path of [join(project, '.saivage/config'), join(project, 'docs'), join(project, '.github/skills'), model, data]) mkdirSync(path, { recursive: true });
  const executable = join(base, 'xerj'); writeFileSync(executable, 'fixture-executable');
  for (const name of Object.keys(XERJ_MODEL_FILES)) writeFileSync(join(model, name), `fixture-${name}`);
  const definitions = (directories: string[]) => writeFileSync(join(project, '.saivage/config/observed-collections.json'), JSON.stringify({
    format_version: 1, type: 'observed-collections', collections: directories.map((directory, i) => ({
      name: `view-${i}`, purpose: 'Useful sources', kind: 'documentation', directory, include: ['**/*.md'], exclude: [],
    })),
  }));
  definitions(['docs', 'docs', '.github/skills']);
  return { definitions, project, base, input: { projectRoot: project, output: join(base, "bundle ' % $"), executable,
    modelDirectory: model, dataDirectory: data, user: 'fixture', port: 19880, restPort: 19881, grpcPort: 19882 } };
}

describe('native deployment preparation', () => {
  it('coalesces roots, emits exact native argv without index guessing, and never reads a token', () => {
    const f = fixture(); const result = prepareObservedCollections(f.input);
    expect(result.roots).toBe(2);
    const commands = JSON.parse(readFileSync(join(result.output, 'commands.json'), 'utf8'));
    expect(commands.watchers).toHaveLength(2);
    for (const watcher of commands.watchers) {
      expect(watcher.argv[0]).toBe('/bin/sh');
      expect(watcher.native_argv).toEqual(expect.arrayContaining(['--watch', '--no-graph', '--no-default-ignores', '--code-analyzer', 'code']));
      expect(watcher.native_argv).not.toEqual(expect.arrayContaining(['--dry-run', '--no-ignore']));
      const unit = readFileSync(join(result.output, `${result.target.replace('-watchers.target', '')}-${watcher.prefix}.service`), 'utf8');
      expect(unit).toContain('BindsTo='); expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('%% $$');
    }
    const descriptor = JSON.parse(readFileSync(join(result.output, 'observed-collections-native.json'), 'utf8'));
    expect(descriptor.type).toBe('xerj-observed-deployment');
    expect(descriptor).not.toHaveProperty('destinations');
    expect(() => prepareObservedCollections(f.input)).toThrow();
  });

  it('keeps root prefixes stable across logical changes and rejects overlapping or private alias roots', () => {
    const f = fixture(); prepareObservedCollections(f.input);
    const first = JSON.parse(readFileSync(join(f.input.output, 'observed-collections-native.json'), 'utf8'));
    f.definitions(['docs']); const next = { ...f.input, output: join(f.base, 'second') }; prepareObservedCollections(next);
    const second = JSON.parse(readFileSync(join(next.output, 'observed-collections-native.json'), 'utf8'));
    expect(second.roots[0]).toEqual(first.roots.find((r: { directory: string }) => r.directory === 'docs'));
    f.definitions(['.', 'docs']); expect(() => prepareObservedCollections({ ...next, output: join(f.base, 'third') })).toThrow('overlap');
    symlinkSync(join(f.project, '.saivage'), join(f.project, 'ordinary-alias'));
    f.definitions(['ordinary-alias']); expect(() => prepareObservedCollections({ ...next, output: join(f.base, 'fourth') })).toThrow('Forbidden');
  });
});
