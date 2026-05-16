import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import authPlugin from '../../src/server/auth.js';
import { registerProcessRoutes } from '../../src/server/routes/processes.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveRegistry } from '../../src/utils/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/types.js';

function setup(root: string) {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
}

describe('process terminate authz audit', () => {
  it('writes one audit entry for process termination outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-process-route-'));
    process.env['SAIVAGE_API_TOKEN'] = 'x';
    try {
      setup(root);
      const logBase = join(root, '.saivage-work', 'proc-1');
      mkdirSync(logBase, { recursive: true });
      const record: ProcessRecord = { id: 'proc-1', card_id: 'project', command: 'sleep 10', cwd: root, status: 'running', pid: 123, started_at: new Date().toISOString(), completed_at: null, exit_code: null, required_for_card_completion: false, output_dir: logBase, stdout_path: join(logBase, 'stdout.log'), stderr_path: join(logBase, 'stderr.log'), combined_log_path: join(logBase, 'combined.log'), agent_session_id: null, goal_id: null, launch_reason: 'test', owner_kind: 'operator', background_policy: 'foreground', process_group_id: null };
      saveRegistry(root, [record]);
      const app = Fastify();
      await app.register(authPlugin);
      registerProcessRoutes(app, root);
      const res = await app.inject({ method: 'POST', url: '/api/processes/proc-1/terminate', headers: { authorization: 'Bearer x' } });
      expect([200,503]).toContain(res.statusCode);
      const lines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0].action).toBe('process.kill');
      expect(lines[0].target_id).toBe('proc-1');
      await app.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
