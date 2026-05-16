import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/utils/card-store.js';
import { create_card, add_note, pause_runtime, run_shell_command, type ToolContext } from '../../src/agents/analyst-tools.js';
import { initRuntimeState } from '../../src/utils/runtime-state.js';

function ctx(root: string, store: CardStore): ToolContext { return { projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }; }
function setup(root: string): CardStore { const sd = join(root, '.saivage'); for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true }); const now = new Date().toISOString(); writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 })); writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } })); writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([])); writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({})); writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({})); writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] })); initRuntimeState(root); const store = new CardStore(root); store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 }); return store; }

describe('analyst audit', () => {
  it('writes one audit per mutating tool call and redacts synthetic secrets from params and errors where secrets are present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-audit-'));
    try {
      const store = setup(root);
      await create_card(ctx(root, store), { type: 'code', parent: 'goal-1', title: 'x', description: 'apiKey=secret-123' });
      await add_note(ctx(root, store), { cardId: 'goal-1', content: 'token=top-secret', kind: 'comment' });
      await pause_runtime(ctx(root, store), {});
      await add_note(ctx(root, store), { cardId: 'missing-card', content: 'password=hunter2', kind: 'directive' });
      const lines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(line.actor).toBe('analyst');
        expect(line.surface).toBe('web-chat');
        expect(line.created_at).toBeTruthy();
        expect(line.params_summary).not.toMatch(/secret-123|top-secret|hunter2/);
        expect(line.outcome_summary).not.toMatch(/secret-123|top-secret|hunter2/);
        if (line.error) expect(line.error).not.toMatch(/secret-123|top-secret|hunter2/);
      }
      expect(lines.find((line) => line.action === 'card.create')?.params_summary).toContain('[REDACTED]');
      expect(lines.find((line) => line.action === 'note.append')?.params_summary).toContain('[REDACTED]');
      expect(lines.filter((line) => line.outcome === 'error')).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('redacts shell params, summaries, and errors for previewed and failing shell actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-audit-shell-'));
    try {
      const store = setup(root);
      const previewed = await run_shell_command(ctx(root, store), { command: 'cat .saivage/auth-profiles.json token=super-secret' });
      expect(previewed.success).toBe(true);
      expect(previewed.preview).toBeTruthy();
      const failed = await run_shell_command(ctx(root, store), { command: "python3 -c \"import sys; sys.stderr.write('apiKey=secret-456'); sys.exit(2)\"" });
      expect(failed.success).toBe(false);
      const lines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      const shellLines = lines.filter((line) => line.action === 'shell.exec');
      expect(shellLines).toHaveLength(2);
      for (const line of shellLines) {
        expect(line.actor).toBe('analyst');
        expect(line.surface).toBe('web-chat');
        expect(line.params_summary).toMatch(/classified=(destructive|low)/);
        expect(`${line.params_summary} ${line.outcome_summary} ${line.error ?? ''}`).not.toMatch(/super-secret|secret-456|auth-profiles\.json/i);
      }
      expect(shellLines.map((line) => line.outcome).sort()).toEqual(['error', 'rejected']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
