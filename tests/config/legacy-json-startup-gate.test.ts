import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvironmentLoadError, loadEnvironment } from '../../src/config/environment.js';
import { writeSaivageConfig } from '../helpers/project-config.js';

const roots: string[] = [];
function makeRoot(): string { const r = mkdtempSync(join(tmpdir(), 'saivage-legacy-json-')); roots.push(r); mkdirSync(join(r, '.saivage'), { recursive: true }); return r; }
function writeLegacyJson(root: string, content = '{ invalid json with apiKey: "secret"'): void { writeFileSync(join(root, '.saivage', 'saivage.json'), content, 'utf-8'); }
function load(root: string, extraEnv: Record<string, string | undefined> = {}) { return loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: root, NODE_ENV: 'test', ...extraEnv }); }
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('legacy JSON startup gate', () => {
  it('requires rename when only obsolete JSON exists without parsing it', () => {
    const r = makeRoot();
    writeLegacyJson(r);
    expect(() => load(r)).toThrow(EnvironmentLoadError);
    expect(() => load(r)).toThrow(/rename/i);
    expect(() => load(r)).toThrow(/saivage\.json/);
    expect(() => load(r)).not.toThrow(/parse/i);
  });

  it('requires deleting obsolete JSON when both files exist before parsing YAML', () => {
    const r = makeRoot();
    writeSaivageConfig(r, 'models: [');
    writeLegacyJson(r, '{"providers":{"default":{"apiKey":"secret"}}}');
    expect(() => load(r)).toThrow(/obsolete/);
    expect(() => load(r)).toThrow(/delete/i);
    expect(() => load(r)).not.toThrow(/YAMLParseError|parse/i);
  });

  it('rejects the explicit obsolete config path even when absent', () => {
    const r = makeRoot();
    expect(() => load(r, { SAIVAGE_CONFIG: join(r, '.saivage', 'saivage.json') })).toThrow(/will not read or parse the old JSON path/);
  });

  it('does not let custom config bypass the project-wide obsolete JSON gate', () => {
    const r = makeRoot();
    const custom = join(r, 'custom.yaml');
    writeFileSync(custom, 'models: [', 'utf-8');
    writeLegacyJson(r);
    expect(() => load(r, { SAIVAGE_CONFIG: custom })).toThrow(/rename|obsolete/i);
  });

  it('allows custom config when the known legacy path is absent', () => {
    const r = makeRoot();
    const custom = join(r, 'custom.yaml');
    writeFileSync(custom, 'models:\n  default: [test-model]\n', 'utf-8');
    expect(load(r, { SAIVAGE_CONFIG: custom }).config.models.default).toEqual(['test-model']);
  });

  it('reports generic missing when neither canonical file exists', () => {
    const r = makeRoot();
    expect(() => load(r)).toThrow(/Configuration not found/);
  });

  it('loads normally when only YAML exists', () => {
    const r = makeRoot();
    writeSaivageConfig(r, { models: { default: ['test-model'] } });
    expect(load(r).config.models.default).toEqual(['test-model']);
  });
});
