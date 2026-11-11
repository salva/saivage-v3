import { afterEach, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync, utimesSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { run } from '../../src/cli.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { NO_FRESHNESS_EFFECTS, WorkGcFrameSchema, WorkGcResponseSchema, type WorkGcResponse } from '../../src/contracts/index.js';
import { ContractFrameStream } from '../../src/server/contract-stream.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createEventLog } from '../../src/observability/index.js';
import { workGcOperatorApiContracts } from '../../src/contracts/operator-api-work-gc.js';
import { buildWorkGcOperatorContractHandlers } from '../../src/server/routes/operator-work-gc-handlers.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';
import { initializeRecordBaseline } from '../../src/persistence/authored-record-files.js';
import { genericRecordDefinition } from '../../src/schemas/index.js';
import { initProjectTree, CardService as TestCardService } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';
import { filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { runtimeCardsOperatorApiContracts } from '../../src/contracts/operator-api-runtime-cards.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { buildRuntimeCardOperatorContractHandlers } from '../../src/server/routes/operator-runtime-card-handlers.js';

const cwd = process.cwd();
const originalToken = process.env.SAIVAGE_API_TOKEN;
afterEach(() => {
  process.chdir(cwd); jest.restoreAllMocks(); process.exitCode = 0;
  if (originalToken === undefined) delete process.env.SAIVAGE_API_TOKEN;
  else process.env.SAIVAGE_API_TOKEN = originalToken;
});

// Deliberately inventories only disposable synthetic fixtures, never a real project.
function snapshot(root: string): unknown[] {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [name, stat.ino, stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('base64')];
  });
}

