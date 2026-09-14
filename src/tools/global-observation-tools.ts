import type { CardService } from '../cards/card-service.js';
import type { EventQueryService } from '../application/event-query-service.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { ConversationSessionId } from '../schemas/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';
import { AgentOperatorReadModelService, AgentCurrentStateUnavailableError, AgentSessionNotFoundError } from '../application/read-models/agent-operator-read-model.js';
import { buildProcessView } from '../application/read-models/process-view.js';
import { eventKindValues } from '../schemas/index.js';
import { emptyInput } from './tool-definition.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder } from './invocation.js';
import { listAgentSessionsInputSchema,listProcessesInputSchema, queueNotificationInputSchema, readAgentSessionInputSchema, readRuntimeErrorsInputSchema, readRuntimeEventsInputSchema } from '../contracts/builtin-tool-inputs.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from '../contracts/tool-result.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { DISCOVERY_RESPONSE_MAX_BYTES, packCollectionData } from './response-packer.js';
import type { QueueNotificationToolInput } from './notification-tool.js';
import type { ToolExecutionResult } from './invocation.js';

const DEFAULT_LIMIT = 50;

function observationReadFailure(error: unknown): ToolActionOutcome {
  const cause = error instanceof AgentCurrentStateUnavailableError ? error.cause : error;
  if (cause instanceof Error && typeof (cause as NodeJS.ErrnoException).code === 'string')
    return toolFailureFromError(error);
  throw cause;
}

export interface GlobalObservationToolContext {
  readonly agentName: import('../schemas/index.js').AgentName;
  readonly projectRoot: string;
  readonly store: CardService;
  readonly processRunner: ProcessRunner;
  readonly eventQueries: EventQueryService;
  readonly runtime: Pick<RuntimeApi, 'getStatus'>;
  readonly currentProcessPosition?:(cardId:string)=>unknown|null;
  readonly queueNotification: (input: QueueNotificationToolInput, signal: AbortSignal) => Promise<ToolExecutionResult<'none'>>;
  readonly captureExecutingLlmSnapshots: () => ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot>;
}

async function getStatus(ctx: GlobalObservationToolContext): Promise<ToolActionOutcome> {
  try {
    const runtime = ctx.runtime.getStatus();
    const cards = ctx.store.list();
    const statusCounts = cards.reduce<Record<string, number>>((counts, card) => { counts[card.lifecycle.status] = (counts[card.lifecycle.status] ?? 0) + 1; return counts; }, {});
    return toolSucceeded({ runtime, runtimeSummary: { status: runtime.status, currentCardId: runtime.currentCardId }, runningProcesses: ctx.processRunner.list({ status: 'running' }).length, statusCounts, counts: { stopped: statusCounts.stopped ?? 0, done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: cards.length } });
  } catch (error) { return observationReadFailure(error); }
}

function packed(items:readonly unknown[],position:{item_index:number;item_byte_offset:number}|undefined,responseBytes:number|undefined,key:string,base:Record<string,unknown>={}):ToolActionOutcome{const{data}=packCollectionData({cap:responseBytes??DISCOVERY_RESPONSE_MAX_BYTES,total:items.length,position:position??{item_index:0,item_byte_offset:0},item:(index)=>items[index]!,render:(page)=>({...base,[key]:page})});return toolSucceeded(data);}
async function listAgentSessions(ctx: GlobalObservationToolContext,params:{position?:{item_index:number;item_byte_offset:number};response_bytes?:number}): Promise<ToolActionOutcome> {
  try { const response=new AgentOperatorReadModelService(ctx.projectRoot, ctx.store.workflows, ctx.captureExecutingLlmSnapshots).listSessions();return packed(response.sessions,params.position,params.response_bytes,'sessions'); }
  catch (error) { return observationReadFailure(error); }
}

