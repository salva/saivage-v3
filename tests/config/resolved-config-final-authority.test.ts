import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { createResolvedConfigAuthority } from '../../src/config/resolved-config-authority.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { effectiveSaivageConfigSchema, saivageConfigSchema } from '../../src/schemas/saivage-config.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('selected config authority', () => {
  const configWithMcp = (entry: unknown) => ({
    models: { default: ['m1'], max_tokens: { analyst: 200 } },
    providers: { p: { models: ['m1'] } },
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'p', account: null, model: 'm1' } },
    card_processes: DEFAULT_CARD_PROCESSES,
    mcpServers: { server: entry },
  });

  it('parses only strict transport-specific MCP variants and materializes lifecycle defaults', () => {
    const stdioConfig = saivageConfigSchema.parse(configWithMcp({ transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'value' } }));
    expect(stdioConfig.mcpServers?.server).toEqual({
      transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'value' }, disabled: false, autostart: true,
    });
    expect(effectiveSaivageConfigSchema.parse(stdioConfig)).toEqual(stdioConfig);
    for (const url of ['http://localhost/mcp', 'https://example.com/mcp']) {
      const httpConfig = saivageConfigSchema.parse(configWithMcp({ transport: 'streamable-http', url }));
      expect(httpConfig.mcpServers?.server).toEqual({
        transport: 'streamable-http', url, disabled: false, autostart: true,
      });
      expect(effectiveSaivageConfigSchema.parse(httpConfig)).toEqual(httpConfig);
    }

    const invalidEntries = [
      { transport: 'stdio' },
      { transport: 'stdio', command: '' },
      { transport: 'stdio', command: 'node', url: 'https://example.com/mcp' },
      { transport: 'streamable-http' },
      { transport: 'streamable-http', url: 'relative/path' },
      { transport: 'streamable-http', url: 'not a url' },
      { transport: 'streamable-http', url: 'file:///tmp/mcp' },
      { transport: 'streamable-http', url: 'https://example.com/mcp', command: 'node' },
      { transport: 'streamable-http', url: 'https://example.com/mcp', args: [] },
      { transport: 'streamable-http', url: 'https://example.com/mcp', env: {} },
      { transport: 'streamable-http', url: 'https://example.com/mcp', extra: true },
    ];
    for (const entry of invalidEntries) expect(saivageConfigSchema.safeParse(configWithMcp(entry)).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, mcpServers: { server: { transport: 'stdio', command: 'node' } } }).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, mcpServers: { server: { transport: 'streamable-http', url: 'https://example.test', command: 'node', disabled: false, autostart: true } } }).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, runtime: { continuous_improvement: false, process_timeouts: {} } }).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, server: { port: 8080 } }).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, models: { ...stdioConfig.models, default: 'm1' } }).success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({ ...stdioConfig, models: { ...stdioConfig.models, profiles: { profile: { preferred: [] } } } }).success).toBe(false);
    const missingCompactionDefault = structuredClone(stdioConfig);
    delete (missingCompactionDefault.compaction as Partial<typeof missingCompactionDefault.compaction>).trigger_fraction;
    expect(effectiveSaivageConfigSchema.safeParse(missingCompactionDefault).success).toBe(false);
  });

  it('reads and replaces only the selected path while preserving raw interpolation placeholders', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-authority-'));
    roots.push(root);
    const selected = join(root, 'selected.yaml');
    const ignored = join(root, 'ignored.yaml');
    const source = YAML.stringify({
      models: { default: ['${MODEL}'], max_tokens: { analyst: 200 } },
      providers: { p: { models: ['${MODEL}'], apiKey: '${KEY}' } },
      compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'p', account: null, model: '${MODEL}' } },
      card_processes: DEFAULT_CARD_PROCESSES,
      server: { port: 8080 },
    });
    writeFileSync(selected, source);
    writeFileSync(ignored, YAML.stringify({ models: { default: ['ignored'] }, server: { port: 9000 } }));
    const authority = createResolvedConfigAuthority({ path: selected, source: { kind: 'cli', argument: '--config' }, interpolationEnvironment: { MODEL: 'm1', KEY: 'secret' } });
    const loaded = authority.loadEffective().config;
    expect(loaded.models.default).toEqual(['m1']);
    expect(effectiveSaivageConfigSchema.parse(loaded)).toEqual(loaded);
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
      card_processes: DEFAULT_CARD_PROCESSES,
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
