import { afterEach, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp, type App } from '../../src/boot/app.js';
import { AnalystDisabledError } from '../../src/runtime/runtime-api.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { surfaceToolDefinitions } from '../../src/tools/tool-api.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { buildGlobalAgentIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { currentConversationSegmentPath } from '../helpers/current-conversation-segment-path.js';
import { globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { productionTestConfig, writeProductionConfig, initializeProject, listen, closeServer, appOrigin, waitFor, readJsonRequest, sendFinalMessage, sendToolCall } from '../helpers/production-composition-e2e.js';

const apps:App[]=[]; const roots:string[]=[]; const clients:Client[]=[];
afterEach(async()=>{for(const client of clients.splice(0))await client.close();for(const app of apps.splice(0))await app.stop();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

async function fixture(mode:'external'|'both'='external',providerPort=1, customize?: Parameters<typeof productionTestConfig>[1],mainHost='127.0.0.1') {
  const root=mkdtempSync(join(tmpdir(),'external-mcp-'));roots.push(root);
  const reservation=createServer();const port=await listen(reservation);await closeServer(reservation);
  const config=productionTestConfig(providerPort,config=>{
    if(mode==='external') {
      config.models.routes[config.agents[config.analyst_agent]!.model_route]!.candidates=['unavailable-analyst-model'];
      config.agents[config.analyst_agent]!.tools.push('view_image','mcp_catalog_refresh');
    }
    customize?.(config);
  });
  writeProductionConfig(root,config);initializeProject(root);
  const index=globalAgentConversationVersionIndexFile(root,config.analyst_agent);
  const before=readFileSync(index);
  const app=await startApp({projectRoot:root,createRuntime:false,analystMode:mode,analystMcpPort:String(port),
    analystMcpPrincipal:'test-operator',analystMcpTools:'read,get_card,get_tree,get_status,write,webfetch,queue_notification,start_project,pause_runtime,resume_runtime,stop_project,restart_server,run_command,wait_process,kill_process,mcp_tools,mcp_tool_call'+(mode==='external'?',view_image,mcp_catalog_refresh':''),
    env:{NODE_ENV:'test',LOG_LEVEL:'silent',SAIVAGE_HOST:mainHost,SAIVAGE_PORT:'0',SAIVAGE_API_TOKEN:'rest-synthetic-secret',SAIVAGE_ANALYST_MCP_TOKEN:'mcp-synthetic-secret'}});
  apps.push(app);
  const endpoint=app.server.analystMcpEndpoint!;
  const client=new Client({name:'synthetic-client',version:'1'});
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{authorization:'Bearer mcp-synthetic-secret'}}}));
  return {root,app,client,endpoint,index,before};
}

