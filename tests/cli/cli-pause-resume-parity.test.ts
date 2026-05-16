import { describe, it, expect, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('cli pause resume parity', () => {
  it('fallback updates persisted state and writes audit when server is down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-cli-'));
    const cwd = process.cwd();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const sd = join(root, '.saivage');
      for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
      writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
      writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
      writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
      writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
      writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
      writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
      process.chdir(root);
      const { run } = await import('../../src/cli.js');
      await run(['node', 'cli', 'pause']);
      const state = JSON.parse(readFileSync(join(sd, 'runtime', 'state.json'), 'utf-8')) as { status: string; paused: boolean };
      expect(state.status).toBe('paused');
      expect(state.paused).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('persisted runtime state only'));
      const audit = readFileSync(join(sd, 'runtime', 'control-actions.jsonl'), 'utf-8');
      expect(audit).toContain('runtime.pause');
    } finally { logSpy.mockRestore(); process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
  });

  it('documents wave d cli mutating scope: freeze remains unsupported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-cli-freeze-'));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const { run } = await import('../../src/cli.js');
      await expect(run(['node', 'cli', 'freeze'])).rejects.toThrow(/unsupported|not implemented/i);
    } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
  });
});