async function readAgentSession(ctx: GlobalObservationToolContext, input: { session_id: ConversationSessionId; section?:'messages'|'context';last_n?: number;position?:{item_index:number;item_byte_offset:number};response_bytes?:number }): Promise<ToolActionOutcome> {
  try {
    const response = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store.workflows, ctx.captureExecutingLlmSnapshots).readCurrentSegmentTail(input.session_id, input.last_n ?? DEFAULT_LIMIT);
    if (response.kind === 'empty') return toolFailed('Agent session has no current conversation segment.', { code: 'agent_session_empty', session_id: input.session_id });
    const section=input.section??'messages';
    const base={session:response.session,ownership:response.ownership,segment_version:response.conversation.segmentVersion,section,has_segment_context:response.conversation.segmentContext!==null,total_visible_entries:response.conversation.totalEntries};
    return section==='messages'
      ? packed(response.conversation.entries,input.position,input.response_bytes,'messages',base)
      : packed(response.conversation.segmentContext===null?[]:[response.conversation.segmentContext],input.position,input.response_bytes,'context',base);
  } catch (error) {
    if (error instanceof AgentSessionNotFoundError) return toolFailed('Agent session not found.', { code: 'agent_session_not_found', session_id: input.session_id });
    if (error instanceof AgentCurrentStateUnavailableError) {
      if (!(error.cause instanceof Error) || typeof (error.cause as NodeJS.ErrnoException).code !== 'string') throw error.cause;
      return toolFailed('Current Agent session state unavailable; restart required.', { code: 'current_state_unavailable', resource: error.resource, owner_id: error.ownerId, restart_required: true });
    }
    throw error;
  }
}

export const globalObservationToolBinders: readonly ToolBinder<GlobalObservationToolContext, any>[] = Object.freeze([
  defineToolBinder({ name:'get_status', description:'Get bounded overall project and runtime status.', resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>emptyInput, executor:(ctx)=>executeToolAction('observational_query',()=>getStatus(ctx)) }),
  defineToolBinder({ name:'read_runtime_events', description:'Read a byte-packed page from the newest selected runtime events.', resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>readRuntimeEventsInputSchema, executor:(ctx,args)=>executeToolAction('observational_query',async()=>{try{const result=ctx.eventQueries.queryEvents({selection:'newest_tail',limit:args.limit??DEFAULT_LIMIT,...(args.kind?{kind:args.kind as (typeof eventKindValues)[number]}:{})});return packed(result.events,args.position,args.response_bytes,'events',{total_lines:result.total,parse_errors:0});}catch(error){return observationReadFailure(error);}}) }),
  defineToolBinder({ name:'read_runtime_errors', description:'Read a byte-packed page from the newest selected runtime errors.', resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>readRuntimeErrorsInputSchema, executor:(ctx,args)=>executeToolAction('observational_query',async()=>{try{const result=ctx.eventQueries.queryErrors(args.limit??DEFAULT_LIMIT);return packed(result.errors,args.position,args.response_bytes,'errors',{total_lines:result.total,parse_errors:0});}catch(error){return observationReadFailure(error);}}) }),
  defineToolBinder({ name:'list_processes_tool', description:'List observed runtime processes as a byte-packed page; process output remains available through bounded read(work:///...).', resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>listProcessesInputSchema, executor:(ctx,args)=>executeToolAction('observational_query',async()=>{try{const values=ctx.processRunner.list(args.cardId?{cardId:args.cardId}:undefined).map((record:ReturnType<ProcessRunner['list']>[number])=>buildProcessView(ctx.projectRoot,record));const filtered=args.status?values.filter((value:ReturnType<typeof buildProcessView>)=>value.status===args.status):values;return packed(filtered,args.position,args.response_bytes,'processes');}catch(error){return observationReadFailure(error);}}) }),
  defineToolBinder({ name:'list_agent_sessions', description:'List authoritative durable selected-global and active-card agent sessions as a byte-packed page.', resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>listAgentSessionsInputSchema, executor:(ctx,args)=>executeToolAction('observational_query',()=>listAgentSessions(ctx,args)) }),
  defineToolBinder({ name:'read_agent_session', description:"Read one bounded section of a canonical admitted agent session. Messages are the default selected tail. When has_segment_context is true and prior compacted history matters, read section 'context', then page messages.", resultPolicyTemplate:OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema:()=>readAgentSessionInputSchema, executor:(ctx,args)=>executeToolAction('observational_query',()=>readAgentSession(ctx,args)) }),
  defineToolBinder({ name:'queue_notification', description:'Queue evidenced context to an eligible planning card. Urgent submission may interrupt only the captured active descendant suffix.', resultPolicyTemplate:OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema:()=>queueNotificationInputSchema, executor:(ctx,args,signal)=>ctx.queueNotification(args,signal) }),
]);
