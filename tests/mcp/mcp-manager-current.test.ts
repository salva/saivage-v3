import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { McpManager, ServerNotRunningError } from '../../src/mcp/mcp-manager.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots:string[]=[];
afterEach(()=>{jest.restoreAllMocks();while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

function root():string{const value=mkdtempSync(join(tmpdir(),'mcp-current-'));roots.push(value);mkdirSync(join(value,'.saivage'),{recursive:true});return value;}
function writeConfig(projectRoot:string,mcpServers:Record<string,unknown>):void{writeFileSync(join(projectRoot,'.saivage','saivage.yaml'),YAML.stringify({...structuredClone(TEST_SAIVAGE_CONFIG),mcpServers}));}
function response(id:number,result:unknown):Response{return new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{status:200,headers:{'content-type':'application/json'}});}
function successfulFetch(){return jest.fn(async(_url:string|URL,init?:RequestInit)=>{if(init?.method==='HEAD')return new Response(null,{status:200});const request=JSON.parse(String(init?.body)) as {id:number;method:string};if(request.method==='notifications/initialized')return new Response(null,{status:202});if(request.method==='initialize')return response(request.id,{protocolVersion:'2025-06-18'});if(request.method==='tools/list')return response(request.id,{tools:[{name:'ping',inputSchema:{type:'object',properties:{}}}]});return response(request.id,{content:['pong']});});}
function manager(projectRoot:string){const registry=new ManagedProcessGroupRegistry();const scope=registry.createContainerScope(registry.rootScope,'mcp-servers');const runner=new ProcessRunner(projectRoot,registry);return{value:new McpManager({configAuthority:testConfigAuthority(projectRoot),processRunner:runner,mcpProcessRootScope:scope,eventLogger:{appendEvent(){}} as never}),runner,scope};}

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

  it('closes invocation admission synchronously and contains runtime work on cleanup',async()=>{
    const projectRoot=root();writeConfig(projectRoot,{one:{transport:'streamable-http',url:'http://localhost/mcp',autostart:true,disabled:false}});globalThis.fetch=successfulFetch() as typeof fetch;const {value}=manager(projectRoot);await value.reconcilePersistedConfig();value.closeAdmission();
    await expect(value.reconcilePersistedConfig()).rejects.toThrow('closed');
    await expect(value.invokeTool('one','ping',{})).rejects.toBeInstanceOf(ServerNotRunningError);
    await expect(value.cleanupForApplicationStop()).resolves.toBeUndefined();
    expect(value.getStatus()).toEqual([]);
  });
});
