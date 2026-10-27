import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [scenario,root]=process.argv.slice(2) as [string,string];
if(scenario==='publication') {
  const descriptors=new Set<number>();
  const open=fs.openSync,write=fs.writeSync,close=fs.closeSync,read=fs.readFileSync,unlink=fs.unlinkSync;
  let faulted=false;
  const forbid=()=>{if(faulted) process.stdout.write('FORBIDDEN_FOLLOWUP\n');};
  fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{
    forbid();const fd=open(...args);
    if(String(args[0])===join(root,'.saivage/cards/project/records/executions.jsonl')) descriptors.add(fd);
    else descriptors.delete(fd);return fd;
  }) as typeof fs.openSync;
  fs.writeSync=((...args:Parameters<typeof fs.writeSync>)=>{
    if(args[0]!==1&&args[0]!==2) forbid();
    const result=write(...args);
    if(descriptors.has(args[0])) {faulted=true;process.stdout.write('NATIVE_PUBLICATION_UNCERTAIN\n');throw new Error('Injected after transferred bootstrap evidence bytes');}
    return result;
  }) as typeof fs.writeSync;
  fs.closeSync=fd=>{forbid();close(fd);};
  fs.readFileSync=((...args:Parameters<typeof fs.readFileSync>)=>{forbid();return read(...args);}) as typeof fs.readFileSync;
  fs.unlinkSync=path=>{forbid();unlink(path);};
  syncBuiltinESMExports();
} else if(scenario.startsWith('frontier:')) {
  const [,point,mode]=scenario.split(':');
  const originals={open:fs.openSync,write:fs.writeSync,rename:fs.renameSync,mkdir:fs.mkdirSync,read:fs.readFileSync};
  const descriptors=new Map<number,string>();
  let injected=false,unknown=false,headPublished=false;
  const fail=()=>{injected=true;unknown=mode==='unknown';process.stdout.write(`FRONTIER:${point}:${mode}\n`);throw new Error('Injected native bootstrap frontier');};
  const matches=(path:string)=>point==='session'?path.includes('/conversations/planner/')&&path.includes('index.json'):
    point==='records'?path.includes('/records/')&&path.includes('record-brief.json'):
    point==='artifact'?path.includes('/card-history/')&&path.endsWith('.saivage-tmp'):
    point==='head'?path.includes('/.card-head.json.'):
    point==='evidence-start'?path.includes('/.executions.jsonl.'):false;
  // Observe the actual process after the uncertainty boundary, not only its Git helper.
  for(const name of ['openSync','closeSync','readFileSync','writeFileSync','appendFileSync','renameSync','unlinkSync','mkdirSync','readdirSync','lstatSync','statSync','linkSync','fsyncSync'] as const) {
    const original=fs[name] as (...args:any[])=>any;
    (fs as any)[name]=(...args:any[])=>{
      if(unknown && !(name==='fsyncSync'&&(args[0]===1||args[0]===2))) process.stdout.write(`FORBIDDEN_${name}\n`);
      return original(...args);
    };
  }
  const checkedOpen=fs.openSync,checkedRename=fs.renameSync,checkedMkdir=fs.mkdirSync,checkedRead=fs.readFileSync;
  fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{
    const path=String(args[0]);
    if(!injected&&mode==='ordinary'&&(matches(path)||(point==='evidence-start'&&path.endsWith('/records/executions.jsonl')))) fail();
    const fd=checkedOpen(...args);descriptors.set(fd,path);return fd;
  }) as typeof fs.openSync;
  fs.mkdirSync=((...args:Parameters<typeof fs.mkdirSync>)=>{
    if(!injected&&point==='layout'&&String(args[0])===join(root,'.saivage/cards/project/card-history')) fail();
    return checkedMkdir(...args);
  }) as typeof fs.mkdirSync;
  fs.renameSync=(from,to)=>{
    checkedRename(from,to);
    if(String(to)===join(root,'.saivage/cards/project/card-head.json')) headPublished=true;
    if(!injected&&mode==='unknown'&&matches(String(from))) fail();
  };
  fs.readFileSync=((...args:Parameters<typeof fs.readFileSync>)=>{
    if(!injected&&point==='final-admission'&&headPublished&&String(args[0])===join(root,'.saivage/cards/project/card-head.json')) fail();
    return checkedRead(...args);
  }) as typeof fs.readFileSync;
  fs.writeSync=((...args:Parameters<typeof fs.writeSync>)=>{
    if(unknown&&args[0]!==1&&args[0]!==2) process.stdout.write('FORBIDDEN_writeSync\n');
    const result=originals.write(...args);
    const path=descriptors.get(args[0])??'';
    const bytes=typeof args[1]==='string'?args[1]:Buffer.from(args[1]).toString('utf8');
    const kind=point==='onSpawn'?'native_process_started':point==='process-finish'?'native_process_finished':point==='evidence-finish'?'native_finished':null;
    if(!injected&&mode==='unknown'&&((path.includes('/records/')&&path.includes('executions.jsonl')&&kind&&bytes.includes(`"kind":"${kind}"`))||
      (point==='capture-append'&&path.includes('/work/')&&path.endsWith('stdout.log')))) fail();
    return result;
  }) as typeof fs.writeSync;
  const kill=process.kill.bind(process);
  process.kill=((...args:Parameters<typeof process.kill>)=>{if(unknown) process.stdout.write('FORBIDDEN_kill\n');return kill(...args);}) as typeof process.kill;
  syncBuiltinESMExports();
} else if(scenario==='unverifiable') {
  const kill=process.kill.bind(process);
  process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{
    if(pid<0 && signal===0 && fs.existsSync(join(root,'.saivage/hook-pid'))) {
      process.stdout.write('NATIVE_GROUP_UNVERIFIABLE\n');
      throw Object.assign(new Error('Injected group observation denial'),{code:'EPERM'});
    }
    return kill(pid,signal);
  }) as typeof process.kill;
} else throw new Error('Unknown fixture fault');
const {startApp}=await import('../../src/boot/app.js');
await startApp({projectRoot:root,createRuntime:true,env:{...process.env,SAIVAGE_HOST:'127.0.0.1',SAIVAGE_PORT:'0'}});
process.stdout.write('FORBIDDEN_READY\n');
