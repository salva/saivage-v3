import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/cards/card-store.js';

function uniqueDir(): string { return join(tmpdir(), `saivage-gfi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); }
function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  mkdirSync(sd, { recursive: true });
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages', 'diaries']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { port: 8080, host: '127.0.0.1' }, providers: { test: { apiKey: 'secret-key' } }, models: { default: ['test-model'] } }, null, 2));
  writeFileSync(join(sd, 'auth-profiles.json'), JSON.stringify({ token: 'top-secret' }, null, 2));
  writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', started_at: now, paused: false, queue: [], running_processes: [], updated_at: now }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' }, 'card-1': { id: 'card-1', type: 'code', parent: 'project', status: 'done', title: 'Card 1' } } }, null, 2));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify(['card-1']));
  writeFileSync(join(sd, 'cards', 'tree', 'card-1.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  mkdirSync(join(projectRoot, 'reports'), { recursive: true });
  writeFileSync(join(projectRoot, 'reports', 'generated.txt'), 'hello world\n');
  writeFileSync(join(projectRoot, 'reports', 'binary.bin'), Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));
  const outside = join(tmpdir(), `saivage-gfi-outside-${Date.now()}.txt`);
  writeFileSync(outside, 'outside secret');
  symlinkSync(outside, join(projectRoot, 'reports', 'outside-link.txt'));
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, tags: [], priority: 0, position: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }, null, 2));
  writeFileSync(join(sd, 'cards', 'by-id', 'card-1.json'), JSON.stringify({ id: 'card-1', type: 'code', parent: 'project', depth: 1, title: 'Card 1', description: '', status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { generated_files: ['reports/generated.txt', '../outside.txt', '/tmp/outside.txt', '.saivage/auth-profiles.json', 'reports/outside-link.txt'], artifact_paths: ['reports/generated.txt', '.saivage/saivage.json', 'reports/outside-link.txt'], verification_commands: [{ command: 'npm test', processId: 'p1', status: 'completed', exitCode: 0, timedOut: false }], tool_errors: ['warn'], parse_failure: { message: 'bad json' } }, generated_files: ['reports/generated.txt', '../outside.txt', '/tmp/outside.txt', '.saivage/auth-profiles.json', 'reports/outside-link.txt'], verified_at: now, latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: now }, warnings: [] }, error: null, completed_at: now }, tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [{ id: 'a1', card_id: 'card-1', path: 'reports/generated.txt', type: 'report', description: 'artifact copy', retain: true, created_at: now }, { id: 'a2', card_id: 'card-1', path: 'reports/outside-link.txt', type: 'report', description: 'unsafe symlink', retain: true, created_at: now }], attachments: [{ id: 'att1', card_id: 'card-1', path: 'reports/generated.txt', mime: 'text/plain', title: 'Generated file', created_at: now }], retries: 0 }, null, 2));
}

describe('generated file inspection api', () => {
  let projectRoot: string; let app: FastifyInstance; let port: number; let authToken: string;
  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot);
    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;
    app = Fastify({ logger: false });
    await app.register(cors); await app.register(websocket);
    const { default: authPlugin } = await import('../../src/server/auth.js'); await app.register(authPlugin);
    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const cardStore = new CardStore(projectRoot);
    registerCardRoutes(app, projectRoot, undefined, cardStore); registerChatsFilesDebugRoutes(app, projectRoot, cardStore);
    await app.listen({ port: 0, host: '127.0.0.1' }); port = (app.server.address() as { port: number }).port;
  }, 30000);
  afterAll(async () => { if (app) await app.close(); try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} }, 10000);
  function apiUrl(path: string): string { return `http://127.0.0.1:${port}${path}`; }
  function authHdr(): Record<string, string> { return { authorization: `Bearer ${authToken}` }; }

  it('GET /api/cards/:id returns current card payload without legacy evidence wrapper', async () => {
    const res = await fetch(apiUrl('/api/cards/card-1'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.card.id).toBe('card-1');
    expect(body.card.version_seq).toBe(1);
    expect(body.card.artifacts.map((artifact: any) => artifact.path)).toContain('reports/generated.txt');
    expect(body.card.artifacts.map((artifact: any) => artifact.path)).toContain('reports/outside-link.txt');
    expect(body.card.attachments.map((attachment: any) => attachment.path)).toContain('reports/generated.txt');
    expect(body.card.lifecycle.result.generated_files).toContain('.saivage/auth-profiles.json');
    expect(body.children).toEqual([]);
    expect(body.ancestorIds).toEqual(['project']);
    expect(body.evidence).toBeUndefined();
  });

  it('GET /api/files/content blocks auth-profiles preview', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=.saivage/auth-profiles.json'), { headers: authHdr() });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.path).toBe('.saivage/auth-profiles.json');
  });

  it('GET /api/files/content redacts saivage.json and reports redaction metadata', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=.saivage/saivage.json'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe('.saivage/saivage.json');
    expect(body.redacted).toBe(true);
    expect(body.sensitivity).toBe('sensitive-redacted');
    expect(body.content).toContain('[REDACTED]');
    expect(body.content).not.toContain('secret-key');
  });

  it('GET /api/files/content rejects binary files gracefully', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=reports/binary.bin'), { headers: authHdr() });
    expect(res.status).toBe(415);
  });

  it('GET /api/files/content canonicalizes absolute contained path responses', async () => {
    const absolute = encodeURIComponent(join(projectRoot, 'reports', 'generated.txt'));
    const res = await fetch(apiUrl(`/api/files/content?path=${absolute}`), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe('reports/generated.txt');
    expect(String(body.path)).not.toContain(projectRoot);
  });

  it('GET /api/files omits unsafe symlink directory entries and returns canonical relative path', async () => {
    const absolute = encodeURIComponent(join(projectRoot, 'reports'));
    const res = await fetch(apiUrl(`/api/files?path=${absolute}`), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe('reports');
    expect(body.files.some((f: any) => f.name === 'outside-link.txt')).toBe(false);
    expect(JSON.stringify(body)).not.toContain(projectRoot);
  });
});
