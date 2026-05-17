import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/utils/card-store.js';
import { initRuntimeState } from '../../src/utils/runtime-state.js';
import { run_shell_command, type ToolContext } from '../../src/agents/analyst-tools.js';
import { hashPreviewParams } from '../../src/utils/control-action-audit.js';

function setup(root: string): CardStore {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  initRuntimeState(root);
  return new CardStore(root);
}

function ctx(root: string, store: CardStore, surface: ToolContext['surface'] = 'web-chat'): ToolContext {
  return { projectRoot: root, store, actor: 'analyst', surface };
}

function readAudit(root: string) {
  const path = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('run_shell_command', () => {
  it('returns preview-only flow for destructive sudo command on web-chat and audits preview outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'sudo systemctl restart x' });
      expect(result.success).toBe(true);
      expect(result.preview?.type).toBe('shell.exec');
      expect((result.preview as unknown as Record<string, unknown> | undefined)?.['classified_as']).toBe('destructive');
      expect(result.preview?.preview_hash).toBeTruthy();
      const audit = readAudit(root);
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toBe('preview');
      expect(audit[0].action).toBe('shell.exec');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns preview on cli destructive command until confirmed, then executes only with matching preview_hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const command = `printf done > ${join(root, 'preview-ok.txt')}`;
      const preview = await run_shell_command(ctx(root, store, 'cli'), { command });
      expect(preview.success).toBe(true);
      expect((preview.data as { classified_as: string }).classified_as).toBe('low');
      expect(existsSync(join(root, 'preview-ok.txt'))).toBe(true);
      const audit = readAudit(root);
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toBe('ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns preview-only flow for secret-bearing path shell reads on web-chat without leaking the path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const secretDir = join(root, '.saivage');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'auth-profiles.json'), '{"token":"secret"}');
      const result = await run_shell_command(ctx(root, store), { command: 'cat .saivage/auth-profiles.json token=super-secret' });
      expect(result.success).toBe(true);
      expect(result.preview?.type).toBe('shell.exec');
      expect((result.preview as unknown as Record<string, unknown> | undefined)?.['classified_as']).toBe('destructive');
      const audit = readAudit(root);
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toBe('preview');
      expect(`${audit[0].params_summary} ${audit[0].outcome_summary} ${audit[0].error ?? ''}`).not.toMatch(/super-secret|auth-profiles\.json/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects Telegram surface at the tool layer without relying on authz rules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store, 'telegram'), { command: 'ls /tmp' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not available on Telegram/i);
      expect(readAudit(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows read_only commands without audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'ls /tmp' });
      expect(result.success).toBe(true);
      expect((result.data as { classified_as: string }).classified_as).toBe('read_only');
      expect(readAudit(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('treats node --version as read_only and does not audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'node --version' });
      expect(result.success).toBe(true);
      expect((result.data as { classified_as: string }).classified_as).toBe('read_only');
      expect(readAudit(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows low commands and audits them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'echo hi' });
      expect(result.success).toBe(true);
      expect((result.data as { classified_as: string }).classified_as).toBe('low');
      const audit = readAudit(root);
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toBe('ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns timeout with null exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'sleep 30', timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      expect((result.data as { exit_code: number | null }).exit_code).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('truncates oversized output and redacts token-shaped output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: "printf 'tok_live_1234567890 %0500d' 0", maxOutputBytes: 40 });
      const data = result.data as { stdout: string; truncated: boolean };
      expect(data.truncated).toBe(true);
      expect(data.stdout).toMatch(/\[truncated /);
      expect(data.stdout).not.toContain('tok_live_1234567890');
      expect(data.stdout).toContain('tok-[REDACTED]');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('sanitizes inherited env vars for child shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    process.env.OPENAI_API_KEY = 'secret-openai';
    process.env.SAIVAGE_API_TOKEN = 'secret-saivage';
    process.env.ANTHROPIC_API_KEY = 'secret-anthropic';
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: "env | grep -E '(SAIVAGE|OPENAI|ANTHROPIC)'" });
      const data = result.data as { stdout: string; stderr: string };
      expect(`${data.stdout}${data.stderr}`).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects cwd outside project root without leaking the raw path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    const outside = mkdtempSync(join(tmpdir(), 'wave-j-shell-outside-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'pwd', cwd: outside });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cwd must stay within the project root/i);
      expect(result.error).not.toContain(outside);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects secret-bearing cwd directories before execution without leaking the real path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const secretDir = join(root, '.saivage');
      const marker = join(root, 'should-not-execute.txt');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'auth-profiles.json'), '{"token":"secret"}');
      const result = await run_shell_command(ctx(root, store), { command: `printf blocked > ${marker}`, cwd: secretDir });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/secret-bearing path is off-limits/i);
      expect(result.error).not.toContain(secretDir);
      expect(JSON.stringify(result)).not.toMatch(/auth-profiles\.json|\.saivage/i);
      expect(existsSync(marker)).toBe(false);
      expect(readAudit(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects malformed param types before execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      await expect(run_shell_command(ctx(root, store), { command: '' })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/command is required/i) });
      await expect(run_shell_command(ctx(root, store), { command: 'pwd', cwd: 123 as unknown as string })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/cwd must be a string/i) });
      await expect(run_shell_command(ctx(root, store), { command: 'pwd', timeoutMs: Number.NaN })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/timeoutMs must be a finite number/i) });
      await expect(run_shell_command(ctx(root, store), { command: 'pwd', maxOutputBytes: Number.POSITIVE_INFINITY })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/maxOutputBytes must be a finite number/i) });
      await expect(run_shell_command(ctx(root, store), { command: 'pwd', confirmed: 'yes' as unknown as boolean })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/confirmed must be a boolean/i) });
      await expect(run_shell_command(ctx(root, store), { command: 'pwd', preview_hash: 7 as unknown as string })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/preview_hash must be a string/i) });
      expect(readAudit(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('clamps timeoutMs and maxOutputBytes before preview hashing so extreme values cannot bypass confirmation matching', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const command = 'sudo systemctl restart x';
      const preview = await run_shell_command(ctx(root, store), { command, timeoutMs: 999999999, maxOutputBytes: 999999999 });
      expect(preview.success).toBe(true);
      const expectedHash = hashPreviewParams({ command, cwd: root, timeoutMs: 60000, maxOutputBytes: 1048576 });
      expect(preview.preview?.preview_hash).toBe(expectedHash);

      const confirmed = await run_shell_command(ctx(root, store), {
        command,
        timeoutMs: 999999999,
        maxOutputBytes: 999999999,
        confirmed: true,
        preview_hash: expectedHash,
      });
      expect(confirmed.success).toBe(false);
      expect(confirmed.error).toMatch(/unit x\.service not found/i);
      expect((confirmed.data as { classified_as: string }).classified_as).toBe('destructive');

      const audit = readAudit(root);
      expect(audit).toHaveLength(2);
      expect(audit[0].outcome).toBe('preview');
      expect(audit[1].outcome).toBe('error');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
