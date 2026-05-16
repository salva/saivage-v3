import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ServerInstance } from '../../src/server/server.js';

const AUTH_TOKEN = 'auth-mode-test-token-' + Math.random().toString(36).slice(2, 8);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

function setupProjectDir(root: string, host?: string): void {
  const sd = join(root, '.saivage');

  for (const d of [
    'cards/by-id',
    'cards/tree',
    'cards/dependencies',
    'notes/by-card',
    'runtime',
    'agents/sessions',
    'agents/messages',
    'diaries',
  ]) {
    mkdirSync(join(sd, d), { recursive: true });
  }

  const now = new Date().toISOString();

  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: host ?? '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: {
          priority: 10,
          models: ['test-model'],
          apiKey: 'auth-mode-test-api-key',
        },
      },
    }, null, 2),
  );

  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
    }, null, 2),
  );

  writeFileSync(
    join(sd, 'cards', 'by-id', 'project.json'),
    JSON.stringify({
      id: 'project',
      type: 'project',
      parent: null,
      depth: 0,
      title: 'project',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: now,
      updated_at: now,
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    }, null, 2),
  );

  writeFileSync(
    join(sd, 'cards', 'index.json'),
    JSON.stringify({
      cards: {
        project: {
          id: 'project',
          type: 'project',
          parent: null,
          status: 'backlog',
          title: 'project',
        },
      },
    }, null, 2),
  );

  writeFileSync(
    join(sd, 'cards', 'tree', 'project.children.json'),
    JSON.stringify([]),
  );
  writeFileSync(
    join(sd, 'cards', 'dependencies', 'depends-on.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(sd, 'cards', 'dependencies', 'blocks.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(sd, 'notes', 'queue.json'),
    JSON.stringify({ next_note_sequence: 1, entries: [] }),
  );

  writeFileSync(join(sd, 'runtime', 'events.jsonl'), '');
  writeFileSync(join(sd, 'runtime', 'errors.jsonl'), '');

  const realWebDist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(realWebDist)) {
    const tmpWebDist = join(root, 'web', 'dist');
    mkdirSync(dirname(tmpWebDist), { recursive: true });
    cpSync(realWebDist, tmpWebDist, { recursive: true });
  }
}

async function createAndListen(
  projectRoot: string,
  host: string,
  _tokenOverride: string | undefined,
): Promise<ServerInstance & { port: number }> {
  const { createServer } = await import('../../src/server/server.js');
  const server = await createServer(projectRoot, false);

  await server.fastify.listen({ host, port: 0 });
  const addr = server.fastify.server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Server did not listen on a network port');
  }

  return { ...server, port: addr.port };
}

