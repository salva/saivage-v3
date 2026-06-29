import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list_directory, read_file, run_shell_command, write_file } from '../../src/tools/analyst-workspace-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree, listControlActions } from '../../src/persistence/index.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

function ctx(root: string, surface: ToolContext['surface'] = 'web-chat'): ToolContext {
  return { projectRoot: root, store: new CardStore(root), actor: 'analyst', surface };
}

function setupCardProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-record-'));
  initProjectTree(root);
  initRuntimeState(root);
  materializeProjectCard(root);
  return root;
}

const UPDATED_BRIEF = '# Goal\n\nUpdated goal\n\n# Instructions\n\nUpdated instructions\n\n# Acceptance Criteria\n\nUpdated acceptance\n';

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
      expect(result.errorEnvelope).toEqual(expect.objectContaining({ kind: 'permission', message: expect.any(String) }));
      expect(result.error).toMatch(/denied/i);
      expect(result.error).toMatch(/secret-bearing path/i);
      expect(result.error).not.toContain('{"token":"secret"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('read_file denies normalized and case-varied secret paths without exposing contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const secretDir = join(root, '.Saivage');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'AUTH-PROFILES.JSON'), '{"token":"secret-value"}');

      const result = await read_file(ctx(root), {
        path: join(root, 'nested', '..', '.Saivage', 'AUTH-PROFILES.JSON'),
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/denied/i);
      expect(result.error).toMatch(/secret-bearing path/i);
      expect(result.error).not.toContain('secret-value');
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

  it('list_directory omits case-varied secret child file names and only reports redacted summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const secretDir = join(root, '.Saivage');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'AUTH-PROFILES.JSON'), '{"token":"secret"}');
      writeFileSync(join(secretDir, 'runtime.json'), '{}');

      const result = await list_directory(ctx(root), { path: secretDir });
      expect(result.success).toBe(true);
      const data = result.data as { redacted_count: number; entries: Array<{ name: string; count?: number }> };
      expect(data.redacted_count).toBe(1);
      expect(data.entries.some((entry) => entry.name === 'AUTH-PROFILES.JSON')).toBe(false);
      expect(data.entries).toContainEqual({ name: '<redacted>', count: 1 });
      expect(data.entries).toContainEqual(expect.objectContaining({ name: 'runtime.json' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('list_directory omits standalone secret directory child names and reports a single redacted summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      mkdirSync(join(root, '.ssh'), { recursive: true });
      mkdirSync(join(root, '.AWS'), { recursive: true });
      mkdirSync(join(root, 'safe-dir'), { recursive: true });

      const result = await list_directory(ctx(root), { path: root });
      expect(result.success).toBe(true);
      const data = result.data as { redacted_count: number; entries: Array<{ name: string; count?: number }> };
      expect(data.redacted_count).toBe(2);
      expect(data.entries.some((entry) => entry.name === '.ssh')).toBe(false);
      expect(data.entries.some((entry) => entry.name === '.AWS')).toBe(false);
      expect(data.entries).toContainEqual({ name: '<redacted>', count: 2 });
      expect(data.entries).toContainEqual(expect.objectContaining({ name: 'safe-dir' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('run_shell_command secret-bearing paths are denied and do not leak real secret path names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const result = await run_shell_command(ctx(root), { command: 'cat .saivage/auth-profiles.json apiKey=super-secret' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/secret|denied|off-limits/i);
      expect(JSON.stringify(result)).not.toMatch(/auth-profiles\.json/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('run_shell_command is unavailable on telegram', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-k-inspect-'));
    try {
      const result = await run_shell_command(ctx(root, 'telegram'), { command: 'ls' });
      expect(result.success).toBe(false);
      expect(result.errorEnvelope).toEqual(expect.objectContaining({ kind: 'permission', message: expect.any(String) }));
      expect(result.error).toMatch(/not available on Telegram/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write_file rejects brief record writes while runtime is not paused', async () => {
    const root = setupCardProject();
    try {
      const result = await write_file(ctx(root), { path: 'record://brief.md?card=project&v=next', content: UPDATED_BRIEF });
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires the runtime to be paused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write_file commits a new closed brief record while paused and does not audit content', async () => {
    const root = setupCardProject();
    try {
      updateRuntimeState(root, { status: 'paused', paused: true, paused_at: new Date().toISOString() });
      const result = await write_file(ctx(root), { path: 'record://brief.md?card=project&v=next', content: UPDATED_BRIEF });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({ card_id: 'project', record_url: 'record://brief.md?card=project&v=2', written: true }));

      const readResult = await read_file(ctx(root), { path: 'record://brief.md?card=project' });
      expect(readResult.success).toBe(true);
      expect((readResult.data as { content: string }).content).toBe(UPDATED_BRIEF);

      const actions = listControlActions(root);
      const action = actions.find((entry) => entry.action === 'record.brief.write');
      expect(action?.params_summary).toContain('record://brief.md?card=project&v=next');
      expect(action?.params_summary).not.toContain('Updated instructions');
      expect(JSON.stringify(actions)).not.toContain('Updated acceptance');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write_file rejects non-brief, non-record, and non-next writes', async () => {
    const root = setupCardProject();
    try {
      updateRuntimeState(root, { status: 'paused', paused: true, paused_at: new Date().toISOString() });
      await expect(write_file(ctx(root), { path: '/tmp/brief.md', content: UPDATED_BRIEF })).resolves.toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('only writes record://brief.md') }));
      await expect(write_file(ctx(root), { path: 'record://status.md?card=project&v=next', content: UPDATED_BRIEF })).resolves.toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('only supports record://brief.md') }));
      await expect(write_file(ctx(root), { path: 'record://brief.md?card=project&v=1', content: UPDATED_BRIEF })).resolves.toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('must use v=next') }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('read_file rejects unsafe record URL card ids', async () => {
    const root = setupCardProject();
    try {
      const result = await read_file(ctx(root), { path: 'record://brief.md?card=../project' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid card id');
      expect(readFileSync(join(root, '.saivage', 'outputs', 'cards', 'project', 'brief', '1.md'), 'utf-8')).toContain('Test project root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
