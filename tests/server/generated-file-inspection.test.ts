import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function uniqueDir(): string { return join(tmpdir(), `saivage-gfi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); }
function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  mkdirSync(sd, { recursive: true });
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages', 'diaries']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { port: 8080, host: '127.0.0.1' }, providers: { test: { apiKey: 'secret-key' } }, models: { default: ['test-model'] } }, null, 2));
  writeFileSync(join(sd, 'auth-profiles.json'), JSON.stringify({ token: 'top-secret' }, null, 2));
  writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, paused: false, queue: [], running_processes: [], updated_at: now }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' }, 'card-1': { id: 'card-1', type: 'code', parent: 'project', status: 'done', title: 'Card 1' } } }, null, 2));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify(['card-1']));
  writeFileSync(join(sd, 'cards', 'tree', 'card-1.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));
  mkdirSync(join(projectRoot, 'reports'), { recursive: true });
  writeFileSync(join(projectRoot, 'reports', 'generated.txt'), 'hello world\n');
  writeFileSync(join(projectRoot, 'reports', 'binary.bin'), Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }, null, 2));
  writeFileSync(join(sd, 'cards', 'by-id', 'card-1.json'), JSON.stringify({ id: 'card-1', type: 'code', parent: 'project', depth: 1, title: 'Card 1', description: '', status: 'done', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [{ id: 'a1', card_id: 'card-1', path: 'reports/generated.txt', type: 'report', description: 'artifact copy', retain: true, created_at: now }], attachments: [{ id: 'att1', card_id: 'card-1', path: 'reports/generated.txt', mime: 'text/plain', title: 'Generated file', created_at: now }], retries: 0, result: { generated_files: ['reports/generated.txt', '../outside.txt', '/tmp/outside.txt'], artifact_paths: ['reports/generated.txt', '.saivage/saivage.json'], verification_commands: [{ command: 'npm test', processId: 'p1', status: 'completed', exitCode: 0, timedOut: false }], tool_errors: ['warn'], parse_failure: { message: 'bad json' } } }, null, 2));
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
    registerCardRoutes(app, projectRoot); registerChatsFilesDebugRoutes(app, projectRoot);
    await app.listen({ port: 0, host: '127.0.0.1' }); port = (app.server.address() as { port: number }).port;
  }, 30000);
  afterAll(async () => { if (app) await app.close(); try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} }, 10000);
  function apiUrl(path: string): string { return `http://127.0.0.1:${port}${path}`; }
  function authHdr(): Record<string, string> { return { authorization: `Bearer ${authToken}` }; }

  it('GET /api/cards/:id returns normalized evidence and omits outside paths', async () => {
    const res = await fetch(apiUrl('/api/cards/card-1'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.evidence.generatedFiles.map((f: any) => f.path)).toContain('reports/generated.txt');
    expect(body.evidence.generatedFiles.map((f: any) => f.path)).toContain('.saivage/saivage.json');
    expect(body.evidence.generatedFiles.some((f: any) => String(f.path).includes('outside'))).toBe(false);
    expect(body.evidence.verificationCommands[0]).toEqual(expect.objectContaining({ command: 'npm test', process_id: 'p1', exit_code: 0, timed_out: false }));
  });

  it('GET /api/files/content blocks auth-profiles preview', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=.saivage/auth-profiles.json'), { headers: authHdr() });
    expect(res.status).toBe(403);
  });

  it('GET /api/files/content redacts saivage.json', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=.saivage/saivage.json'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toContain('[REDACTED]');
    expect(body.content).not.toContain('secret-key');
  });

  it('GET /api/files/content rejects binary files gracefully', async () => {
    const res = await fetch(apiUrl('/api/files/content?path=reports/binary.bin'), { headers: authHdr() });
    expect(res.status).toBe(415);
  });
});
