import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pause_runtime, resume_runtime, type ToolContext } from '../../src/agents/analyst-tools.js';

class FakeActiveRuntime {
  private paused = false;
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  getStatus(): { status: string; paused: boolean; currentCardId: null; goalCount: number } { return { status: this.paused ? 'paused' : 'idle', paused: this.paused, currentCardId: null, goalCount: 0 }; }
}

describe('analyst pause resume parity', () => {
  it('updates persisted and in-memory runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-parity-'));
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
      const runtime = new FakeActiveRuntime();
      const ctx: ToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', activeRuntime: runtime as never };
      const paused = await pause_runtime(ctx, {});
      expect(paused.success).toBe(true);
      expect(runtime.getStatus().paused).toBe(true);
      const resumed = await resume_runtime(ctx, {});
      expect(resumed.success).toBe(true);
      expect(runtime.getStatus().paused).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
