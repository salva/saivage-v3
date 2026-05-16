import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list_directory, read_file, type ToolContext } from '../../src/agents/analyst-tools.js';

function ctx(root: string): ToolContext {
  return { projectRoot: root, actor: 'analyst', surface: 'web-chat' };
}

describe('analyst inspection tools secret-path policy', () => {
  it('read_file denies secret-bearing auth profiles before reading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const secretDir = join(root, '.saivage');
      mkdirSync(secretDir, { recursive: true });
      const secretPath = join(secretDir, 'auth-profiles.json');
      writeFileSync(secretPath, '{"token":"secret"}');

      const result = await read_file(ctx(root), { path: secretPath });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/denied/i);
      expect(result.error).toMatch(/secret-bearing path/i);
      expect(result.error).not.toContain('{"token":"secret"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('list_directory redacts secret-bearing child entries and reports redacted_count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const secretDir = join(root, '.saivage');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'auth-profiles.json'), '{"token":"secret"}');
      writeFileSync(join(secretDir, 'runtime.json'), '{}');

      const result = await list_directory(ctx(root), { path: secretDir });
      expect(result.success).toBe(true);
      const data = result.data as { redacted_count: number; entries: Array<{ name: string; count?: number }> };
      expect(data.redacted_count).toBe(1);
      expect(data.entries.some((entry) => entry.name === 'auth-profiles.json')).toBe(false);
      expect(data.entries).toContainEqual({ name: '<redacted>', count: 1 });
      expect(data.entries).toContainEqual(expect.objectContaining({ name: 'runtime.json' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
