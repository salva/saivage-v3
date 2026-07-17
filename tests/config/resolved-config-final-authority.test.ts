import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { createResolvedConfigAuthority } from '../../src/config/resolved-config-authority.js';
import { loadEnvironment } from '../../src/config/environment.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('selected config authority', () => {
  it('reads and replaces only the selected path while preserving raw interpolation placeholders', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-authority-'));
    roots.push(root);
    const selected = join(root, 'selected.yaml');
    const ignored = join(root, 'ignored.yaml');
    const source = 'models:\n  default: ["${MODEL}"]\n  max_tokens:\n    analyst: 200\nproviders:\n  p:\n    models: ["${MODEL}"]\n    apiKey: "${KEY}"\ncompaction:\n  enabled: true\n  input_budget_tokens: 1000\n  summarizer_candidate:\n    provider: p\n    account: null\n    model: "${MODEL}"\nserver:\n  port: 8080\n';
    writeFileSync(selected, source);
    writeFileSync(ignored, YAML.stringify({ models: { default: ['ignored'] }, server: { port: 9000 } }));
    const authority = createResolvedConfigAuthority({ path: selected, source: { kind: 'cli', argument: '--config' }, interpolationEnvironment: { MODEL: 'm1', KEY: 'secret' } });
    expect(authority.loadEffective().config.models.default).toEqual(['m1']);
    expect(authority.applyChange({ kind: 'set_server_setting', key: 'port', value: 8181 })).toMatchObject({ success: true, requires_restart: true });
    expect(readFileSync(selected, 'utf8')).toContain('${MODEL}');
    expect(readFileSync(selected, 'utf8')).toContain('${KEY}');
    expect(YAML.parse(readFileSync(selected, 'utf8')).server.port).toBe(8181);
    expect(YAML.parse(readFileSync(ignored, 'utf8')).server.port).toBe(9000);
  });

  it('fails directly when the selected path disappears and does not fall back', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-authority-'));
    roots.push(root);
    const selected = join(root, 'selected.yaml');
    writeFileSync(selected, YAML.stringify({ models: { default: ['m1'] } }));
    const authority = createResolvedConfigAuthority({ path: selected, source: { kind: 'environment', variable: 'SAIVAGE_CONFIG' }, interpolationEnvironment: {} });
    rmSync(selected);
    expect(() => authority.loadEffective()).toThrow(selected);
  });

  it('rejects reconfiguration through the full schema without replacing an invalid selected file', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-authority-'));
    roots.push(root);
    const selected = join(root, 'selected.yaml');
    const source = YAML.stringify({
      models: { default: ['m1'], max_tokens: { analyst: 201 } },
      providers: { p: { models: ['m1'] } },
      compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'p', account: null, model: 'm1' } },
      server: { port: 8080 },
    });
    writeFileSync(selected, source);
    const authority = createResolvedConfigAuthority({ path: selected, source: { kind: 'cli', argument: '--config' }, interpolationEnvironment: {} });

    expect(authority.applyChange({ kind: 'set_server_setting', key: 'port', value: 8181 })).toEqual({
      success: false,
      fieldPath: 'models/max_tokens/analyst',
      message: expect.stringContaining('Effective Analyst max tokens 201 (source: analyst) exceed reserved completion tokens 200'),
    });
    expect(readFileSync(selected, 'utf8')).toBe(source);
  });

  it('does not synthesize a selected configuration for --create-runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-authority-'));
    roots.push(root);
    await expect(loadEnvironment(['node', 'test', 'start', '--project-root', root, '--create-runtime'], {})).rejects.toMatchObject({ field: 'config' });
    expect(() => readFileSync(join(root, '.saivage', 'saivage.yaml'))).toThrow();
  });
});
