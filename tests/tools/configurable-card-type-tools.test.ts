import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import type { CardRecord } from '../../src/schemas/index.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { getAnalystControlToolBinders } from '../../src/tools/analyst-tool-registry.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plannerControlToolBinders } from '../../src/tools/planner-control-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import type { PlannerChildControlPort } from '../../src/runtime/actors/card-activation-owner.js';

const DEFAULT_TYPES=['project','goal','architecture','code','test','doc','data','research','ops'] as const;
function card(id:string,type:string,children:string[]=[]):CardRecord{return {id,type,title:id,child_membership:children,active_child_order:children,subtype:null,priority:0,urgency:'normal',created_by:'analyst',created_at:'2026-08-15T00:00:00.000Z',updated_at:'2026-08-15T00:00:00.000Z',version_seq:1,assigned_to:null,depends_on:[],lifecycle:{status:'backlog',result:null,error:null,completed_at:null},metrics:null,estimate:null,started_at:null,duration_ms:null,status_text:null,status_text_updated_at:null,status_text_author_session_id:null,latest_self_report:null,metadata:null,pending_notifications:[]};}
const unusedParentControl: PlannerChildControlPort = {
  activateChild() { throw new Error('unused parent control'); },
  cancelChild() { throw new Error('unused parent control'); },
  reopenChild() { throw new Error('unused parent control'); },
};

function surfaces(vocabulary:readonly string[],read:ReturnType<typeof jest.fn>){
  const tool=(scope:'global'|'card')=>new BoundAgentToolSet([resolveRuntimeTool(scope,'list_cards')]);
  const store={read,listCardInspectionRows:()=>[{card:read('project'),parentId:null},{card:read('card-a'),parentId:'project'}],listChildren:(id:string)=>id==='project'?['card-a']:[]};
  const global=tool('global').bind({scope:'global',agentName:'analyst',projectRoot:'/',store:store as never,processRunner:{} as never,processScope:{} as never,processOwnerId:'analyst',mcpToolInvocation:{} as never,observationToolContext:{currentProcessPosition:()=>null} as never,cardTypeVocabulary:vocabulary});
  const cardSurface=tool('card').bind({scope:'card',agentName:'planner',projectRoot:'/',store:store as never,cardId:'project',sessionId:'agent:planner:project',parentControl:unusedParentControl,childCreationTypes:new Set(),childActivationTypes:new Set(),notifyCard:()=>({ok:false as const,reason:'missing_card' as const,cardId:'project'}),submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{} as never,cardTypeVocabulary:vocabulary});
  return {global,card:cardSurface};
}