it('serves the real SDK client without an internal Analyst route, preserving history and direct attribution',async()=>{
  const f=await fixture();
  const initialized=await fetch(f.endpoint,{method:'POST',headers:{authorization:'Bearer mcp-synthetic-secret','content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'untrusted-client',version:'1'},_meta:{principal:'forged-client',model:'forged-model'}}})});
  const initialization=await initialized.json() as {result:{_meta:{saivage:{principal:string;project_identity_digest:string}}}};
  expect(initialization.result._meta.saivage).toMatchObject({principal:'test-operator',project_identity_digest:new URL(f.endpoint).pathname.split('/').at(-1)});
  expect(JSON.stringify(initialization)).not.toContain(f.root);
  expect(JSON.stringify(initialization)).not.toContain('mcp-synthetic-secret');
  expect(JSON.stringify(initialization)).not.toContain('forged-model');
  const tools=await f.client.listTools();
  expect(tools.tools).toEqual(surfaceToolDefinitions(f.app.server.runtimeApplication.externalAnalystOperations!.surface).map(({function:tool})=>({name:tool.name,description:tool.description,inputSchema:{...tool.parameters,type:'object'}})));
  expect(tools.tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['read','write','get_status','mcp_catalog_refresh']));
  expect(tools.tools.some(tool=>tool.name==='delete_card')).toBe(false);
  const resource=await f.client.readResource({uri:'saivage://analyst/context'});
  expect(JSON.parse((resource.contents[0] as {text:string}).text)).toMatchObject({mode:'external',principal:'test-operator'});
  expect(await f.client.callTool({name:'get_status',arguments:{}})).toMatchObject({isError:false});
  expect(await f.client.callTool({name:'get_card',arguments:{id:'project',section:'summary'}})).toMatchObject({isError:false});
  expect(await f.client.callTool({name:'get_tree',arguments:{rootId:'project'}})).toMatchObject({isError:false});
  expect(await f.client.callTool({name:'read',arguments:{path:'record:///brief.md?card=project'}})).toMatchObject({isError:false});
  expect(await f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project',content:'External accepted requirements'}})).toMatchObject({isError:false});
  await expect(f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project',content:42}})).rejects.toThrow('invalid');
  expect(await f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project&v=1',content:'Must not rewrite history'}})).toMatchObject({isError:true});
  expect(await f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project&unknown=1',content:'Must not normalize'}})).toMatchObject({isError:true});
  expect(f.app.server.runtimeApplication.cardStore.readRecordCurrent('project','brief.md')).toMatchObject({kind:'found',value:{projection:{accepted:{author:{kind:'external-agent',principal:'test-operator'}}}}});
  expect(await f.client.callTool({name:'queue_notification',arguments:{card_id:'project',kind:'context',body:'A direct note',urgency:'normal'}})).toMatchObject({isError:false});
  expect(await f.client.callTool({name:'stop_project',arguments:{}})).toMatchObject({isError:false});
  const identity=await fetch(`${appOrigin(f.app)}/api/chat`,{headers:{authorization:'Bearer rest-synthetic-secret'}});
  expect(await identity.json()).toMatchObject({mode:'external',internal_enabled:false,external_enabled:true,session_id:'agent:analyst:global'});
  const denied=await fetch(`${appOrigin(f.app)}/api/chat`,{method:'POST',headers:{authorization:'Bearer rest-synthetic-secret','content-type':'application/json'},body:JSON.stringify({content:'Must not run.'})});
  expect(denied.status).toBe(409);expect(await denied.json()).toMatchObject({error:'analyst_disabled'});
  await expect(f.app.server.runtimeApplication.analystRuntime.submit({userContent:'Must not run.'})).rejects.toBeInstanceOf(AnalystDisabledError);
  expect(readFileSync(f.index)).toEqual(f.before);
  await sharp({create:{width:3,height:2,channels:3,background:'#123456'}}).png().toFile(join(f.root,'synthetic.png'));
  const image=await f.client.callTool({name:'view_image',arguments:{path:'synthetic.png'}});
  expect(image).toMatchObject({isError:false,content:[{type:'image',mimeType:'image/png'}]});
  const block=(image.content as Array<{data:string}>)[0]!;
  expect((await sharp(Buffer.from(block.data,'base64')).metadata()).width).toBe(3);
  expect(readFileSync(f.index)).toEqual(f.before);
  expect(new EventQueryService(f.root).queryExternalToolCalls()).toEqual(expect.arrayContaining([expect.objectContaining({principal:'test-operator',tool:'write',outcome:'ok'})]));
  expect(await f.client.callTool({name:'restart_server',arguments:{}})).toMatchObject({structuredContent:{result:{data:{restart:'confirmation_required'}}}});
},60_000);

it('overlaps two external clients with a genuine internal turn in both mode without claiming a shared conversation',async()=>{
  let entered=false;let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const provider=createServer(async(request,response)=>{await readJsonRequest(request);entered=true;await held;sendFinalMessage(response,'Internal turn completed.');});
  const port=await listen(provider);
  try {
    const f=await fixture('both',port);
    const internal=f.app.server.runtimeApplication.analystRuntime.submit({userContent:'A harmless internal request.'});
    await waitFor(()=>entered,'internal provider entry');
    const second=new Client({name:'second-client',version:'1'});clients.push(second);
    await second.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:'Bearer mcp-synthetic-secret'}}}));
    const results=await Promise.all([
      f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project',content:'First admitted external edit'}}),
      second.callTool({name:'write',arguments:{path:'record:///brief.md?card=project',content:'Second admitted external edit'}}),
      second.callTool({name:'queue_notification',arguments:{card_id:'project',kind:'context',body:'Concurrent note',urgency:'normal'}}),
      f.client.callTool({name:'stop_project',arguments:{}}),
      second.callTool({name:'stop_project',arguments:{}}),
    ]);
    expect(results.every(result=>result.isError===false)).toBe(true);
    release();expect(await internal).toMatchObject({sessionId:'agent:analyst:global'});
    const calls=new EventQueryService(f.root).queryExternalToolCalls();
    expect(calls.filter(call=>call.tool==='write')).toHaveLength(2);
    expect(calls.filter(call=>call.tool==='queue_notification')).toHaveLength(1);
    expect(calls.filter(call=>call.tool==='stop_project')).toHaveLength(2);
    expect(f.app.server.runtimeApplication.cardStore.readRecordCurrent('project','brief.md')).toMatchObject({kind:'found',value:{projection:{accepted:{content:expect.stringMatching(/^(First|Second) admitted external edit$/)}}}});
  } finally {release();await closeServer(provider);}
},60_000);

it('authenticates all methods and rejects unsafe protocol envelopes before tool execution',async()=>{
  const f=await fixture('external',1,undefined,'0.0.0.0');
  expect(new URL(f.endpoint).hostname).toBe('127.0.0.1');
  expect(f.app.server.fastify.server.address()).toMatchObject({address:'0.0.0.0'});
  const request=async(url:string,headers:Record<string,string>={},method='POST',body:unknown={jsonrpc:'2.0',id:7,method:'tools/list'})=>{
    const response=await fetch(url,{method,headers:{authorization:'Bearer mcp-synthetic-secret','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    const text=await response.text();expect(text).not.toContain('mcp-synthetic-secret');return response.status;
  };
  expect(await request(f.endpoint,{authorization:''})).toBe(401);
  expect(await request(f.endpoint,{authorization:''},'GET')).toBe(401);
  expect(await request(f.endpoint,{authorization:'Bearer rest-synthetic-secret'})).toBe(401);
  expect(await request(f.endpoint,{origin:'http://127.0.0.1'})).toBe(403);
  const badHost=await new Promise<number>((resolve,reject)=>{
    const request=httpRequest(f.endpoint,{method:'POST',headers:{host:'localhost:123',authorization:'Bearer mcp-synthetic-secret','content-type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});
    request.on('error',reject);request.end('{}');
  });
  expect(badHost).toBe(403);
  expect(await request(`${f.endpoint}?token=synthetic`)).toBe(400);
  expect(await request(f.endpoint.replace(/[^/]+$/u,'wrong-project'))).toBe(404);
  expect(await request(f.endpoint,{},'GET')).toBe(405);
  expect(await request(f.endpoint,{},'DELETE')).toBe(405);
  expect(await request(f.endpoint,{'mcp-protocol-version':'2024-11-05'})).toBe(400);
  expect(await request(f.endpoint,{'mcp-protocol-version':''})).toBe(400);
  expect(await request(f.endpoint,{},'POST',[{jsonrpc:'2.0',id:7,method:'tools/list'}])).toBe(400);
  expect(await request(f.endpoint,{'mcp-session-id':'client-selected'})).toBe(400);
  await expect(f.client.callTool({name:'delete_card',arguments:{ids:['project']}})).rejects.toThrow();
  expect(new EventQueryService(f.root).queryExternalToolCalls()).toHaveLength(1);
  const restDenied=await fetch(`${appOrigin(f.app)}/api/state`,{headers:{authorization:'Bearer mcp-synthetic-secret'}});
  expect(restDenied.status).toBe(401);
  const receipts=await fetch(`${appOrigin(f.app)}/api/external-tool-calls`,{headers:{authorization:'Bearer rest-synthetic-secret'}});
  expect(await receipts.json()).toMatchObject({total:1,external_tool_calls:[{principal:'test-operator',tool:'<unsupported>',execution:'rejected_before_execution'}]});
},60_000);

it('keeps process ownership across client closure, joins disconnected work, and contains processes on App stop',async()=>{
  const f=await fixture();
  const started=await f.client.callTool({name:'run_command',arguments:{command:'timeout -k 1s 20s sleep 15',wait:false}});
  const id=(started.structuredContent as {result:{data:{process_id:string}}}).result.data.process_id;
  expect(typeof id).toBe('string');
  expect(f.app.server.runtimeApplication.processRunner.get(id)).toMatchObject({agent_session_id:null,owner_id:'external:test-operator'});
  expect(await f.client.callTool({name:'run_command',arguments:{command:`timeout -k 1s 5s bash -c 'test -z "$SAIVAGE_ANALYST_MCP_TOKEN" && test -z "$SAIVAGE_API_TOKEN" && printf private-env-absent'`,wait:true}})).toMatchObject({isError:false,structuredContent:{result:{data:{exit_code:0,stdout:'private-env-absent'}}}});
  await f.client.close();clients.splice(clients.indexOf(f.client),1);
  const replacement=new Client({name:'replacement-client',version:'1'});clients.push(replacement);
  await replacement.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:'Bearer mcp-synthetic-secret'}}}));
  expect(await replacement.callTool({name:'wait_process',arguments:{process_id:id,timeout_ms:0}})).toMatchObject({isError:false});
  expect(await replacement.callTool({name:'kill_process',arguments:{process_id:id}})).toMatchObject({isError:false});
  expect(await replacement.callTool({name:'wait_process',arguments:{process_id:id}})).toMatchObject({isError:true});
  const abort=new AbortController();
  const delivered=fetch(f.endpoint,{method:'POST',signal:abort.signal,headers:{authorization:'Bearer mcp-synthetic-secret','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},
    body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'run_command',arguments:{command:"timeout -k 1s 10s bash -c 'touch entered; sleep 0.2; touch completed'",wait:true}}})}).catch(()=>null);
  await waitFor(()=>existsSync(join(f.root,'entered')),'external executor entry');abort.abort();await delivered;
  await waitFor(()=>existsSync(join(f.root,'completed')),'disconnected command completion');
  await waitFor(()=>new EventQueryService(f.root).queryExternalToolCalls().filter(call=>call.tool==='run_command').length===3,'disconnected call receipt');
  const background=await replacement.callTool({name:'run_command',arguments:{command:'timeout -k 1s 20s sleep 15',wait:false}});
  const backgroundId=(background.structuredContent as {result:{data:{process_id:string}}}).result.data.process_id;
  const processes=f.app.server.runtimeApplication.processRunner;
  expect(processes.get(backgroundId)).toMatchObject({status:'running',owner_id:'external:test-operator'});
  const active=f.app.server.runtimeApplication.externalAnalystOperations!.invoke('run_command',{
    command:"timeout -k 1s 20s bash -c 'touch shutdown-entered; sleep 15'",wait:true,
  });
  await waitFor(()=>existsSync(join(f.root,'shutdown-entered')),'shutdown invocation entry');
  const report=await f.app.stop();apps.splice(apps.indexOf(f.app),1);
  expect(report.warnings).toEqual([]);
  expect(await active).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded',data:{status:'killed'}}}});
  expect(processes.list().some(record=>record.status==='running')).toBe(false);
  await expect(f.app.server.runtimeApplication.externalAnalystOperations!.invoke('get_status',{})).rejects.toThrow('admission is closed');
},60_000);

