import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import type { OutboundHttpEvent } from '../../src/contracts/index.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { deferred, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';

const records: OutboundHttpEvent[] = [];
// Retain real Fastify creation, server composition and emitter projection. Only
// substitute the operational logger's output target; never open a listener.
jest.unstable_mockModule('../../src/server/composition/fastify-app.js', () => ({
  createFastifyApp: async (...args: Parameters<typeof createFastifyApp>) => {
    const app = await createFastifyApp(...args);
    jest.spyOn(app.log, 'info').mockImplementation((fields: unknown) => {
      if (typeof fields === 'object' && fields !== null && 'event' in fields) records.push(JSON.parse(JSON.stringify(fields)));
    });
    return app;
  },
}));
const { createServerServices } = await import('../../src/server/composition/server-services.js');
const { createAppTerminalCoordinator } = await import('../../src/boot/app.js');

describe('offline server outbound sink composition', () => {
  it('actual Fastify sink is available during pending autostart before readiness, without a listener/provider', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/server-http-'); const terminal = createAppTerminalCoordinator(); const headers = deferred<Response>();
    records.length = 0;
    const config = structuredClone(TEST_SAIVAGE_CONFIG); config.oversight.enabled = false;
    config.mcpServers = { 'secret-server': { transport: 'streamable-http', url: 'https://secret-host.invalid/secret-path?secret-query#secret-fragment', autostart: true, disabled: false } };
    createProjectIdentity(root, 'Offline composition'); replaceConfigYaml(join(root, '.saivage/saivage.yaml'), config);
    publishInitialProjectRuntime(root, compileProjectWorkflows(config));
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init!.method === 'HEAD') return headers.promise;
      const body = JSON.parse(String(init!.body));
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : {} }), { headers: { 'content-type': 'application/json' } });
    });
    try {
      const environment = await loadEnvironment({ projectRoot: root, createRuntime: false }, { NODE_ENV: 'test', LOG_LEVEL: 'info' });
      let settled = false;
      const pending = createServerServices({ environment, terminal, processIdentity: { pid: 42, startedAt: '2026-10-14T00:00:00.000Z' }, fatalPort: testApplicationFatalPort, onOversightOwnerFailure: error => { throw error; } }).then(value => { settled = true; return value; });
      for (let i = 0; i < 100 && fetch.mock.calls.length === 0; i++) await setImmediate();
      expect(fetch).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ event: 'outbound_http_dispatch', service: 'mcp', purpose: 'mcp-startup' });
      headers.resolve(new Response(null)); const services = await pending;
      expect(services.fastify.server.listening).toBe(false); assertLifecycles(records, 4);
      for (const r of records) { expect(r).not.toHaveProperty('source_session'); expect(r).not.toHaveProperty('input_id'); }
      expect(fetch).toHaveBeenCalledTimes(4); assertPrivateMetadata(records, ['secret-server', 'secret-host', 'secret-path', 'secret-query', 'secret-fragment']);
    } finally { await terminal.stop(); jest.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
  });
});
