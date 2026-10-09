import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as YAML from 'yaml';

import { McpManager } from '../../src/mcp/mcp-manager.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { ServerNotRunningError, TransportError } from '../../src/mcp/errors.js';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { ProcessRunner, type ProcessRecord, type ProcessStopReport, type ProcessWaitResult } from '../../src/runtime/process-runner.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots:string[]=[];
afterEach(()=>{jest.restoreAllMocks();while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

function root():string{const value=mkdtempSync(join(tmpdir(),'mcp-current-'));roots.push(value);mkdirSync(join(value,'.saivage'),{recursive:true});return value;}
function writeConfig(projectRoot:string,mcpServers:Record<string,unknown>):void{writeFileSync(join(projectRoot,'.saivage','saivage.yaml'),YAML.stringify({...structuredClone(TEST_SAIVAGE_CONFIG),mcpServers}));}
function response(id:number,result:unknown):Response{const bytes=JSON.stringify({jsonrpc:'2.0',id,result});const value=new Response(bytes,{status:200,headers:{'content-type':'application/json'}});value.json=async()=>JSON.parse(bytes);return value;}
function successfulFetch(){return jest.fn(async(_url:string|URL,init?:RequestInit)=>{if(init?.method==='HEAD')return new Response(null,{status:200});const request=JSON.parse(String(init?.body)) as {id:number;method:string};if(request.method==='notifications/initialized')return new Response(null,{status:202});if(request.method==='initialize')return response(request.id,{protocolVersion:'2025-06-18'});if(request.method==='tools/list')return response(request.id,{tools:[{name:'ping',inputSchema:{type:'object',properties:{}}}]});return response(request.id,{content:['pong']});});}
function manager(projectRoot:string){const registry=new ManagedProcessGroupRegistry();const scope=registry.createContainerScope(registry.rootScope,'mcp-servers');const runner=new ProcessRunner(projectRoot,registry,testApplicationFatalPort);return{value:new McpManager({configAuthority:testConfigAuthority(projectRoot),processRunner:runner,mcpProcessRootScope:scope,eventLogger:{appendEvent(){}} as never}),runner,scope};}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const emptyReport: ProcessStopReport = { selected: [], stopped: [], failed: [] };

describe('current named-agent MCP manager contract',()=>{
  it.each(['success', 'report', 'rejection'] as const)('joins actual discovery rejection containment (%s) before settlement or replacement', async mode => {
    const projectRoot = root(); writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false } });
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      const request = JSON.parse(String(init?.body)); methods.push(request.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32003, message: 'secret discovery detail' } }));
    }) as typeof fetch;
    const { value, runner } = manager(projectRoot);
    const containment = deferred<ProcessStopReport>(); const entered = deferred<void>();
    const realTerminate = runner.closeAndTerminateDirectScope.bind(runner);
    jest.spyOn(runner, 'closeAndTerminateDirectScope').mockImplementation(async input => {
      entered.resolve(); const report = await containment.promise;
      if (mode === 'success') await realTerminate(input);
      return report;
    });
    try {
      let settled = false;
      const observed = value.startServer('one').catch(error => { settled = true; return error; });
      await entered.promise;
      expect(settled).toBe(false); expect(value.getServerTools('one')).toBeUndefined();
      await expect(value.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
      const failure = new Error('exact containment failure');
      if (mode === 'rejection') containment.reject(failure);
      else containment.resolve(mode === 'report' ? { ...emptyReport, failed: [{ groupId: 'group', state: 'unconfirmed', diagnostic: 'fixture containment failure' }] } : emptyReport);
      const error = await observed;
      if (mode === 'success') {
        expect(error).toBeInstanceOf(TransportError);
        expect(error.message).not.toContain('secret discovery detail');
        expect(methods).toEqual(['initialize']);
        globalThis.fetch = successfulFetch() as typeof fetch;
        await expect(value.startServer('one')).resolves.toMatchObject({ status: 'running', toolCount: 1 });
        await value.cleanupForApplicationStop();
      } else {
        if (mode === 'rejection') expect(error).toBe(failure);
        else expect(error.message).toContain('containment failed');
        expect(error).not.toBeInstanceOf(TransportError);
        await expect(value.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
        expect(methods).toEqual(['initialize']);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
  it('preserves unknown startup fetch failure identity and fails autostart on classified discovery rejection', async () => {
    const projectRoot = root(); writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp' } });
    const originalFetch = globalThis.fetch;
    try {
      const failure = new TypeError('unknown fetch rejection');
      globalThis.fetch = jest.fn(async () => { throw failure; }) as typeof fetch;
      const first = manager(projectRoot);
      await expect(first.value.startServer('one')).rejects.toBe(failure);
      await first.value.cleanupForApplicationStop();
      globalThis.fetch = jest.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
      const second = manager(projectRoot);
      await expect(second.value.reconcilePersistedConfig()).resolves.toMatchObject({ converged: false, pending: [{ name: 'one', operation: 'add' }] });
      expect(second.value.getServerTools('one')).toBeUndefined();
      await second.value.cleanupForApplicationStop();
    } finally { globalThis.fetch = originalFetch; }
  });
  it('does not follow startup publication uncertainty with a second stop or reconciliation work', async () => {
    const projectRoot = root(); writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp' } });
    const failure = new PublicationOutcomeUnknownError();
    jest.spyOn(McpServerRuntime.prototype, 'start').mockRejectedValue(failure);
    const stop = jest.spyOn(McpServerRuntime.prototype, 'stop');
    const { value } = manager(projectRoot);
    await expect(value.reconcilePersistedConfig()).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });
  it('starts only the exact current entry, rejects changed/disabled/busy and restarts only after explicit stop', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false }, disabled: { transport: 'stdio', command: 'unused', disabled: true } });
    globalThis.fetch = successfulFetch() as typeof fetch;
    const { value } = manager(projectRoot);
    await expect(value.startServer('absent')).rejects.toMatchObject({ statusCode: 404 });
    await expect(value.startServer('disabled')).rejects.toMatchObject({ statusCode: 409 });
    expect(await value.startServer('one')).toEqual({ serverName: 'one', status: 'running', toolCount: 1 });
    expect(await value.startServer('one')).toEqual({ serverName: 'one', status: 'running', toolCount: 1 });
    // Unrelated workflows and other server entries are not consumed at on-demand start.
    writeFileSync(join(projectRoot, '.saivage/saivage.yaml'), YAML.stringify({ agents: 'invalid-unrelated', mcpServers: { one: { transport: 'streamable-http', url: 'http://localhost/changed', autostart: false }, unrelated: 'invalid' } }));
    await expect(value.startServer('one')).rejects.toThrow('Stop before');
    await expect(value.stopServer('absent')).rejects.toMatchObject({ statusCode: 404 });
    expect(await value.stopServer('one')).toEqual({ serverName: 'one', status: 'stopped', toolCount: 0 });
    expect(value.getServerTools('one')).toBeUndefined();
    expect(await value.startServer('one')).toEqual({ serverName: 'one', status: 'running', toolCount: 1 });
    expect(value.getStatus()).toHaveLength(1);
    await value.cleanupForApplicationStop();
  });

  it('stops startup without a global queue, joins inner work before clearing and retains failed containment', async () => {
    const projectRoot = root(); writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp' } });
    const entered = deferred<void>(); const release = deferred<void>();
    globalThis.fetch = jest.fn(async (_url, options: RequestInit | undefined) => {
      entered.resolve(); await release.promise; options!.signal!.throwIfAborted(); return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { value, runner } = manager(projectRoot);
    const start = value.startServer('one').catch(error => error); await entered.promise;
    await expect(value.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
    let stopped = false; const stop = value.stopServer('one').then(() => { stopped = true; });
    let cleaned = false; const cleanup = value.cleanupForApplicationStop().then(() => { cleaned = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false); expect(cleaned).toBe(false); expect(value.getStatus()).toHaveLength(1);
    await expect(value.startServer('one')).rejects.toThrow('closed');
    release.resolve(); await Promise.all([start, stop, cleanup]); expect(value.getStatus()).toEqual([]);

    const other = manager(projectRoot); globalThis.fetch = successfulFetch() as typeof fetch;
    await other.value.startServer('one');
    const failure = new Error('exact containment failure');
    jest.spyOn(other.runner, 'closeAndTerminateDirectScope').mockRejectedValue(failure);
    await expect(other.value.stopServer('one')).rejects.toBe(failure);
    expect(other.value.getServerTools('one')).toBeUndefined();
    await expect(other.value.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
    expect(other.value.getStatus()).toHaveLength(1);
  });

  it('uses one install-inclusive 180-second budget, not ten seconds or a timer per phase', async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    try {
      const projectRoot = root(); writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp' } });
      const delayed = (ms: number, signal: AbortSignal, result: Response) => new Promise<Response>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(result); }, ms);
        signal.addEventListener('abort', abort, { once: true });
      });
      const successful = successfulFetch();
      globalThis.fetch = jest.fn(async (url: string | URL, options?: RequestInit) => options?.method === 'HEAD'
        ? delayed(11_000, options.signal as AbortSignal, new Response(null, { status: 200 })) : successful(url, options)) as typeof fetch;
      const first = manager(projectRoot); const start = first.value.startServer('one');
      await jest.advanceTimersByTimeAsync(11_000); await expect(start).resolves.toMatchObject({ status: 'running' });
      await first.value.cleanupForApplicationStop();
      globalThis.fetch = jest.fn(async (_url, options?: RequestInit) => delayed(options?.method === 'HEAD' ? 100_000 : 90_000, options!.signal as AbortSignal, new Response(null, { status: 200 }))) as typeof fetch;
      const second = manager(projectRoot); const exhausted = second.value.startServer('one').catch(error => error);
      await jest.advanceTimersByTimeAsync(180_000);
      expect(await exhausted).toMatchObject({ code: 'TIMEOUT' });
      expect(second.value.getServerStatus('one')).toMatchObject({ status: 'stopped' });
      await second.value.cleanupForApplicationStop();
    } finally { globalThis.fetch = originalFetch; jest.useRealTimers(); }
  });
  it('preserves an equivalent HTTP installation and replaces a changed effective config', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp' } });
    const fetchMock = successfulFetch();
    globalThis.fetch = fetchMock as typeof fetch;
    const { value } = manager(projectRoot);
    const stop = jest.spyOn(McpServerRuntime.prototype, 'stop');
    const expectedRevision = createHash('sha256').update(
      '{"autostart":true,"disabled":false,"transport":"streamable-http","url":"http://localhost/mcp"}',
    ).digest('hex');

    const first = await value.reconcilePersistedConfig();
    expect(first).toEqual(expect.objectContaining({
      converged: true,
      desired: [{ name: 'one', revision: expectedRevision, shouldRun: true }],
      active: [{ name: 'one', revision: expectedRevision, state: 'running' }],
    }));
    const installedStatus = value.getStatus();
    const initializeRequests = () => fetchMock.mock.calls.filter(([, init]) =>
      init?.method !== 'HEAD' && JSON.parse(String(init?.body)).method === 'initialize',
    );
    expect(initializeRequests()).toHaveLength(1);

    writeConfig(projectRoot, { one: {
      disabled: false, url: 'http://localhost/mcp', autostart: true, transport: 'streamable-http',
    } });
    expect(await value.reconcilePersistedConfig()).toEqual(first);
    expect(value.getStatus()).toEqual(installedStatus);
    expect(initializeRequests()).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();

    writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/changed' } });
    const changedRevision = createHash('sha256').update(
      '{"autostart":true,"disabled":false,"transport":"streamable-http","url":"http://localhost/changed"}',
    ).digest('hex');
    expect(changedRevision).not.toBe(expectedRevision);
    expect(await value.reconcilePersistedConfig()).toEqual(expect.objectContaining({
      converged: true,
      desired: [{ name: 'one', revision: changedRevision, shouldRun: true }],
      active: [{ name: 'one', revision: changedRevision, state: 'running' }],
    }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(initializeRequests()).toHaveLength(2);
    await value.cleanupForApplicationStop();
  });

  it('canonically hashes stdio env keys while preserving args order, defaults and absent fields', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { one: {
      transport: 'stdio', command: 'server', autostart: false,
      args: ['first', 'second'], env: { 'é': 'accent', a: 'lower', Z: 'upper' },
    } });
    const { value, runner } = manager(projectRoot);
    const spawn = jest.spyOn(runner, 'spawnInteractive');
    const expectedRevision = createHash('sha256').update(
      '{"args":["first","second"],"autostart":false,"command":"server","disabled":false,"env":{"Z":"upper","a":"lower","é":"accent"},"transport":"stdio"}',
    ).digest('hex');
    const first = await value.reconcilePersistedConfig();
    expect(first).toEqual(expect.objectContaining({
      converged: true,
      desired: [{ name: 'one', revision: expectedRevision, shouldRun: false }],
      active: [{ name: 'one', revision: expectedRevision, state: 'stopped' }],
    }));

    writeConfig(projectRoot, { one: {
      env: { Z: 'upper', a: 'lower', 'é': 'accent' }, args: ['first', 'second'],
      disabled: false, autostart: false, command: 'server', transport: 'stdio',
    } });
    expect(await value.reconcilePersistedConfig()).toEqual(first);

    writeConfig(projectRoot, { one: {
      transport: 'stdio', command: 'server', autostart: false,
      args: ['second', 'first'], env: { a: 'lower', 'é': 'accent', Z: 'upper' },
    } });
    const reversedRevision = createHash('sha256').update(
      '{"args":["second","first"],"autostart":false,"command":"server","disabled":false,"env":{"Z":"upper","a":"lower","é":"accent"},"transport":"stdio"}',
    ).digest('hex');
    expect(reversedRevision).not.toBe(expectedRevision);
    expect((await value.reconcilePersistedConfig()).desired).toEqual([
      { name: 'one', revision: reversedRevision, shouldRun: false },
    ]);

    writeConfig(projectRoot, { one: { transport: 'stdio', command: 'server', autostart: false } });
    const absentRevision = createHash('sha256').update(
      '{"autostart":false,"command":"server","disabled":false,"transport":"stdio"}',
    ).digest('hex');
    const absent = await value.reconcilePersistedConfig();
    expect(absent.desired).toEqual([{ name: 'one', revision: absentRevision, shouldRun: false }]);
    writeConfig(projectRoot, { one: {
      transport: 'stdio', command: 'server', autostart: false, disabled: false,
    } });
    expect(await value.reconcilePersistedConfig()).toEqual(absent);
    expect(spawn).not.toHaveBeenCalled();
    await value.cleanupForApplicationStop();
  });

  it('reconciles persisted HTTP configuration and invokes the provider independently of agent admission',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value}=manager(projectRoot);
    await expect(value.reconcilePersistedConfig()).resolves.toEqual(expect.objectContaining({converged:true,active:[expect.objectContaining({name:'one',state:'running'})]}));
    expect(value.getServerTools('one')).toEqual([expect.objectContaining({name:'ping',inputSchema:{type:'object',properties:{}}})]);
  });

  it('performs no lifecycle mutation when the complete next configuration is invalid',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value}=manager(projectRoot);await value.reconcilePersistedConfig();const status=value.getStatus();writeFileSync(join(projectRoot,'.saivage','saivage.yaml'),YAML.stringify({...structuredClone(TEST_SAIVAGE_CONFIG),mcpServers:'invalid'}));
    await expect(value.reconcilePersistedConfig()).rejects.toThrow();
    expect(value.getStatus()).toEqual(status);
    expect(value.getServerTools('one')).toEqual([expect.objectContaining({name:'ping'})]);
  });

  it('closes open admission once, retrieves containment separately, and waits for all containment',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value,runner}=manager(projectRoot);await value.reconcilePersistedConfig();
    const managerClose = jest.spyOn(value, 'closeAdmission');
    const runtimeClose = jest.spyOn(McpServerRuntime.prototype, 'closeAdmission');
    const containmentAccess = jest.spyOn(McpServerRuntime.prototype, 'directContainment');
    const direct = deferred<ProcessStopReport>();
    const rootTermination = deferred<ProcessStopReport>();
    jest.spyOn(runner, 'closeAndTerminateDirectScope').mockReturnValue(direct.promise);
    const terminateRoot = jest.spyOn(runner, 'terminateScopeTree').mockReturnValue(rootTermination.promise);

    const cleanup = value.cleanupForApplicationStop();
    expect(managerClose).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(containmentAccess).toHaveBeenCalledTimes(1);
    expect(terminateRoot).toHaveBeenCalledTimes(1);
    await expect(value.reconcilePersistedConfig()).rejects.toThrow('closed');
    await expect(value.invokeTool('one','ping',{})).rejects.toBeInstanceOf(ServerNotRunningError);
    direct.resolve(emptyReport);
    await expect(Promise.race([cleanup.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending');
    rootTermination.resolve(emptyReport);
    await expect(cleanup).resolves.toBeUndefined();
    expect(value.getStatus()).toEqual([]);
  });

  it('retrieves the existing containment when application admission was already closed',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value,runner}=manager(projectRoot);await value.reconcilePersistedConfig();
    const managerClose = jest.spyOn(value, 'closeAdmission');
    const runtimeClose = jest.spyOn(McpServerRuntime.prototype, 'closeAdmission');
    const containmentAccess = jest.spyOn(McpServerRuntime.prototype, 'directContainment');
    const direct = deferred<ProcessStopReport>();
    jest.spyOn(runner, 'closeAndTerminateDirectScope').mockReturnValue(direct.promise);
    jest.spyOn(runner, 'terminateScopeTree').mockResolvedValue(emptyReport);

    value.closeAdmission();
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(containmentAccess).not.toHaveBeenCalled();
    const cleanup = value.cleanupForApplicationStop();
    expect(managerClose).toHaveBeenCalledTimes(2);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(containmentAccess).toHaveBeenCalledTimes(1);
    direct.resolve(emptyReport);
    await expect(cleanup).resolves.toBeUndefined();
    expect(value.getStatus()).toEqual([]);
  });

  it('fails fast when containment is requested before admission closes',()=>{
    const runtime = new McpServerRuntime({
      name: 'one',
      config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: true, disabled: false },
      revision: 'revision', processRunner: {}, processScope: {}, ids: { next: () => 1 }, invocationStats: {},
    } as never);
    expect(() => runtime.directContainment()).toThrow("MCP server 'one' admission has not been closed.");
  });

  it('application cleanup joins admitted inner request work before clearing retained owners', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { one: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: true, disabled: false } });
    globalThis.fetch = successfulFetch() as typeof fetch;
    const { value } = manager(projectRoot);
    await value.reconcilePersistedConfig();
    const body = deferred<void>();
    const entered = deferred<void>();
    globalThis.fetch = jest.fn(async () => {
      entered.resolve();
      return new Response(new ReadableStream<Uint8Array>({ cancel: () => body.promise }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const call = value.invokeTool('one', 'ping', {}).catch(error => error);
    await entered.promise;
    let cleaned = false;
    const cleanup = value.cleanupForApplicationStop().then(() => { cleaned = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(cleaned).toBe(false);
    expect(value.getServerTools('one')).toBeUndefined();
    expect(value.getStatus()).toHaveLength(1);
    body.resolve();
    await Promise.all([call, cleanup]);
    expect(value.getStatus()).toEqual([]);
  });

  it('preserves root termination failure precedence and retains runtimes after failure',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value,runner}=manager(projectRoot);await value.reconcilePersistedConfig();
    const directFailure = new Error('direct containment failed');
    const rootFailure = new Error('root termination failed');
    const direct = deferred<ProcessStopReport>();
    const rootTermination = deferred<ProcessStopReport>();
    jest.spyOn(runner, 'closeAndTerminateDirectScope').mockReturnValue(direct.promise);
    jest.spyOn(runner, 'terminateScopeTree').mockReturnValue(rootTermination.promise);
    const cleanup = value.cleanupForApplicationStop();
    direct.reject(directFailure);
    await expect(Promise.race([cleanup.then(() => 'settled', () => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending');
    rootTermination.reject(rootFailure);
    await expect(cleanup).rejects.toBe(rootFailure);
    expect(value.getStatus()).toHaveLength(1);
  });

  it('projects a stdio capture-settlement rejection as error and retires the consumed launch', async () => {
    const captureFailure = new Error('capture failed');
    const terminal = deferred<ProcessWaitResult>();
    const process = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
    const record: ProcessRecord = {
      id: 'proc-capture', card_id: null, owner_id: 'mcp:one', owner_kind: 'runtime', agent_session_id: null,
      command: 'server', cwd: '/project', status: 'running', started_at: '2026-01-01T00:00:00.000Z', completed_at: null,
      evidence: { group: 'tracked', group_diagnostic: null, leader_exit: null, leader_error: null, stdout: 'not_captured', stderr: 'not_captured', stdout_error: null, stderr_error: null },
      exit_code: null, signal: null, stdout_path: '/stdout', stderr_path: '/stderr',
    };
    const processScope = {} as never;
    const processRunner = {
      spawnInteractive: jest.fn(() => ({ process, record })),
      get: jest.fn(() => record),
      waitForSettlement: jest.fn(() => terminal.promise),
      retireSettled: jest.fn(),
      closeAndTerminateDirectScope: jest.fn(async () => emptyReport),
    };
    const runtime = new McpServerRuntime({
      name: 'one', config: { transport: 'stdio', command: 'server', autostart: true, disabled: false }, revision: 'revision',
      processRunner: processRunner as never, processScope, ids: { next: () => 1 }, invocationStats: {} as never,
    });

    const startStdio = Reflect.get(runtime, 'startStdio') as (config: { transport: 'stdio'; command: string; autostart: boolean; disabled: boolean }, generation: number, signal: AbortSignal) => void;
    startStdio.call(runtime, runtime.config as never, 0, new AbortController().signal);
    terminal.reject(captureFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.getStatus()).toEqual(expect.objectContaining({ status: 'error', error: 'Process output capture failed' }));
    expect(runtime.isRunning()).toBe(false);
    expect(processRunner.retireSettled).toHaveBeenCalledWith(record.id, processScope);
  });

  it('retires each short-lived stdio launch and projects its actual terminal result in its own revision scope', async () => {
    const projectRoot = root();
    const registry = new ManagedProcessGroupRegistry();
    const mcpRoot = registry.createContainerScope(registry.rootScope, 'mcp');
    const processRunner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
    const wait = processRunner.waitForSettlement.bind(processRunner);
    let observed: Promise<ProcessWaitResult>;
    jest.spyOn(processRunner, 'waitForSettlement').mockImplementation(id => { observed = wait(id); return observed; });
    const config = { transport: 'stdio' as const, command: '/bin/sh', args: ['-c', 'exit 0'], autostart: true, disabled: false };

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const processScope = registry.createDirectScope(mcpRoot, `one:revision:${cycle}`, 'service_infrastructure');
      const runtime = new McpServerRuntime({ name: 'one', config, revision: 'revision', processRunner, processScope, ids: { next: () => 1 }, invocationStats: {} as never });
      const startStdio = Reflect.get(runtime, 'startStdio') as (selected: typeof config, generation: number, signal: AbortSignal) => void;
      startStdio.call(runtime, config, 0, new AbortController().signal);
      for (let attempt = 0; attempt < 100 && processRunner.list().length > 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      // EOF can cause containment before the shell's exit reaches Node. Project the
      // actual retained terminal result, never infer a natural zero exit from EOF.
      const terminal = await observed!;
      expect(runtime.getStatus()).toEqual(expect.objectContaining({ status: terminal.record.status === 'exited' ? 'stopped' : 'error' }));
      expect(processRunner.list()).toEqual([]);
      await runtime.stop();
    }

  });
});