describe('isLocalhost()', () => {
  let isLocalhost: (host: string) => boolean;

  beforeAll(async () => {
    const mod = await import('../../src/server/server.js');
    isLocalhost = mod.isLocalhost;
  });

  it("returns true for '127.0.0.1'", () => {
    expect(isLocalhost('127.0.0.1')).toBe(true);
  });

  it("returns true for 'localhost'", () => {
    expect(isLocalhost('localhost')).toBe(true);
  });

  it("returns true for '::1'", () => {
    expect(isLocalhost('::1')).toBe(true);
  });

  it("returns true for '0:0:0:0:0:0:0:1'", () => {
    expect(isLocalhost('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it("returns false for '0.0.0.0'", () => {
    expect(isLocalhost('0.0.0.0')).toBe(false);
  });

  it("returns false for 'example.com'", () => {
    expect(isLocalhost('example.com')).toBe(false);
  });

  it("returns false for '192.168.1.1'", () => {
    expect(isLocalhost('192.168.1.1')).toBe(false);
  });

  it("returns false for '' (empty string)", () => {
    expect(isLocalhost('')).toBe(false);
  });

  it('returns false for non-loopback IPv6 address', () => {
    expect(isLocalhost('::ffff:192.0.2.1')).toBe(false);
  });
});

describe('validateDevModeHost()', () => {
  let validateDevModeHost: (host: string | undefined) => void;
  let originalToken: string | undefined;

  beforeAll(async () => {
    const mod = await import('../../src/server/server.js');
    validateDevModeHost = mod.validateDevModeHost;
    originalToken = process.env['SAIVAGE_API_TOKEN'];
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env['SAIVAGE_API_TOKEN'];
    } else {
      process.env['SAIVAGE_API_TOKEN'] = originalToken;
    }
  });

  it('does not warn or throw for any host when SAIVAGE_API_TOKEN is set', () => {
    process.env['SAIVAGE_API_TOKEN'] = 'test-token';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('127.0.0.1')).not.toThrow();
    expect(() => validateDevModeHost('localhost')).not.toThrow();
    expect(() => validateDevModeHost('0.0.0.0')).not.toThrow();
    expect(() => validateDevModeHost('example.com')).not.toThrow();
    expect(() => validateDevModeHost('192.168.1.1')).not.toThrow();
    expect(() => validateDevModeHost(undefined)).not.toThrow();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("warns but does NOT throw when SAIVAGE_API_TOKEN is unset and host is '127.0.0.1'", () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('127.0.0.1')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('DEVELOPMENT MODE');

    warnSpy.mockRestore();
  });

  it("warns but does NOT throw when SAIVAGE_API_TOKEN is unset and host is 'localhost'", () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('localhost')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('DEVELOPMENT MODE');

    warnSpy.mockRestore();
  });

  it("warns but does NOT throw when SAIVAGE_API_TOKEN is unset and host is '::1'", () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('::1')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("warns and throws when SAIVAGE_API_TOKEN is unset and host is '0.0.0.0'", () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('0.0.0.0')).toThrow(
      /Cannot bind to 0\.0\.0\.0 without SAIVAGE_API_TOKEN/,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('DEVELOPMENT MODE');

    warnSpy.mockRestore();
  });

  it('warns and throws when SAIVAGE_API_TOKEN is unset and host is undefined (defaults to 0.0.0.0)', () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost(undefined)).toThrow(
      /Cannot bind to 0\.0\.0\.0 without SAIVAGE_API_TOKEN/,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('DEVELOPMENT MODE');

    warnSpy.mockRestore();
  });

  it("warns and throws when SAIVAGE_API_TOKEN is unset and host is 'example.com'", () => {
    delete process.env['SAIVAGE_API_TOKEN'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateDevModeHost('example.com')).toThrow(
      /Cannot bind to example\.com without SAIVAGE_API_TOKEN/,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe('Server — dev mode (no token) with localhost', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;
  let originalToken: string | undefined;

  beforeAll(async () => {
    originalCwd = process.cwd();
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    delete process.env['SAIVAGE_API_TOKEN'];

    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-auth-mode-dev-local-'));
    setupProjectDir(tmpDir, '127.0.0.1');
    process.chdir(tmpDir);

    const result = await createAndListen(tmpDir, '127.0.0.1', undefined);
    server = result;
    port = result.port;
  }, 30000);

  afterAll(async () => {
    try { process.chdir(originalCwd); } catch {}
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    if (server) {
      try { await server.stop(); } catch {}
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 15000);

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  it('server starts successfully (no throw)', () => {
    expect(server).toBeDefined();
    expect(server.fastify).toBeDefined();
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(baseUrl('/health'));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('GET /api/state works without auth (dev mode — auth is disabled)', async () => {
    const res = await fetch(baseUrl('/api/state'));
    expect(res.status).toBe(200);
  });
});

describe('Server — dev mode (no token) with 0.0.0.0 fails', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalToken: string | undefined;

  beforeAll(async () => {
    originalCwd = process.cwd();
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    delete process.env['SAIVAGE_API_TOKEN'];

    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-auth-mode-dev-fail-'));
    setupProjectDir(tmpDir, '0.0.0.0');
    process.chdir(tmpDir);
  });

  afterAll(async () => {
    try { process.chdir(originalCwd); } catch {}
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 15000);

  it('startServer() throws because host is 0.0.0.0 without token', async () => {
    const { startServer } = await import('../../src/server/server.js');

    await expect(startServer(tmpDir, false)).rejects.toThrow(
      /Cannot bind to 0\.0\.0\.0 without SAIVAGE_API_TOKEN/,
    );
  });
});

describe('Server — with token works with any host', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;
  let originalToken: string | undefined;

  beforeAll(async () => {
    originalCwd = process.cwd();
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;

    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-auth-mode-token-any-'));
    setupProjectDir(tmpDir, '0.0.0.0');
    process.chdir(tmpDir);

    const result = await createAndListen(tmpDir, '127.0.0.1', AUTH_TOKEN);
    server = result;
    port = result.port;
  }, 30000);

  afterAll(async () => {
    try { process.chdir(originalCwd); } catch {}
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    if (server) {
      try { await server.stop(); } catch {}
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 15000);

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  it('server starts successfully when token is set (even with 0.0.0.0 in config)', () => {
    expect(server).toBeDefined();
    expect(server.fastify).toBeDefined();
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(baseUrl('/health'));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('GET /api/state requires auth (returns 401 without token)', async () => {
    const res = await fetch(baseUrl('/api/state'));
    expect(res.status).toBe(401);
  });

  it('GET /api/state succeeds with valid Bearer token', async () => {
    const res = await fetch(baseUrl('/api/state'), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});
