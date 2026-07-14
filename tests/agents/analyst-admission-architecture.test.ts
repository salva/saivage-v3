import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ANALYST_TOOL_EFFECT_INVENTORY, ANALYST_TOOL_NAMES } from '../../src/tools/analyst-tool-registry.js';

const ROOT = process.cwd();

function tsFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('Analyst admission architecture', () => {
  it('classifies every exposed tool and every effectful webfetch branch', () => {
    expect(Object.keys(ANALYST_TOOL_EFFECT_INVENTORY).sort()).toEqual([...ANALYST_TOOL_NAMES].sort());
    expect(ANALYST_TOOL_EFFECT_INVENTORY.webfetch.map((entry) => [entry.branch, entry.effect])).toEqual([
      ['no_save_inline_metadata_error_binary', 'read_only'],
      ['no_save_oversized_text', 'disposable_external_output'],
      ['save_as_record_brief', 'ordinary_mutation'],
      ['save_as_project_tmp_system', 'external_workspace_mutation'],
    ]);
    expect(ANALYST_TOOL_EFFECT_INVENTORY.reconfigure.find((entry) => entry.branch === 'mcp_add_edit_remove')?.effect).toBe('rejection_only');
    expect(ANALYST_TOOL_EFFECT_INVENTORY.mcp_reconcile[0]?.effect).toBe('rejection_only');
    expect(ANALYST_TOOL_EFFECT_INVENTORY.mcp_tool_call[0]).toMatchObject({ effect: 'special_owner', owner: 'McpManager.invokeTool' });
  });

  it('proves no Analyst auth-profile mutator is exposed', () => {
    expect(ANALYST_TOOL_NAMES.filter((name) => /auth|profile|credential/i.test(name))).toEqual([]);
  });

  it('uses named synchronous commits and no opaque run callback', () => {
    const runner = readFileSync(join(ROOT, 'src/agents/analyst-tool-runner.ts'), 'utf8');
    expect(runner).not.toMatch(/readonly run\s*:/);
    expect(runner).toMatch(/readonly commit: .*=> ToolResult/);
    const operationSource = readFileSync(join(ROOT, 'src/application/analyst-mutation-operations.ts'), 'utf8');
    expect(operationSource).not.toMatch(/export async function commit/);
    const serviceSource = readFileSync(join(ROOT, 'src/application/analyst-mutation-services.ts'), 'utf8');
    expect(serviceSource).not.toMatch(/async\s+(?:create|delete|cancel|reorder|apply|queue|write|edit)\s*\(/);
    expect(serviceSource).not.toMatch(/(?:create|delete|cancel|reorder|apply|queue|write|edit)\s*\([^)]*\)\s*:\s*Promise(?:Like)?/);
    for (const file of tsFiles(join(ROOT, 'src/tools'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/commit:\s*(?:async\s*)?\(/);
    }
  });

  it('keeps persistence APIs synchronous and free of generic mutation callbacks', () => {
    for (const file of tsFiles(join(ROOT, 'src/persistence'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\basync\s+\w+\s*\(/);
      expect(source).not.toMatch(/\b(?:mutate|request|apply)\s*\([^)]*=>/);
      expect(source).not.toMatch(/\)\s*:\s*Promise(?:Like)?</);
    }
  });

  it('keeps prepare modules behind the read-only import boundary', () => {
    for (const file of tsFiles(join(ROOT, 'src/application/analyst-prepare'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from ['"](?:\.\.\/)+(?:persistence|config|auth|runtime|mcp|tools)\//);
      expect(source).not.toMatch(/analyst-mutation-(?:services|operations)/);
      expect(source).not.toMatch(/durable-file|writeFile|Store|Repository|RuntimeControl|ProcessRunner|McpManager/);
    }
  });
});
