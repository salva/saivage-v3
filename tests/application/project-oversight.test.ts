import { ProjectOversight, type OversightClock } from '../../src/application/project-oversight.js';
import { describe,expect,it,jest } from '@jest/globals';

class Clock implements OversightClock {
  now=0;wall='2026-09-14T00:00:00.000Z';next=1;timers=new Map<number,{at:number;delay:number;callback:()=>void}>();
  monotonicNow=()=>this.now;wallNow=()=>new Date(Date.parse(this.wall)+this.now).toISOString();
  setTimeout=(callback:()=>void,delay:number)=>{const id=this.next++;this.timers.set(id,{at:this.now+delay,delay,callback});return id;};
  clearTimeout=(id:unknown)=>{this.timers.delete(id as number);};
  advance(ms:number){this.now+=ms;for(;;){const due=[...this.timers].filter(([,timer])=>timer.at<=this.now).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)return;this.timers.delete(due[0]);due[1].callback();}}
}
const deferred=()=>{let resolve!:(value:'succeeded'|'failed'|'cancelled')=>void;let reject!:(error:unknown)=>void;const promise=new Promise<'succeeded'|'failed'|'cancelled'>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

describe('ProjectOversight deterministic schedule ownership',()=>{
  it('waits a full interval, never queues ticks, and rearms from settlement',async()=>{const clock=new Clock();const checks:Array<ReturnType<typeof deferred>>=[];const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){throw error;},createCheck(){const task=deferred();checks.push(task);return{run:()=>task.promise,cancel(){},executingLlmSnapshot:()=>null} as never;}});owner.runtimeStatusChanged('running');expect(owner.status().state).toBe('waiting');clock.advance(999);expect(checks).toHaveLength(0);clock.advance(1);expect(checks).toHaveLength(1);expect(owner.status()).toMatchObject({state:'checking',eligibility_reason:'check_in_flight'});clock.advance(5000);expect(checks).toHaveLength(1);checks[0]!.resolve('succeeded');await Promise.resolve();expect(owner.status().state).toBe('waiting');expect(owner.status().last_attempt?.outcome).toBe('succeeded');clock.advance(999);expect(checks).toHaveLength(1);clock.advance(1);expect(checks).toHaveLength(2);});
  it('settles an ordinary failed check and creates a fresh check only at the next normal due time',async()=>{const clock=new Clock();const checks:Array<ReturnType<typeof deferred>>=[];const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){throw error;},createCheck(){const task=deferred();checks.push(task);return{run:()=>task.promise,cancel(){},executingLlmSnapshot:()=>null} as never;}});owner.runtimeStatusChanged('running');clock.advance(1000);checks[0]!.resolve('failed');await Promise.resolve();expect(owner.status()).toMatchObject({state:'waiting',last_attempt:{outcome:'failed'}});expect(checks).toHaveLength(1);clock.advance(999);expect(checks).toHaveLength(1);clock.advance(1);expect(checks).toHaveLength(2);expect(owner.status().state).toBe('checking');});
  it('discards elapsed wait on pause and cancels an owned check without overlap',async()=>{const clock=new Clock();const checks:Array<{task:ReturnType<typeof deferred>;cancelled:boolean}>=[];const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){throw error;},createCheck(){const value={task:deferred(),cancelled:false};checks.push(value);return{run:()=>value.task.promise,cancel(){value.cancelled=true;},executingLlmSnapshot:()=>null} as never;}});owner.runtimeStatusChanged('running');clock.advance(800);owner.runtimeStatusChanged('paused');owner.runtimeStatusChanged('running');clock.advance(999);expect(checks).toHaveLength(0);clock.advance(1);owner.runtimeStatusChanged('paused');expect(checks[0]!.cancelled).toBe(true);owner.runtimeStatusChanged('running');clock.advance(5000);expect(checks).toHaveLength(1);checks[0]!.task.resolve('cancelled');await Promise.resolve();expect(owner.status().state).toBe('waiting');});
  it('keeps disabled status epoch-local and never creates a check',()=>{const clock=new Clock();let calls=0;const owner=new ProjectOversight({enabled:false,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){throw error;},createCheck(){calls++;throw new Error('unexpected');}});owner.runtimeStatusChanged('running');clock.advance(10000);expect(calls).toBe(0);expect(owner.status()).toMatchObject({state:'unavailable',eligibility_reason:'disabled',last_attempt:null,last_successful_at:null});});
  it('dispatches an unexpected owner failure without recording or rearming',async()=>{const clock=new Clock();const task=deferred();const failures:unknown[]=[];const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){failures.push(error);},createCheck(){return{run:()=>task.promise,cancel(){},executingLlmSnapshot:()=>null} as never;}});owner.runtimeStatusChanged('running');clock.advance(1000);const failure=new Error('owner invariant');task.reject(failure);await Promise.resolve();await Promise.resolve();expect(failures).toEqual([failure]);expect(owner.status()).toMatchObject({state:'unavailable',eligible:false,eligibility_reason:'application_closing',last_attempt:null,last_successful_at:null,next_nominal_due:null});clock.advance(10000);expect(owner.status().last_attempt).toBeNull();});
  it('dispatches synchronous check-construction failure through the same terminal owner',()=>{const clock=new Clock();const failure=new Error('construction invariant');const failures:unknown[]=[];const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){failures.push(error);},createCheck(){throw failure;}});owner.runtimeStatusChanged('running');clock.advance(1000);expect(failures).toEqual([failure]);expect(owner.status()).toMatchObject({state:'unavailable',eligible:false,eligibility_reason:'application_closing',last_attempt:null,next_nominal_due:null});});

  it('chunks durations above the Node timeout ceiling without changing the nominal deadline',()=>{
    const clock=new Clock();let calls=0;const interval=2_147_483_647+250;
    const owner=new ProjectOversight({enabled:true,intervalMs:interval,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:clock.wall,clock,changed(){},onOwnerFailure(error){throw error;},createCheck(){calls++;return{run:async()=> 'succeeded',cancel(){},executingLlmSnapshot:()=>null} as never;}});
    owner.runtimeStatusChanged('running');
    const nominal=owner.status().next_nominal_due;
    expect([...clock.timers.values()].map(({delay})=>delay)).toEqual([2_147_483_647]);
    clock.advance(2_147_483_647);
    expect(calls).toBe(0);
    expect(owner.status().next_nominal_due).toBe(nominal);
    expect([...clock.timers.values()].map(({delay})=>delay)).toEqual([250]);
    clock.advance(249);expect(calls).toBe(0);clock.advance(1);expect(calls).toBe(1);
  });

  it('reacts only to actual runtime status changes and reports the current service epoch',()=>{
    const clock=new Clock();const changed=jest.fn();
    const owner=new ProjectOversight({enabled:true,intervalMs:1000,agentName:'oversight',sessionId:'agent:oversight:global',serviceEpoch:'2026-09-14T03:00:00.000Z',clock,changed,onOwnerFailure(error){throw error;},createCheck(){throw new Error('not due');}});
    owner.runtimeStatusChanged('starting');
    owner.runtimeStatusChanged('running');
    const due=owner.status().next_nominal_due;
    owner.runtimeStatusChanged('running');
    expect(owner.status()).toMatchObject({service_epoch:'2026-09-14T03:00:00.000Z',state:'waiting',eligible:true,eligibility_reason:null,next_nominal_due:due});
    owner.runtimeStatusChanged('pausing');
    expect(owner.status()).toMatchObject({state:'unavailable',eligible:false,eligibility_reason:'pausing',next_nominal_due:null});
    owner.runtimeStatusChanged('paused');
    owner.runtimeStatusChanged('running');
    expect(owner.status().next_nominal_due).toBe('2026-09-14T00:00:01.000Z');
    owner.closeAdmission();
    expect(owner.status()).toMatchObject({state:'unavailable',eligible:false,eligibility_reason:'application_closing',next_nominal_due:null});
    expect(changed).toHaveBeenCalled();
  });
});