describe('configuration-bound card-type tool vocabulary',()=>{
  it('preserves identical default list_cards schema bytes in global and card scopes',()=>{
    const read=jest.fn((id:string)=>id==='project'?card('project','project',['card-a']):card('card-a','code'));
    const bound=surfaces(DEFAULT_TYPES,read);
    expect(JSON.stringify(surfaceToolDefinitions(bound.global))).toBe(JSON.stringify(surfaceToolDefinitions(bound.card)));
    expect(surfaceToolDefinitions(bound.global)[0]!.function.parameters).toMatchObject({properties:{type:{anyOf:[{enum:[...DEFAULT_TYPES]},{items:{enum:[...DEFAULT_TYPES]}}]}}});
  });

  it('admits custom scalar/array filters and rejects unconfigured values before store reads in both scopes',async()=>{
    const read=jest.fn((id:string)=>id==='project'?card('project','project',['card-a']):card('card-a','custom-leaf'));
    const bound=surfaces(['project','custom-plan','custom-leaf'],read);
    expect(JSON.stringify(surfaceToolDefinitions(bound.global))).toBe(JSON.stringify(surfaceToolDefinitions(bound.card)));
    for(const surface of [bound.global,bound.card]){
      read.mockClear();
      await expect(invokeTestTool(surface,'list_cards',{type:'custom-leaf'})).resolves.toMatchObject({success:true,data:{cards:{items:[expect.objectContaining({type:'custom-leaf'})]}}});
      await expect(invokeTestTool(surface,'list_cards',{type:['project','custom-leaf']})).resolves.toMatchObject({success:true});
      read.mockClear();
      await expect(invokeTestTool(surface,'list_cards',{type:'unconfigured'})).rejects.toThrow(/unconfigured/);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('builds Analyst create_card from all compiled keys, including project and project-only configurations',()=>{
    const config:SaivageConfig=effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
    const project=structuredClone(config.card_types.project!);project.permitted_child_types=[];config.card_types={project};
    const workflows=compileProjectWorkflows(config);
    const binder=getAnalystControlToolBinders().find((candidate)=>candidate.name==='create_card')!;
    const tool=binder.bind({cardTypeVocabulary:workflows.cardTypeVocabulary} as ToolContext);
    expect(tool.inputSchema.safeParse({type:'project',parent:'project',title:'root',bootstrap_content:'root'}).success).toBe(true);
    expect(tool.inputSchema.safeParse({type:'project',parent:'project',title:'root',bootstrap_content:'root',tags:[]}).success).toBe(false);
    expect(tool.inputSchema.safeParse({type:'project',parent:'project',title:'root',bootstrap_content:'root',related:[]}).success).toBe(false);
    const parameters=surfaceToolDefinitions({agentName:'analyst',tools:new Map([['create_card',tool]]),providers:[]})[0]!.function.parameters as any;
    expect(parameters.properties.type.enum).toEqual(['project']);
    expect(parameters.required).toContain('parent');
    expect(parameters.properties.parent).toMatchObject({anyOf:[{const:'project'},{type:'string'}]});
    expect(JSON.stringify(parameters.properties.parent)).not.toContain('"type":"null"');
  });

  it('requires a valid explicit Analyst parent before mutation and keeps project admission in the mutation owner',async()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'analyst-card-type-admission-'));
    try{
      const create=jest.fn(()=>({kind:'denied' as const,reason:'Root project card already exists'}));
      const context={projectRoot,actor:'analyst',surface:'web-chat',cardTypeVocabulary:['project','custom-leaf'],store:{} as never,interventionReadiness:{assertInterventionReady(){}},analystMutations:{cards:{create}}} as unknown as ToolContext;
      const surface=buildInvocationSurfaceFixture('analyst',[bindToolProvider('analyst',[getAnalystControlToolBinders().find((candidate)=>candidate.name==='create_card')!],context)]);
      const base={title:'root',bootstrap_content:'root'};
      for(const input of [
        {...base,type:'custom-leaf'},
        {...base,type:'custom-leaf',parent:null},
        {...base,type:'custom-leaf',parent:'not-a-card-id'},
      ]){
        await expect(invokeTestTool(surface,'create_card',input)).rejects.toThrow();
      }
      expect(create).not.toHaveBeenCalled();
      await expect(invokeTestTool(surface,'create_card',{...base,type:'project',parent:'project'})).resolves.toMatchObject({success:false,error:expect.stringContaining('Root project card already exists')});
      expect(create).toHaveBeenCalledTimes(1);
      create.mockClear();
      await expect(invokeTestTool(surface,'create_card',{type:'unconfigured',parent:'project',title:'unknown',bootstrap_content:'unknown'})).rejects.toThrow(/unconfigured/);
      expect(create).not.toHaveBeenCalled();
    }finally{rmSync(projectRoot,{recursive:true,force:true});}
  });

  it('keeps Planner wire schema open while enforcing compiled membership, root denial, and node child admission in order',async()=>{
    const created=card('card-a','custom-leaf');
    const store={read:jest.fn((id:string)=>id==='project'?card('project','project'):null),create:jest.fn(()=>created)};
    const provider=bindToolProvider('planner-control',plannerControlToolBinders,{agentName:'planner',projectRoot:'/',parentCardId:'project',sessionId:'agent:planner:project',store,parentControl:unusedParentControl,submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),childCreationTypes:new Set(['custom-leaf']),childActivationTypes:new Set<string>(),cardTypeVocabulary:['project','custom-leaf','other']});
    const surface=buildInvocationSurfaceFixture('planner',[provider]);
    const schema=surface.tools.get('create_card')!.inputSchema;
    expect(schema.safeParse({type:'wire-unknown',title:'x',bootstrap_content:'x'}).success).toBe(true);
    expect(schema.safeParse({type:'custom-leaf',title:'x',bootstrap_content:'x',tags:[]}).success).toBe(false);
    expect(schema.safeParse({type:'custom-leaf',title:'x',bootstrap_content:'x',related:[]}).success).toBe(false);
    const editSchema=surface.tools.get('edit_card')!.inputSchema;
    expect(editSchema.safeParse({card_id:'card-a',tags:[]}).success).toBe(false);
    expect(editSchema.safeParse({card_id:'card-a',related:[]}).success).toBe(false);
    await expect(invokeTestTool(surface,'create_card',{type:'wire-unknown',title:'x',bootstrap_content:'x'})).resolves.toEqual({success:false,error:'create_card.type must be one of: custom-leaf, other.'});
    await expect(invokeTestTool(surface,'create_card',{type:'project',title:'x',bootstrap_content:'x'})).resolves.toEqual({success:false,error:'create_card cannot create project cards.'});
    await expect(invokeTestTool(surface,'create_card',{type:'other',title:'x',bootstrap_content:'x'})).resolves.toEqual({success:false,error:"Child type 'other' is not permitted for this node."});
    await expect(invokeTestTool(surface,'create_card',{type:'custom-leaf',title:'x',bootstrap_content:'x'})).resolves.toMatchObject({success:true,data:{card:{type:'custom-leaf'}}});
    expect(store.create).toHaveBeenCalledTimes(1);
  });
});