it('real live-owner CLI previews have no effects and delete reclaims scratch while selected evidence remains usable', async () => {
  const reports: WorkGcResponse[] = [];
  const filteredReports: WorkGcResponse[] = [];
  const realFetch = globalThis.fetch;
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:')) throw new Error('Unexpected provider/nonlocal request');
    return realFetch(url, init);
  });
  for (const flags of [[], ['--dry-run'], ['--delete']]) {
    const root = mkdtempSync(join(tmpdir(), 'gc-running-cli-'));
    initProjectTree(root);
    const authority = createTestConfigAuthority(root, { relativePath: '.saivage/saivage.yaml' });
    const effective = authority.loadEffective();
    const registry = new ProviderRegistry(effective.config);
    const workflows = bindRuntimeWorkflows(effective.workflows, new ModelRouter(registry), registry,
      effective.config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
    const cards = new CardService(root, workflows, NO_FRESHNESS_EFFECTS);
    const groups = new ManagedProcessGroupRegistry();
    const app = createRuntimeApplication({ projectRoot: root, config: effective.config, workflows,
      configAuthority: authority, providerRegistry: registry, cardStore: cards, freshness: NO_FRESHNESS_EFFECTS,
      processIdentity: { pid: process.pid, startedAt: '2026-10-24T00:00:00.000Z' },
      processRunner: new ProcessRunner(root, groups, testApplicationFatalPort),
      runtimeProcessRootScope: groups.createContainerScope(groups.rootScope, 'runtime'),
      analystProcessRootScope: groups.createContainerScope(groups.rootScope, 'analyst'),
      analystStartup: { mode: 'internal' }, externalProjectIdentityDigest: null,
      analystSessionId: 'agent:analyst:global', mcpToolInvocation: unusedMcpToolInvocation,
      restartCapability: { available: false }, fatalPort: testApplicationFatalPort,
      assertWorkGcEntryIdle() {}, assertWorkGcReady() {},
      onExternalAnalystOwnerFailure(error) { throw error; }, onOversightOwnerFailure(error) { throw error; },
    });
    const server = Fastify({ logger: false });
    // Production Fastify composition supplies no response/socket timeout. Keep
    // inbound header/body parsing timeouts distinct from the long GC response.
    expect(server.server.timeout).toBe(0);
    expect(server.server.requestTimeout).toBe(0);
    let requestCount = 0;
    server.addHook('onRequest', async () => { requestCount++; });
    const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    try {
      const garbage = join(root, '.saivage/work/cards/project/tmp/garbage.txt');
      const retained = join(root, '.saivage/work/cards/project/tmp/evidence.txt');
      mkdirSync(dirname(garbage), { recursive: true });
      writeFileSync(garbage, 'disposable'); writeFileSync(retained, 'historical evidence');
      const generic = genericRecordDefinition('review-evidence.md');
      initializeRecordBaseline(root, cards.read('project')!, { filename: 'review-evidence.md',
        format: generic.format, schema: generic.schema, bootstrap: false, declared: false },
      () => 'Keep [evidence](tmp:///project/evidence.txt).');
      const historical = join(root, '.saivage/work/cards/project/tmp/accepted-history.txt');
      writeFileSync(historical, 'old accepted evidence');
      const author = new TestCardService(root);
      author.acceptRecord('project', 'review-history.md', 'tmp:///project/accepted-history.txt', { kind: 'agent', agent: 'analyst' });
      author.acceptRecord('project', 'review-history.md', 'Current assessment has no work URL.', { kind: 'agent', agent: 'analyst' });
      await app.runtimeApi.start();
      await app.runtimeApi.startProject();
      app.runtimeApi.pause();
      for (let i = 0; i < 1000 && app.runtimeApi.getStatus().status === 'pausing'; i++)
        await new Promise<void>(resolve => setImmediate(resolve));
      expect(app.runtimeApi.getStatus().status).toBe('paused');
      const contracts = new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'synthetic-gc-token' }), eventLogger: createEventLog(root),
        fatalPort: testApplicationFatalPort });
      contracts.mount(server, workGcOperatorApiContracts, buildWorkGcOperatorContractHandlers(app));
      contracts.mount(server, { 'files.content': filesDebugOperatorApiContracts['files.content'] },
        buildFilesDebugOperatorContractHandlers({ projectRoot: root, cardServiceProvider: () => cards, configAuthority: authority, workflows }));
      contracts.mount(server, { 'health.liveness': runtimeCardsOperatorApiContracts['health.liveness'] },
        buildRuntimeCardOperatorContractHandlers({ projectRoot: root, cardStore: cards, runtimeApplication: app,
          restartCapability: { available: false }, serverAvailabilityProvider() { throw new Error('Unused readiness'); } }));
      const origin = await server.listen({ host: '127.0.0.1', port: 0 });
      publishRuntimeControlEndpoint(lock, { origin, auth: 'bearer' });
      process.chdir(root);
      const before = snapshot(join(root, '.saivage'));
      const output = jest.spyOn(console, 'log').mockImplementation(() => {});
      process.env.SAIVAGE_API_TOKEN = 'wrong-synthetic-token';
      const count = requestCount;
      await expect(run(['node', 'saivage', 'gc-work', '--delete'])).rejects.toThrow('401');
      expect(requestCount).toBe(count + 1);
      expect(snapshot(join(root, '.saivage'))).toEqual(before);
      process.env.SAIVAGE_API_TOKEN = 'synthetic-gc-token';
      await expect(run(['node', 'saivage', 'gc-work', '--delete', '--dry-run'])).rejects.toThrow();
      expect(requestCount).toBe(count + 1);
      if (!flags.length) {
        // A non-TTY child uses the actual CLI parser, discovery, live lock and HTTP
        // client. tsx only loads source modules; no fetch/client replacement in it.
        const child = await promisify(execFile)(process.execPath,
          ['--import', pathToFileURL(join(cwd, 'node_modules/tsx/dist/loader.mjs')).href,
            '--input-type=module', '-e',
            `import { run } from ${JSON.stringify(pathToFileURL(join(cwd, 'src/cli.ts')).href)}; await run(['node','saivage','gc-work','--dry-run']);`],
          { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000, killSignal: 'SIGKILL' });
         expect(WorkGcResponseSchema.parse(JSON.parse(child.stdout))).toMatchObject({ disposition: 'completed', result: { would_delete_count: 2, first_global_protection: null } });
        expect(child.stderr).toContain('GC inventory elapsed_ms=');
        expect(child.stderr).toContain('GC selection elapsed_ms=');
        expect(child.stderr).not.toContain('"disposition"');
        expect(snapshot(join(root, '.saivage'))).toEqual(before);
      }
      const progress = jest.spyOn(process.stderr, 'write').mockImplementation(text => {
        expect(output.mock.calls).toHaveLength(0);
        expect(String(text)).toMatch(/^GC (inventory|settling|validation_marking|selection) elapsed_ms=\d+/u);
        return true;
      });
      await run(['node', 'saivage', 'gc-work', ...flags]);
      expect([...new Set(progress.mock.calls.map(([text]) => String(text).split(' ')[1]))])
        .toEqual(['inventory', 'settling', 'validation_marking', 'selection']);
      progress.mockRestore();
      reports.push(JSON.parse(output.mock.calls.at(-1)![0] as string));
      output.mockRestore();
       expect(reports.at(-1)).toMatchObject({ disposition: 'completed', restoration: 'not_resumed',
         result: { retained: { protected: 1 }, first_global_protection: null } });
      expect(app.runtimeApi.getStatus().status).toBe('paused');
      expect(readFileSync(retained, 'utf8')).toBe('historical evidence');
      if (flags.includes('--delete')) expect(existsSync(historical)).toBe(false);
      else expect(readFileSync(historical, 'utf8')).toBe('old accepted evidence');
      expect(existsSync(dirname(garbage))).toBe(true);
      if (flags.includes('--delete')) expect(existsSync(garbage)).toBe(false);
      else expect(snapshot(join(root, '.saivage'))).toEqual(before);
      // Equivalent independent fixtures exercise the actual CLI filter transport,
      // inventory-to-mark change, strict cutoff and target stop in both effect modes.
      const filterRoot = dirname(garbage);
      for (const name of ['filter-old-a', 'filter-old-b', 'filter-equal', 'filter-new', 'filter-stale']) {
        const path = join(filterRoot, name); writeFileSync(path, '1234');
        const time = name === 'filter-equal' ? 2 : name === 'filter-new' ? 3 : 1;
        utimesSync(path, time, time);
      }
      // Make the preceding deletion fixture equivalent again, without replaying a preview.
      if (!existsSync(garbage)) writeFileSync(garbage, 'disposable');
      if (!existsSync(historical)) writeFileSync(historical, 'old accepted evidence');
      const originalRun = app.runWorkGc.bind(app);
      const atInventory = jest.spyOn(app, 'runWorkGc').mockImplementation(input => originalRun({ ...input,
        inventory: async signal => { const found = await input.inventory(signal); appendFileSync(join(filterRoot, 'filter-stale'), 'changed'); return found; },
      }));
      const filteredOutput = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // Accounted bytes minus one eligible four-byte file; the second is target-retained.
        const total = ['garbage.txt', 'evidence.txt', 'accepted-history.txt', 'filter-old-a', 'filter-old-b', 'filter-equal', 'filter-new', 'filter-stale']
          .reduce((sum, name) => sum + lstatSync(join(filterRoot, name)).size, 0);
        await run(['node', 'saivage', 'gc-work', ...flags, '--before', '1970-01-01T00:00:02Z', '--target-bytes', String(total - 4)]);
        const report = JSON.parse(filteredOutput.mock.calls.at(-1)![0] as string) as WorkGcResponse;
        filteredReports.push(report);
        expect(report.result).toMatchObject({ retained: { protected: 1, recent: 4, stale: 1, target: 1 }, accounted_target_shortfall: 0 });
        expect(existsSync(join(filterRoot, 'filter-old-a'))).toBe(!flags.includes('--delete'));
        expect(existsSync(join(filterRoot, 'filter-old-b'))).toBe(true);
      } finally { atInventory.mockRestore(); filteredOutput.mockRestore(); }
      for (const name of ['filter-old-a', 'filter-old-b', 'filter-equal', 'filter-new', 'filter-stale'])
        rmSync(join(filterRoot, name), { force: true });
      if (!flags.length) {
        // Actual collection/hold settlement must precede a blocked final write.
        // Use real writable pressure, not Fastify inject's buffered response.
        const stream = new ContractFrameStream(WorkGcFrameSchema);
        let slow = true;
        const callbacks: Array<() => void> = [];
        const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
          if (slow) callbacks.push(callback); else callback();
        } });
        stream.body.pipe(sink);
        while (!stream.body.writableNeedDrain)
          stream.optional({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, first_global_protection: null } });
        expect(stream.body.writableNeedDrain).toBe(true);
        const terminal = deferred<void>(), transportSettled = deferred<void>();
        const finish = stream.finish.bind(stream);
        jest.spyOn(stream, 'finish').mockImplementation(async (frame, signal) => {
          terminal.resolve();
          try { await finish(frame, signal); } finally { transportSettled.resolve(); }
        });
        const raw = new EventEmitter(), reply = new EventEmitter();
        const handler = buildWorkGcOperatorContractHandlers(app)['runtime.gcWork'];
        try {
          handler({ body: { mode: 'dry_run' }, request: { raw }, reply: { raw: reply,
            createStream: () => stream } } as unknown as Parameters<typeof handler>[0]);
          await terminal.promise;
          expect(stream.body.writableNeedDrain).toBe(true);
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          expect(app.runtimeApi.getStatus().status).toBe('paused');
          // A fresh invocation is admitted while the preceding transport is stuck.
          await expect(app.collectWorkGarbage({ mode: 'dry_run' }, new AbortController().signal))
            .resolves.toMatchObject({ disposition: 'completed', restoration: 'not_resumed' });
          reply.emit('close'); await transportSettled.promise;
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(raw.listenerCount('aborted')).toBe(0); expect(reply.listenerCount('close')).toBe(0);
          expect(stream.body.destroyed).toBe(true);
        } finally { slow = false; for (const callback of callbacks.splice(0)) callback(); stream.body.destroy(); sink.destroy(); }

        for (const mode of ['dry_run', 'delete'] as const) {
          const abortSelection = new AbortController();
          const cancelled = await app.collectWorkGarbage({ mode }, abortSelection.signal, progress => {
            if (progress.phase === 'selection') abortSelection.abort(new Error('Synthetic selection cancellation'));
          });
          expect(cancelled).toMatchObject({ disposition: 'interrupted', reason: 'cancelled',
            restoration: 'not_resumed', failure: null, result: { deleted_count: 0, would_delete_count: 0 } });
          expect(existsSync(garbage)).toBe(true);
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
        }

        // Cancellation during the held collection callback cannot release admission
        // until that callback has actually settled, even after abort is observed.
        const selecting = deferred<void>(), cancelObserved = deferred<void>(), releaseCollector = deferred<void>();
        const runHeld = app.runWorkGc.bind(app);
        const selection = jest.spyOn(app, 'runWorkGc').mockImplementation(input => runHeld({ ...input,
          collect: async (inventory, signal) => {
            const result = await input.collect(inventory, signal);
            selecting.resolve();
            await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelObserved.resolve(); resolve(); }, { once: true }));
            await releaseCollector.promise; signal.throwIfAborted(); return result;
          },
        }));
        const selectionAbort = new AbortController();
        const selectingTask = app.collectWorkGarbage({ mode: 'dry_run' }, selectionAbort.signal);
        try {
          await selecting.promise; selectionAbort.abort(); await cancelObserved.promise;
          expect(() => app.assertWorkGcIngressAllowed()).toThrow('busy');
          releaseCollector.resolve();
          await expect(selectingTask).resolves.toMatchObject({ disposition: 'interrupted', reason: 'cancelled', restoration: 'not_resumed' });
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
        } finally { selectionAbort.abort(); releaseCollector.resolve(); await selectingTask; selection.mockRestore(); }

        // Reservation is visible synchronously while inventory has no maintenance
        // authority. Abort joins the inventory callback before releasing reservation.
        const inventoried = deferred<void>(), releaseInventory = deferred<void>(), inventorySettled = deferred<void>();
        const original = app.runWorkGc.bind(app);
        const suspended = jest.spyOn(app, 'runWorkGc').mockImplementation(input => original({ ...input,
          inventory: async signal => {
            inventoried.resolve();
            await releaseInventory.promise;
            try { signal.throwIfAborted(); return await input.inventory(signal); }
            finally { inventorySettled.resolve(); }
          },
        }));
        const abort = new AbortController();
        const pending = realFetch(`${origin}/api/runtime/gc-work`, { method: 'POST',
          headers: { authorization: 'Bearer synthetic-gc-token', 'content-type': 'application/json' },
          body: '{"mode":"dry_run"}', signal: abort.signal });
        try {
          await inventoried.promise;
          const admitted = await pending;
          expect(admitted.status).toBe(200);
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          const duplicate = await realFetch(`${origin}/api/runtime/gc-work`, { method: 'POST',
            headers: { authorization: 'Bearer synthetic-gc-token', 'content-type': 'application/json' },
            body: '{"mode":"dry_run"}' });
          expect(duplicate.status).toBe(409);
          expect(duplicate.headers.get('content-type')).toContain('application/json');
          expect(await duplicate.json()).toMatchObject({ error: 'WorkGcBusy' });
          abort.abort();
          await expect(admitted.text()).rejects.toThrow();
          expect(() => app.collectWorkGarbage({ mode: 'dry_run' }, new AbortController().signal)).toThrow('busy');
          releaseInventory.resolve(); await inventorySettled.promise; await app.cleanupWorkGc();
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          expect(app.runtimeApi.getStatus().status).toBe('paused');
          expect(snapshot(join(root, '.saivage'))).toEqual(before);
        } finally { abort.abort(); releaseInventory.resolve(); await app.cleanupWorkGc(); suspended.mockRestore(); }
        // Real socket cancellation crosses Fastify's close hook and joins the actual
        // application GC task without cancelling the independently owned wait.
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const settling = deferred<void>(), releaseSettlement = deferred<void>();
        const naturalWait = jest.spyOn(app.analystRuntime, 'awaitNaturalTurnCompletion').mockImplementation(() => {
          settling.resolve(); return releaseSettlement.promise;
        });
        const child = spawn(process.execPath,
          ['--import', pathToFileURL(join(cwd, 'node_modules/tsx/dist/loader.mjs')).href,
            '--input-type=module', '-e',
            `import { run } from ${JSON.stringify(pathToFileURL(join(cwd, 'src/cli.ts')).href)}; await run(['node','saivage','gc-work','--delete']);`],
          { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        let interruptedOutput = '';
        child.stdout.on('data', chunk => { interruptedOutput += String(chunk); });
        try {
          await settling.promise;
          child.kill(signal);
          expect(await exited).toEqual([1, null]);
          expect(interruptedOutput).toBe('');
          for (let i = 0; i < 1000; i++) {
            try { app.assertWorkGcIngressAllowed(); break; }
            catch { await new Promise<void>(resolve => setImmediate(resolve)); }
          }
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          await app.cleanupWorkGc();
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          expect(app.runtimeApi.getStatus().status).toBe('paused');
          expect(snapshot(join(root, '.saivage'))).toEqual(before);
        } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); releaseSettlement.resolve(); naturalWait.mockRestore(); }
        }
        // A preview is not saved deletion authority. Publish a new canonical reference
        // and invoke an independent real CLI delete against a fresh mark.
        author.acceptRecord('project', 'review-new-reference.md', 'tmp:///project/garbage.txt', { kind: 'agent', agent: 'analyst' });
        const freshOutput = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await run(['node', 'saivage', 'gc-work', '--delete']);
          expect(JSON.parse(freshOutput.mock.calls.at(-1)![0] as string)).toMatchObject({
            disposition: 'completed', result: { deleted_count: 1, retained: { protected: 2 } },
          });
          expect(readFileSync(garbage, 'utf8')).toBe('disposable');
        } finally { freshOutput.mockRestore(); }
        // Exercise the real application task and Supervisor exclusion while the collect
        // callback yields; no second implementation of the maintenance hold in this fixture.
        const entered = deferred<void>(), release = deferred<void>();
        const held = app.runWorkGc({ signal: new AbortController().signal,
          inventory: async () => undefined,
          collect: async (_inventory, signal) => {
            entered.resolve(); await release.promise; signal.throwIfAborted();
          },
        });
        const settled = held.catch(error => error);
        try {
          await entered.promise;
          expect((await realFetch(`${origin}/health`)).status).toBe(200);
          const file = await realFetch(`${origin}/api/files/content?path=${encodeURIComponent('.saivage/work/cards/project/tmp/evidence.txt')}`,
            { headers: { authorization: 'Bearer synthetic-gc-token' } });
          expect(file.status).toBe(200);
          expect(await file.text()).toContain('historical evidence');
          await expect(run(['node', 'saivage', 'gc-work', '--delete'])).rejects.toThrow('busy');
          expect(() => app.runtimeApi.resume()).toThrow('busy');
          await expect(app.runtimeApi.startProject()).rejects.toThrow('busy');
          await expect(app.analystRuntime.submit({ userContent: 'must not be admitted' })).rejects.toThrow('busy');
          app.runtimeApi.pause();
          const stopped = app.runtimeApi.stopProject();
          release.resolve();
          expect(await settled).toBeInstanceOf(Error);
          await stopped;
          expect(app.runtimeApi.getStatus().status).toBe('stopped');
          expect(existsSync(garbage)).toBe(true);
        } finally { release.resolve(); await settled; }
      }
      if (flags.length) {
        const privateSentinel = 'PRIVATE-online-global-source';
        author.acceptRecord('project', 'review-global.md', JSON.stringify({ source_path: `*${privateSentinel}` }), { kind: 'agent', agent: 'analyst' });
        const globalOutput = jest.spyOn(console, 'log').mockImplementation(() => {});
        const globalProgress = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          await run(['node', 'saivage', 'gc-work', '--dry-run']);
          const result = WorkGcResponseSchema.parse(JSON.parse(globalOutput.mock.calls.at(-1)![0] as string));
          expect(result).toMatchObject({ disposition: 'completed', result: { first_global_protection: {
            reason: 'reference_scope_unknown', source: 'record_content' }, observed_count: 3, would_delete_count: 0, retained: { protected: 3 } } });
          const stderr = globalProgress.mock.calls.map(([text]) => String(text)).join('');
          expect(stderr).toContain('first_global_protection=reason:reference_scope_unknown,source:record_content');
          expect(stderr).not.toContain('[object Object]');
          expect(stderr + JSON.stringify(result)).not.toContain(privateSentinel);
          expect(() => app.assertWorkGcIngressAllowed()).not.toThrow();
          const abortGlobal = new AbortController();
          const partial = await app.collectWorkGarbage({ mode: 'dry_run' }, abortGlobal.signal, progress => {
            if (progress.phase === 'selection') abortGlobal.abort();
          });
          expect(partial).toMatchObject({ disposition: 'interrupted', reason: 'cancelled', result: {
            first_global_protection: { reason: 'reference_scope_unknown', source: 'record_content' }, would_delete_count: 0 } });
        } finally { globalProgress.mockRestore(); globalOutput.mockRestore(); }
        const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
        const path = cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
        appendFileSync(path, '{torn');
        const tornSnapshot = snapshot(join(root, '.saivage'));
        const tailOutput = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await run(['node', 'saivage', 'gc-work', ...flags]);
          expect(JSON.parse(tailOutput.mock.calls.at(-1)![0] as string)).toMatchObject({ disposition: 'refused', result: null });
          expect(snapshot(join(root, '.saivage'))).toEqual(tornSnapshot);
        } finally { tailOutput.mockRestore(); }
      }
    } finally {
      process.chdir(cwd);
      await server.close();
      app.closeRuntimeAdmission(); app.closeAnalystAdmission(); app.closeOversightAdmission();
      await app.cleanupWorkGc();
      await app.cleanupRuntimeForApplicationStop();
      await app.cleanupAnalystForApplicationStop(); await app.cleanupOversightForApplicationStop();
      releaseRuntimeLifecycleLock(lock);
      rmSync(root, { recursive: true, force: true });
    }
  }
  expect(reports[0]).toEqual(reports[1]);
  expect(filteredReports[0]).toEqual(filteredReports[1]);
  expect(filteredReports[2]!.result!.deleted_logical_bytes).toBe(filteredReports[0]!.result!.would_delete_logical_bytes);
  expect(filteredReports[2]!.result!.retained).toEqual(filteredReports[0]!.result!.retained);
  expect(reports[0]!.result).toMatchObject({ would_delete_count: 2, would_delete_logical_bytes: 31, deleted_count: 0 });
  expect(reports[2]!.result).toMatchObject({ deleted_count: 2, deleted_logical_bytes: 31, would_delete_count: 0 });
  expect(reports[2]!.result!.expected_accounted_logical_bytes_remaining)
    .toBe(reports[0]!.result!.expected_accounted_logical_bytes_remaining);
}, 30_000);
