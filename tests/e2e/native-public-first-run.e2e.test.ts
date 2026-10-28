import { expect, it, jest } from '@jest/globals';
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { nativeIdentity, nativeOptions, publicNativeCli, publicNativeProject, fixtureGit } from '../helpers/public-native-project.js';
import { startApp, type App } from '../../src/boot/app.js';
import { readCard } from '../../src/persistence/card-files.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { cardAgentSessionId, globalAgentSessionId } from '../../src/schemas/conversation-session-id.js';

jest.setTimeout(180000);
async function waitFor(predicate:()=>boolean,ms=60000) {
  const end=Date.now()+ms;
  while(!predicate()) {if(Date.now()>end) throw new Error('Bounded native E2E wait expired');await new Promise(r=>setTimeout(r,25));}
}
it.each(['natural','cancel'] as const)('public commissioned first Run and %s checkpoint use actual selected owners',async mode=>{
  const root=publicNativeProject();
  const init=publicNativeCli(root,'init',...nativeOptions);
  if(init.status!==0) throw new Error(init.stderr);
  const initial=readCard(root,'project')!;
  const tip=fixtureGit(root,'rev-parse','HEAD');
  expect(initial.git!.observed_tip).toBe(tip);
  const prior=Object.fromEntries(Object.keys(nativeIdentity).map(k=>[k,process.env[k]]));
  Object.assign(process.env,nativeIdentity);
  let app:App|undefined,scriptError:unknown,checkpointSeen=false,checkpointResult=false,executorTurns=0;
  const counts=new Map<string,number>();
  type Pending={id:string;name:string;args:object};
  const pending=new Map<string,Pending>();
  const server=createServer(async(req,res)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const role=body.model as string;
      const previous=pending.get(role);
      if(previous) {
        const calls=body.messages.filter((m:any)=>m.tool_calls?.some((c:any)=>c.id===previous.id));
        const results=body.messages.filter((m:any)=>m.role==='tool'&&m.tool_call_id===previous.id);
        expect(calls).toHaveLength(1);expect(results).toHaveLength(1);
        expect(calls[0].tool_calls).toEqual([{id:previous.id,type:'function',function:{name:previous.name,arguments:JSON.stringify(previous.args)}}]);
        const index=body.messages.indexOf(results[0]);expect(index).toBe(body.messages.indexOf(calls[0])+1);
        const session=role==='analyst'?globalAgentSessionId('analyst'):cardAgentSessionId(role as 'planner'|'executor',role==='executor'?'card-a':'project');
        const conversation=readConversation(root,session);
        expect(conversation.sourceRows.some(row=>row.kind==='tool_result'&&row.tool_call_id===previous.id)).toBe(true);
        expect(body.messages.slice(index+1)).toEqual([]);
        if(previous.id==='executor-3') expect(JSON.parse(results[0].content).success).toBe(false);
        if(previous.id==='executor-4') {
          expect(JSON.parse(results[0].content).success).toBe(true);checkpointResult=true;
          expect(readFileSync(join(root,'.saivage/checkpoint-hook-natural'),'utf8')).toContain('natural');
          const selected=readCard(root,'card-a')!.git!;
          expect(fixtureGit(root,'rev-parse','HEAD')).toBe(selected.observed_tip);
          expect(fixtureGit(root,'show',`${selected.observed_tip}:source.txt`)).toBe('checkpoint candidate');
        }
        pending.delete(role);
      }
      const n=(counts.get(role)??0)+1;counts.set(role,n);
      const call=(name:string,args:object)=>{
        const id=`${role}-${n}`;
        if(name!=='emit_result') pending.set(role,{id,name,args});
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]}));
      };
      if(role==='analyst') {
        if(n===1) return call('start_project',{});
        res.end(JSON.stringify({choices:[{message:{content:'Started.'},finish_reason:'stop'}]}));return;
      }
      if(role==='planner') {
        if(n===1) return call('create_card',{type:'code',title:'Checkpoint fixture',bootstrap_content:'Change source.txt and privately checkpoint the candidate.',priority:0,urgency:'normal',depends_on:[]});
        if(n===2) return call('activate_card',{card_id:'card-a',instructions:'Complete the bounded checkpoint fixture.'});
        if(n===3) return call('write',{path:'record:///status.md?card=project',content:'Bounded checkpoint qualification complete. No further project work requested.'});
        if(n>4) throw new Error('Unexpected planner continuation after blocked result');
        return call('emit_result',{outcome:'blocked',summary:'Synthetic bounded qualification finished; no further project work requested.'});
      }
      if(role!=='executor') throw new Error(`Unexpected scripted role ${role}`);
      executorTurns++;
      if(n===1) {
        expect(fixtureGit(root,'symbolic-ref','HEAD')).toBe(readCard(root,'card-a')!.git!.branch_ref);
        return call('write',{path:'source.txt',content:'checkpoint candidate\n'});
      }
      if(n===2) return call('read',{path:'source.txt'});
      if(n===3) return call('checkpoint_source',{branch:'unauthorized'});
      if(n===4) {
        if(mode==='natural') {
          const hook=join(root,'.git/hooks/pre-commit');
          writeFileSync(hook,'#!/bin/sh\n(sleep 0.1; echo natural > .saivage/checkpoint-hook-natural) &\n');chmodSync(hook,0o755);
        }
        if(mode==='cancel') {
          const hook=join(root,'.git/hooks/pre-commit');
          writeFileSync(hook,'#!/bin/sh\necho $$ > .saivage/checkpoint-hook-pid\nsleep 40\necho late > .saivage/checkpoint-hook-late\n');chmodSync(hook,0o755);
        }
        checkpointSeen=true;return call('checkpoint_source',{});
      }
      if(mode==='cancel') throw new Error('Cancelled checkpoint continued the provider');
      if(n===5) return call('write',{path:'record:///status.md?card=card-a',content:'Changed source.txt; actual private checkpoint observed. No claim of full project acceptance.'});
      return call('emit_result',{outcome:'done',summary:'Bounded source checkpoint fixture completed.'});
    } catch(error) {scriptError=error;res.statusCode=500;res.end('Script assertion failed');}
  });
  try {
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const address=server.address();if(!address||typeof address==='string') throw new Error('Missing local fixture port');
    const path=join(root,'.saivage/saivage.yaml');const config=parse(readFileSync(path,'utf8'));
    // Only local provider selection changes; native graph, policy, tools and prompts stay materialized.
    for(const agent of Object.values(config.agents) as any[]) agent.tools=agent.tools.filter((t:string)=>t!=='view_image');
    config.models={routes:Object.fromEntries(['analyst','planner','executor','reviewer','oversight'].map(role=>[role,{candidates:[role],temperature:0,max_tokens:512}])),profiles:{},equivalents:[],failover:{}};
    config.providers={fake:{models:['analyst','planner','executor','reviewer','oversight'],apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,capabilities:{contextWindowTokens:100000,maxOutputTokens:16384}}};
    config.compaction.summarizer_candidate={provider:'fake',account:null,model:'analyst'};
    writeFileSync(path,stringify(config));
    app=await startApp({projectRoot:root,createRuntime:false,env:{...process.env,NODE_ENV:'test',SAIVAGE_HOST:'127.0.0.1',SAIVAGE_PORT:'0',SAIVAGE_API_TOKEN:'synthetic-native'}});
    const origin=`http://127.0.0.1:${app.boundListener.port}`;
    const post=(path:string,body?:object)=>fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer synthetic-native',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
    const chat=await post('/api/chat',{content:'Start the synthetic bounded qualification.'});expect(chat.status).toBe(200);
    await waitFor(()=>checkpointSeen||scriptError!==undefined);
    if(scriptError) throw scriptError;
    if(mode==='cancel') {
      await waitFor(()=>existsSync(join(root,'.saivage/checkpoint-hook-pid'))||scriptError!==undefined);
      if(scriptError) throw scriptError;
      const pendingProcess=readCardExecutions(root,'card-a').at(-1)!;
      expect(pendingProcess.kind).toBe('native_process_started');
      expect((await post('/api/runtime/stop-project')).status).toBe(200);
      expect(checkpointResult).toBe(false);expect(executorTurns).toBe(4);
      expect(existsSync(join(root,'.saivage/checkpoint-hook-late'))).toBe(false);
      const pid=Number(readFileSync(join(root,'.saivage/checkpoint-hook-pid'),'utf8'));
      expect(()=>process.kill(pid,0)).toThrow();
      const evidence=readCardExecutions(root,'card-a');
      const checkpoint=evidence.filter(row=>row.kind==='native_started'&&row.step==='checkpoint').at(-1);
      expect(checkpoint).toBeDefined();
      const invocation=evidence.filter(row=>row.invocation_id===checkpoint!.invocation_id);
      const pendingIndex=invocation.findIndex(row=>row.row_id===pendingProcess.row_id);
      expect(pendingIndex).toBeGreaterThan(-1);
      // Retired authority does not append a synthetic completion after Stop.
      expect(invocation.slice(pendingIndex+1).some(row=>row.kind==='native_process_started')).toBe(false);
      expect(invocation.some(row=>row.kind==='native_finished'&&row.outcome==='completed')).toBe(false);
      expect(readCard(root,'card-a')!.git!.observed_tip).toBe(tip);
    } else {
      await waitFor(()=>readCard(root,'project')!.lifecycle.status==='blocked'||scriptError!==undefined);
      if(scriptError) throw scriptError;
      expect(checkpointResult).toBe(true);expect(readCard(root,'card-a')!.lifecycle.status).toBe('done');
      expect(readFileSync(join(root,'.saivage/checkpoint-hook-natural'),'utf8')).toContain('natural');
      expect(fixtureGit(root,'show',`${readCard(root,'project')!.git!.observed_tip}:source.txt`)).toBe('checkpoint candidate');
      expect(fixtureGit(root,'show','main:source.txt')).toBe('delivery'); // Root BLOCKED is not delivery.
    }
    const rows=readCardExecutions(root,'project');
    expect(rows.some(row=>row.kind==='native_started'&&row.binding.origin==='bootstrap')).toBe(true);
    expect(rows.some(row=>row.kind==='native_started'&&row.binding.origin==='activation')).toBe(true);
    writeFileSync(join(root,'.saivage/public-run-receipt.json'),JSON.stringify({mode,checkpointSeen,checkpointResult,executorTurns,counts:[...counts],rows},null,2));
  } finally {
    await app?.stop();
    writeFileSync(join(root,'.saivage/public-run-final.json'),JSON.stringify({mode,checkpointSeen,checkpointResult,executorTurns,counts:[...counts],error:String(scriptError),rootStatus:readCard(root,'project')!.lifecycle.status},null,2));
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    for(const [key,value] of Object.entries(prior)) value===undefined?delete process.env[key]:process.env[key]=value;
  }
});
