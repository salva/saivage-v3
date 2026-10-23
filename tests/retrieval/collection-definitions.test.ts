import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observedCollectionsSchema, observedDeploymentSchema, readObservedCollections, readObservedDeployment, readXerjKey,
  XERJ_BINARY_SHA256, XERJ_MODEL_FILES, XERJ_MODEL_REVISION, XERJ_SOURCE } from '../../src/retrieval/collection-definitions.js';

const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'observed-definitions-')); roots.push(p); mkdirSync(join(p, '.saivage/config'), { recursive: true }); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const collection = { name: 'skills', purpose: 'Read relevant methods', kind: 'documentation', directory: '.github/skills', include: ['**/*.md'], exclude: [] };
const definitions = () => ({ format_version: 1, type: 'observed-collections', collections: [collection] });

describe('observed input contracts', () => {
  it('distinguishes disabled absent inputs from malformed present definitions', () => {
    const p = root();
    expect(readObservedCollections(p)).toBeNull();
    writeFileSync(join(p, '.saivage/config/observed-collections.json'), JSON.stringify(definitions()));
    expect(readObservedCollections(p)?.collections[0]?.directory).toBe('.github/skills');
    writeFileSync(join(p, '.saivage/config/observed-collections.json'), '{');
    expect(() => readObservedCollections(p)).toThrow('Invalid observed collection definitions.');
    expect(() => readObservedDeployment(p)).toThrow('Invalid or missing observed collection deployment.');
  });

  it('rejects version drift, duplicate identities, unknown keys and unsupported patterns', () => {
    expect(observedCollectionsSchema.safeParse({ ...definitions(), format_version: 2 }).success).toBe(false);
    expect(observedCollectionsSchema.safeParse({ ...definitions(), extra: true }).success).toBe(false);
    expect(observedCollectionsSchema.safeParse({ ...definitions(), collections: [collection, collection] }).success).toBe(false);
    for (const pattern of ['../a', '/a', '!a', 'a/**b', '[ab]', 'a?', 'a//b', 'a\\b', '(a|b)']) {
      expect(observedCollectionsSchema.safeParse({ ...definitions(), collections: [{ ...collection, include: [pattern] }] }).success).toBe(false);
    }
    expect(observedCollectionsSchema.safeParse({ ...definitions(), collections: [{ ...collection, purpose: 'é'.repeat(513) }] }).success).toBe(false);
  });

  it('has one strict private deployment contract without concrete index or credential fields', () => {
    const value = { format_version: 1, type: 'xerj-observed-deployment', endpoint: 'http://127.0.0.1:19880',
      native: { executable: '/opt/xerj/bin/xerj', source: XERJ_SOURCE, sha256: XERJ_BINARY_SHA256 },
      model: { revision: XERJ_MODEL_REVISION, directory: '/opt/xerj/model', mode: 'neural', dimensions: 384, files: XERJ_MODEL_FILES },
      roots: [{ directory: '.github/skills', prefix: `sv-${'a'.repeat(32)}` }] };
    expect(observedDeploymentSchema.parse(value)).toEqual(value);
    for (const endpoint of ['http://localhost:19880', 'http://example.com:80', 'http://secret@127.0.0.1:19880', 'http://127.0.0.1:19880/?key=x']) {
      expect(observedDeploymentSchema.safeParse({ ...value, endpoint }).success).toBe(false);
    }
    expect(observedDeploymentSchema.safeParse({ ...value, destinations: ['guessed-docs'] }).success).toBe(false);
    expect(observedDeploymentSchema.safeParse({ ...value, token: 'not-allowed' }).success).toBe(false);
  });

  it('reads only the fixed bounded raw credential and never includes it in failures', () => {
    const p = root(); const file = join(p, '.saivage/config/xerj.key');
    writeFileSync(file, 'synthetic-key\n'); expect(readXerjKey(p)).toBe('synthetic-key');
    for (const token of ['', 'secret value', 'secret\n\n', 'x'.repeat(4097)]) {
      writeFileSync(file, token);
      expect(() => readXerjKey(p)).toThrow('Invalid or missing observed collection credential.');
    }
  });
});
