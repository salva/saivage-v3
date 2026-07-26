import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { McpManager, ServerNotRunningError } from '../../src/mcp/mcp-manager.js';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { ProcessRunner, type ProcessStopReport } from '../../src/runtime/process-runner.js';
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
});
