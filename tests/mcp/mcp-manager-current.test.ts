import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as YAML from 'yaml';

import { McpManager } from '../../src/mcp/mcp-manager.js';
import { ServerNotRunningError } from '../../src/mcp/errors.js';
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
function response(id:number,result:unknown):Response{return new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{status:200,headers:{'content-type':'application/json'}});}
function successfulFetch(){return jest.fn(async(_url:string|URL,init?:RequestInit)=>{if(init?.method==='HEAD')return new Response(null,{status:200});const request=JSON.parse(String(init?.body)) as {id:number;method:string};if(request.method==='notifications/initialized')return new Response(null,{status:202});if(request.method==='initialize')return response(request.id,{protocolVersion:'2025-06-18'});if(request.method==='tools/list')return response(request.id,{tools:[{name:'ping',inputSchema:{type:'object',properties:{}}}]});return response(request.id,{content:['pong']});});}
function manager(projectRoot:string){const registry=new ManagedProcessGroupRegistry();const scope=registry.createContainerScope(registry.rootScope,'mcp-servers');const runner=new ProcessRunner(projectRoot,registry,testApplicationFatalPort);return{value:new McpManager({configAuthority:testConfigAuthority(projectRoot),processRunner:runner,mcpProcessRootScope:scope,eventLogger:{appendEvent(){}} as never}),runner,scope};}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const emptyReport: ProcessStopReport = { selected: [], stopped: [], failed: [] };

describe('current named-agent MCP manager contract',()=>{
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
      exit_code: null, signal: null, stdout_path: '/stdout', stderr_path: '/stderr',
    };
    const processScope = {} as never;
    const processRunner = {
      spawnInteractive: jest.fn(() => ({ process, record })),
      waitForSettlement: jest.fn(() => terminal.promise),
      retireSettled: jest.fn(),
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

  it('retires each naturally exited stdio launch while reusing one open revision scope', async () => {
    const projectRoot = root();
    const registry = new ManagedProcessGroupRegistry();
    const mcpRoot = registry.createContainerScope(registry.rootScope, 'mcp');
    const processScope = registry.createDirectScope(mcpRoot, 'one:revision', 'service_infrastructure');
    const processRunner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
    const config = { transport: 'stdio' as const, command: '/bin/sh', args: ['-c', 'exit 0'], autostart: true, disabled: false };
    const runtime = new McpServerRuntime({ name: 'one', config, revision: 'revision', processRunner, processScope, ids: { next: () => 1 }, invocationStats: {} as never });
    const startStdio = Reflect.get(runtime, 'startStdio') as (selected: typeof config, generation: number, signal: AbortSignal) => void;

    for (let cycle = 0; cycle < 2; cycle += 1) {
      startStdio.call(runtime, config, 0, new AbortController().signal);
      for (let attempt = 0; attempt < 100 && processRunner.list().length > 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(runtime.getStatus()).toEqual(expect.objectContaining({ status: 'stopped' }));
      expect(processRunner.list()).toEqual([]);
    }

    await processRunner.closeAndTerminateDirectScope({ directScope: processScope, category: 'service_infrastructure', reason: 'test complete' });
  });
});
