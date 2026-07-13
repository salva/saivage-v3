import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';

import { loadEnvironment } from '../../src/config/environment.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { writeSaivageConfig } from '../helpers/project-config.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { createTestMutationComposition } from '../helpers/mutation-composition.js';
import { AnalystTurnCurrentness } from '../../src/application/mutation-authority.js';

const roots: string[] = [];
function root(): string { const value = mkdtempSync(join(tmpdir(), 'resolved-config-authority-')); roots.push(value); return value; }
function valid(port = 8080): string { return YAML.stringify({ models: { default: ['test-model'] }, providers: {}, server: { host: '127.0.0.1', port } }); }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('ResolvedConfigAuthority', () => {
  it('selects a CLI file once and routes reads and writes only to it', async () => {
    const projectRoot = root();
    writeSaivageConfig(projectRoot, YAML.stringify({ models: { default: ['test-model'] }, server: { port: 8001 }, mcpServers: { defaultServer: { transport: 'stdio', command: '/bin/false', disabled: true } } }));
    const custom = join(projectRoot, 'custom-cli.yaml');
    writeFileSync(custom, YAML.stringify({ models: { default: ['test-model'] }, server: { port: 8002 }, mcpServers: { selectedServer: { transport: 'stdio', command: '/bin/true', disabled: true } } }));
    const mutation = createTestMutationComposition();
    const environment = await loadEnvironment(['node', 'saivage', 'start', '--config', custom], { SAIVAGE_PROJECT_ROOT: projectRoot }, mutation);
    expect(environment.configAuthority.source).toEqual({ kind: 'cli', argument: '--config' });
    expect(environment.configAuthority.path).toBe(custom);
    environment.configAuthority.mutate(mutation.authority, { kind: 'set_server_setting', key: 'port', value: 8003 });
    const mcpManager = new McpManager({ configAuthority: environment.configAuthority, processRunner: createTestProcessRunner(projectRoot) });
    await mcpManager.reconcilePersistedConfig();
    expect(mcpManager.getStatus().map(({ name }) => name)).toEqual(['selectedServer']);
    expect(YAML.parse(readFileSync(custom, 'utf8')).server.port).toBe(8003);
    expect(YAML.parse(readFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), 'utf8')).server.port).toBe(8001);
  });

  it('selects SAIVAGE_CONFIG without probing or falling back to the default', async () => {
    const projectRoot = root();
    writeSaivageConfig(projectRoot, valid(8101));
    const selected = join(projectRoot, 'environment.yaml');
    writeFileSync(selected, valid(8102));
    const environment = await loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: projectRoot, SAIVAGE_CONFIG: selected }, createTestMutationComposition());
    expect(environment.configAuthority.source).toEqual({ kind: 'environment', variable: 'SAIVAGE_CONFIG' });
    rmSync(selected);
    expect(() => environment.configAuthority.loadEffective()).toThrow(selected);
  });

  it('creates only the selected missing canonical default for --create-runtime and preserves existing files', async () => {
    const projectRoot = root();
    initProjectTree(projectRoot);
    expect(existsSync(join(projectRoot, '.saivage', 'saivage.yaml'))).toBe(false);
    const selected = join(projectRoot, 'config', 'selected.yaml');
    const mutation = createTestMutationComposition();
    const environment = await loadEnvironment(['node', 'saivage', 'start', '--create-runtime', '--config', selected], { SAIVAGE_PROJECT_ROOT: projectRoot }, mutation);
    expect(environment.configAuthority.path).toBe(selected);
    expect(existsSync(selected)).toBe(true);
    expect(existsSync(join(projectRoot, '.saivage', 'saivage.yaml'))).toBe(false);
    const before = readFileSync(selected, 'utf8');
    environment.configAuthority.initializeCanonicalDefaultIfMissing(mutation.authority);
    expect(readFileSync(selected, 'utf8')).toBe(before);
  });

  it('captures interpolation and preserves raw placeholders across unrelated writes', async () => {
    const projectRoot = root();
    writeSaivageConfig(projectRoot, 'models:\n  default: ["${MODEL_NAME}"]\nproviders:\n  test:\n    apiKey: "${API_KEY}"\n    models: ["${MODEL_NAME}"]\nserver:\n  port: 8080\n');
    const startup = { SAIVAGE_PROJECT_ROOT: projectRoot, MODEL_NAME: 'model-at-start', API_KEY: 'key-at-start' };
    const mutation = createTestMutationComposition();
    const environment = await loadEnvironment(['node', 'saivage', 'start'], startup, mutation);
    startup.MODEL_NAME = 'model-later';
    const originalModelName = process.env.MODEL_NAME;
    process.env.MODEL_NAME = 'process-model-later';
    try {
      environment.configAuthority.mutate(mutation.authority, { kind: 'set_server_setting', key: 'port', value: 8181 });
      expect(environment.configAuthority.loadEffective().config.models.default).toEqual(['model-at-start']);
      const raw = readFileSync(environment.configAuthority.path, 'utf8');
      expect(raw).toContain('${MODEL_NAME}');
      expect(raw).toContain('${API_KEY}');
    } finally {
      if (originalModelName === undefined) delete process.env.MODEL_NAME;
      else process.env.MODEL_NAME = originalModelName;
    }
  });

  it('applies synchronous sequential mutations and continues after failed validation', async () => {
    const projectRoot = root();
    writeSaivageConfig(projectRoot, valid());
    const mutation = createTestMutationComposition();
    const environment = await loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: projectRoot }, mutation);
    expect(environment.configAuthority.mutate(mutation.authority, { kind: 'set_server_setting', key: 'port', value: 8201 }).success).toBe(true);
    expect(environment.configAuthority.mutate(mutation.authority, { kind: 'set_runtime_setting', key: 'max_review_retries', value: 7 }).success).toBe(true);
    expect(environment.configAuthority.mutate(mutation.authority, { kind: 'set_server_setting', key: 'port', value: -1 }).success).toBe(false);
    expect(environment.configAuthority.mutate(mutation.authority, { kind: 'set_runtime_setting', key: 'continuous_improvement', value: true }).success).toBe(true);
    const raw = YAML.parse(readFileSync(environment.configAuthority.path, 'utf8'));
    expect(raw.server.port).toBe(8201);
    expect(raw.runtime).toMatchObject({ max_review_retries: 7, continuous_improvement: true });
  });

  it('rejects a stale Analyst turn before changing the selected config bytes', async () => {
    const projectRoot = root();
    writeSaivageConfig(projectRoot, valid());
    const mutation = createTestMutationComposition();
    const environment = await loadEnvironment(['node', 'saivage', 'start'], { SAIVAGE_PROJECT_ROOT: projectRoot }, mutation);
    const turns = new AnalystTurnCurrentness();
    const authority = turns.begin();
    const before = readFileSync(environment.configAuthority.path);
    turns.clear(authority);

    expect(() => environment.configAuthority.mutate(authority, { kind: 'set_server_setting', key: 'port', value: 9000 })).toThrow(/authority is stale/);
    expect(readFileSync(environment.configAuthority.path)).toEqual(before);
  });
});