it('returns ordered images from a real synthetic outbound MCP server through the inbound SDK without an Analyst transcript',async()=>{
  const png=await sharp({create:{width:4,height:2,channels:3,background:'#00ff00'}}).png().toBuffer();
  const calls:string[]=[];
  let nativeError=false;
  const outbound=createServer(async(request,response)=>{
    const body=await readJsonRequest(request) as {id?:number;method:string}; calls.push(body.method);
    if(body.method==='notifications/initialized'){response.writeHead(202);response.end();return;}
    const result=body.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic-images',version:'1'}}:
      body.method==='tools/list'?{tools:[{name:'screen',description:'Synthetic image',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:
      {isError:nativeError,content:[{type:'text',text:'ordered-before'},{type:'image',mimeType:'image/png',data:png.toString('base64')},{type:'text',text:'ordered-after'}]};
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  });
  const port=await listen(outbound);
  try {
    const f=await fixture('external',1,config=>{config.mcpServers={images:{transport:'streamable-http',url:`http://127.0.0.1:${port}`,autostart:true,disabled:false}};});
    const discovered=await f.client.callTool({name:'mcp_tools',arguments:{serverName:'images'}});
    const data=(discovered.structuredContent as {result:{data:{bindingId:string;catalogId:string}}}).result.data;
    const result=await f.client.callTool({name:'mcp_tool_call',arguments:{serverName:'images',bindingId:data.bindingId,catalogId:data.catalogId,toolName:'screen',args:{}}});
    expect(result.isError).toBe(false);
    expect((result.content as Array<{type:string}>).map(block=>block.type)).toEqual(['text','image','text']);
    const image=(result.content as Array<{data?:string}>)[1]!;
    expect(await sharp(Buffer.from(image.data!,'base64')).metadata()).toMatchObject({format:'png',width:4,height:2});
    expect(calls.filter(method=>method==='tools/call')).toHaveLength(1);
    nativeError=true;
    expect(await f.client.callTool({name:'mcp_tool_call',arguments:{serverName:'images',bindingId:data.bindingId,catalogId:data.catalogId,toolName:'screen',args:{}}})).toMatchObject({isError:true});
    expect(readFileSync(f.index)).toEqual(f.before);
    expect(new EventQueryService(f.root).queryExternalToolCalls()).toEqual(expect.arrayContaining([expect.objectContaining({tool:'mcp_tool_call',outcome:'ok'})]));
  } finally {await closeServer(outbound);}
},60_000);

it('re-enables the same retained identity on a separate internal startup and still rejects a missing required Analyst index',async()=>{
  const f=await fixture();
  await f.client.close();clients.splice(clients.indexOf(f.client),1);
  await f.app.stop();apps.splice(apps.indexOf(f.app),1);
  appendConversationBatch({projectRoot:f.root},buildGlobalAgentIngressRows('agent:analyst:global','11111111-1111-4111-8111-111111111111','Retained internal history',{kind:'not_applicable',reason:'non_model_ingress'}));
  const retained=readConversation(f.root,'agent:analyst:global');
  const retainedIndex=readFileSync(f.index);
  writeProductionConfig(f.root,productionTestConfig(1));
  const inputs={projectRoot:f.root,createRuntime:false,env:{NODE_ENV:'test',LOG_LEVEL:'silent',SAIVAGE_HOST:'127.0.0.1',SAIVAGE_PORT:'0',SAIVAGE_API_TOKEN:'rest-synthetic-secret'}};
  const internal=await startApp(inputs);apps.push(internal);
  expect(internal.server.analystMcpEndpoint).toBeNull();
  expect(internal.server.runtimeApplication.analystAvailability).toEqual({mode:'internal',internal_enabled:true,external_enabled:false});
  expect(readFileSync(f.index)).toEqual(retainedIndex);
  expect(readConversation(f.root,'agent:analyst:global')).toEqual(retained);
  await internal.stop();apps.splice(apps.indexOf(internal),1);
  unlinkSync(f.index);
  await expect(startApp({...inputs,analystMode:'external',analystMcpPort:new URL(f.endpoint).port,
    analystMcpPrincipal:'test-operator',analystMcpTools:'read',env:{...inputs.env,SAIVAGE_ANALYST_MCP_TOKEN:'mcp-synthetic-secret'}})).rejects.toThrow();
  expect(existsSync(f.index)).toBe(false);
},60_000);

it.each(['index','body'] as const)('does not weaken required Analyst canonical %s validation in external-only startup',async damage=>{
  const f=await fixture();
  await f.client.close();clients.splice(clients.indexOf(f.client),1);
  await f.app.stop();apps.splice(apps.indexOf(f.app),1);
  appendConversationBatch({projectRoot:f.root},buildGlobalAgentIngressRows('agent:analyst:global','11111111-1111-4111-8111-111111111111','Retained internal history',{kind:'not_applicable',reason:'non_model_ingress'}));
  const target=damage==='index'?f.index:currentConversationSegmentPath(f.root,'agent:analyst:global');
  writeFileSync(target,'{"malformed":true}\n');
  const corrupt=readFileSync(target);
  await expect(startApp({projectRoot:f.root,createRuntime:false,analystMode:'external',analystMcpPort:new URL(f.endpoint).port,
    analystMcpPrincipal:'test-operator',analystMcpTools:'read',env:{NODE_ENV:'test',LOG_LEVEL:'silent',SAIVAGE_HOST:'127.0.0.1',SAIVAGE_PORT:'0',SAIVAGE_ANALYST_MCP_TOKEN:'mcp-synthetic-secret'}})).rejects.toThrow();
  expect(readFileSync(target)).toEqual(corrupt);
},60_000);

it('uses the actual Supervisor for external Run, Pause, Resume and Stop with scripted provider work',async()=>{
  let entered=false;let release!:()=>void;let releaseLater!:()=>void;let requests=0;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const later=new Promise<void>(resolve=>{releaseLater=resolve;});
  const provider=createServer(async(request,response)=>{
    await readJsonRequest(request);entered=true;requests++;
    if(requests===1){await held;sendToolCall(response,'read-root','get_card',{id:'project',section:'summary'});}
    else {await later;sendFinalMessage(response);}
  });
  const port=await listen(provider);
  try {
    const f=await fixture('external',port);
    expect(await f.client.callTool({name:'start_project',arguments:{}})).toMatchObject({isError:false});
    await waitFor(()=>entered,'real root Planner provider entry');
    expect(f.app.server.runtimeApplication.runtimeApi.getActorRuntimeReadModel().cards).toEqual(expect.arrayContaining([expect.objectContaining({cardId:'project'})]));
    expect(await f.client.callTool({name:'pause_runtime',arguments:{}})).toMatchObject({isError:false,structuredContent:{result:{data:{status:'pausing'}}}});
    release();
    await waitFor(()=>f.app.server.runtimeApplication.runtimeApi.getStatus().status==='paused','settled cooperative Pause');
    expect(await f.client.callTool({name:'resume_runtime',arguments:{}})).toMatchObject({isError:false,structuredContent:{result:{data:{status:'running'}}}});
    await waitFor(()=>requests===2,'resumed original Planner provider entry');
    expect(await f.client.callTool({name:'stop_project',arguments:{}})).toMatchObject({isError:false});
    expect(f.app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
    expect(await f.client.callTool({name:'get_status',arguments:{}})).toMatchObject({isError:false});
  } finally {release();releaseLater();await closeServer(provider);}
},60_000);

it('freshly denies a prepared external Webfetch record save after an intervening owner opens a draft',async()=>{
  const f=await fixture();
  let enter!:()=>void;let release!:(response:Response)=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const prepared=new Promise<Response>(resolve=>{release=resolve;});
  const original=globalThis.fetch;let intercepted=0;
  const fetch=jest.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
    if(String(input)==='https://93.184.216.34/') {intercepted++;enter();return prepared;}
    return original(input,init);
  });
  try {
    const pending=f.client.callTool({name:'webfetch',arguments:{url:'https://93.184.216.34',save_as:'record:///brief.md?card=project'}});
    await entered;
    const cards=f.app.server.runtimeApplication.cardStore;
    cards.openRecord('project','brief.md');
    cards.editRecord('project','brief.md','Intervening real draft');
    release(new Response('Prepared response must not overwrite draft',{headers:{'content-type':'text/plain'}}));
    expect(await pending).toMatchObject({isError:true,structuredContent:{result:{data:{code:'record_open_conflict'}}}});
    expect(intercepted).toBe(1);
    expect(new EventQueryService(f.root).queryExternalToolCalls()).toEqual(expect.arrayContaining([expect.objectContaining({tool:'webfetch',outcome:'denied'})]));
    expect(cards.readRecordCurrent('project','brief.md')).toMatchObject({kind:'found',value:{projection:{draft:{content:'Intervening real draft'}}}});
  } finally {fetch.mockRestore();}
},60_000);

it.each(['writer','lifecycle'] as const)('preserves the shared %s record gate for external authority without changing accepted content',async gate=>{
  const f=await fixture('external',1,config=>{if(gate==='writer')config.agents[config.analyst_agent]!.record_writes=['review-*.md'];});
  const cards=f.app.server.runtimeApplication.cardStore;
  if(gate==='lifecycle')cards.setStatus('project','cancelled');
  const before=cards.readRecordCurrent('project','brief.md');
  expect(await f.client.callTool({name:'write',arguments:{path:'record:///brief.md?card=project',content:'Must remain denied'}})).toMatchObject({isError:true,structuredContent:{result:{data:{reason:gate==='writer'?'writer_not_authorized':'lifecycle_unsupported'}}}});
  expect(cards.readRecordCurrent('project','brief.md')).toEqual(before);
},60_000);
