import type { CardType } from '../schemas/index.js';
import type { SaivageConfig } from '../schemas/saivage-config.js';

export const DEFAULT_AGENTS = Object.freeze({
  analyst: Object.freeze({ prompt: 'analyst', tools: Object.freeze(['create_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'analyst', skills: true, session: 'global', can_create_children: true }),
  planner: Object.freeze({ prompt: 'planner', tools: Object.freeze(['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch']), model_route: 'planner', skills: false, session: 'card', can_create_children: true }),
  reviewer: Object.freeze({ prompt: 'reviewer', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill']), model_route: 'reviewer', skills: true, session: 'card', can_create_children: false }),
  executor: Object.freeze({ prompt: 'executor', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'executor', skills: true, session: 'card', can_create_children: false }),
});

export const DEFAULT_MODEL_ROUTES = Object.freeze({
  analyst: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.7, max_tokens: 4096 }),
  planner: Object.freeze({ profile: 'planning', temperature: 0.7, max_tokens: 4096 }),
  reviewer: Object.freeze({ profile: 'review', temperature: 0.2, max_tokens: 4096 }),
  executor: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.3, max_tokens: 8192 }),
});

const allNonRootTypes = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;

function planningCardType(): SaivageConfig['card_types'][CardType] {
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', writers: ['analyst', 'planner'], bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', writers: ['planner', 'executor'], bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', writers: ['reviewer'], bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'plan' }, CHANGED: { node: 'plan' }, BLOCKED: { node: 'plan' }, STOPPED: { node: 'recover', prompt: 'stopped-recovery' } },
      nodes: {
        plan: { agent: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: { 'status.md': 'updated' }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
        review: { agent: 'reviewer', prompt: 'review', correction_prompt: 'correct-review-result', records: { 'review.md': 'updated' }, descendant_context: { records: ['status.md'], require_unchanged_until_accept: true }, edges: {
          approved: { target: { terminal: 'DONE', promote: 'current', export_records: ['review.md'] } },
          revision_required: { target: { node: 'plan' }, prompt: 'review-to-plan' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['review.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['review.md'] } },
        } },
        recover: { agent: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: { 'status.md': 'updated' }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
      },
    },
  };
}

function executionCardType(): SaivageConfig['card_types'][CardType] {
  return {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', writers: ['analyst'], bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', writers: ['executor'], bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: 'stopped-recovery' } },
      nodes: { execute: { agent: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: { 'status.md': 'updated' }, edges: {
        done: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
        blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
        failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
      } } },
    },
  };
}

export const DEFAULT_CARD_TYPES: SaivageConfig['card_types'] = Object.freeze({
  project: planningCardType(), goal: planningCardType(), architecture: executionCardType(), code: executionCardType(), test: executionCardType(), doc: executionCardType(), data: executionCardType(), research: executionCardType(), ops: executionCardType(),
});

export const DEFAULT_SAIVAGE_CONFIG = Object.freeze({agents:structuredClone(DEFAULT_AGENTS),analyst_agent:'analyst',models:{routes:structuredClone(DEFAULT_MODEL_ROUTES),profiles:{planning:{preferred:['gpt-5.6'],allowed:[]},review:{preferred:['gpt-5.6'],allowed:[]}},equivalents:[],failover:{}},providers:{},server:{host:'0.0.0.0',port:8080},compaction:{enabled:true,input_budget_tokens:32768,trigger_fraction:0.75,completion_reserve_fraction:0.25,merge_line_fraction:0.3,summary_line_fraction:0.5,escalate_merge_line_fraction:0.4,escalate_summary_line_fraction:0.6,snap:'keep_straddler_verbatim',summarizer_candidate:{provider:'openai',account:null,model:'gpt-5.6'}},card_types:DEFAULT_CARD_TYPES});
