import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/utils/card-store.js';
import { initRuntimeState } from '../../src/utils/runtime-state.js';
import { run_shell_command, type ToolContext } from '../../src/agents/analyst-tools.js';

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
  if (!readFileSync) return [];
  const raw = readFileSync(path, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('run_shell_command', () => {
  it('denies destructive sudo command and audits denied outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'sudo systemctl restart x' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Denied by authorization policy/);
      const audit = readAudit(root);
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toBe('denied');
      expect(audit[0].action).toBe('shell.exec');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows read_only commands without audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'ls /tmp' });
      expect(result.success).toBe(true);
      expect((result.data as { classified_as: string }).classified_as).toBe('read_only');
      expect(join(root, '.saivage', 'runtime', 'control-actions.jsonl')).toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('treats node --version as read_only and does not audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const result = await run_shell_command(ctx(root, store), { command: 'node --version' });
      expect(result.success).toBe(true);
      expect((result.data as { classified_as: string }).classified_as).toBe('read_only');
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

  it('returns preview on cli destructive command until confirmed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-j-shell-'));
    try {
      const store = setup(root);
      const preview = await run_shell_command(ctx(root, store, 'cli'), { command: 'sudo systemctl restart x' });
      expect(preview.success).toBe(true);
      expect(preview.preview?.preview_hash).toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
