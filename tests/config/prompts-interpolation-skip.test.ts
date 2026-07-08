import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { interpolateValue } from '../../src/config/env-interpolation.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { writeSaivageConfig } from '../helpers/project-config.js';

const roots: string[] = [];
function root(): string { const r = mkdtempSync(join(tmpdir(), 'saivage-prompts-skip-')); roots.push(r); return r; }
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('top-level prompts interpolation skip', () => {
  it('preserves prompt env syntax verbatim while interpolating elsewhere', () => {
    const r = root();
    writeSaivageConfig(r, `models:\n  default: ["${'${TEST_MODEL}'}"]\n  prompts: ["${'${MODEL_ROLE_VAR}'}"]\nproviders:\n  default:\n    apiKey: "${'${TEST_API_KEY}'}"\n    models: ["${'${TEST_MODEL}'}"]\nmcpServers:\n  foo:\n    transport: stdio\n    command: node\n    env:\n      prompts: "${'${MCP_PROMPT_VAR}'}"\nprompts:\n  planner: |\n    Home is ${'${HOME}'}\n    Token is ${'${SAIVAGE_API_TOKEN}'}\n    Unknown is ${'${UNKNOWN_PROMPT_VAR}'}\n`);
    const env = loadEnvironment(['node', 'saivage', 'start'], {
      SAIVAGE_PROJECT_ROOT: r,
      HOME: '/secret-home',
      SAIVAGE_API_TOKEN: 'secret-token',
      TEST_MODEL: 'model-a',
      TEST_API_KEY: 'key-a',
      MODEL_ROLE_VAR: 'model-role-a',
      MCP_PROMPT_VAR: 'mcp-a',
      NODE_ENV: 'test',
    });
    expect(env.config.prompts?.planner).toContain('${HOME}');
    expect(env.config.prompts?.planner).toContain('${SAIVAGE_API_TOKEN}');
    expect(env.config.prompts?.planner).toContain('${UNKNOWN_PROMPT_VAR}');
    expect(env.config.prompts?.planner).not.toContain('/secret-home');
    expect(env.config.prompts?.planner).not.toContain('secret-token');
    expect(env.configWarnings).toEqual([]);
    expect(env.config.models.default).toEqual(['model-a']);
    expect((env.config.models as Record<string, unknown>).prompts).toEqual(['model-role-a']);
    expect(env.config.mcpServers?.foo.env?.prompts).toBe('mcp-a');
  });

  it('skips only root keys in interpolateValue', () => {
    const result = interpolateValue({ a: '${X}', prompts: { planner: '${X}' }, mcpServers: { foo: { env: { prompts: '${X}' } } } }, { X: 'v' }, { skipRootKeys: new Set(['prompts']) });
    expect(result).toEqual({ value: { a: 'v', prompts: { planner: '${X}' }, mcpServers: { foo: { env: { prompts: 'v' } } } }, warnings: [] });
  });
});
