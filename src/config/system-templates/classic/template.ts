import { fileURLToPath } from 'node:url';
import type { CardTypeName } from '../../../schemas/card-type-name.js';
import type { CardTypesSource, SaivageConfigSource } from '../../../schemas/saivage-config.js';

const CLASSIC_AGENTS = Object.freeze({
  analyst: Object.freeze({ prompt: 'analyst', tools: Object.freeze(['create_card', 'reorder_child', 'reopen_card', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'analyst', skills: true, session: 'global', can_create_children: true, record_writes: Object.freeze(['brief.md']) }),
  planner: Object.freeze({ prompt: 'planner', tools: Object.freeze(['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reopen_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch']), model_route: 'planner', skills: false, session: 'card', can_create_children: true, record_writes: Object.freeze(['brief.md', 'status.md']) }),
  reviewer: Object.freeze({ prompt: 'reviewer', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill']), model_route: 'reviewer', skills: true, session: 'card', can_create_children: false, record_writes: Object.freeze(['review.md', 'review-*.md']) }),
  executor: Object.freeze({ prompt: 'executor', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'executor', skills: true, session: 'card', can_create_children: false, record_writes: Object.freeze(['status.md']) }),
});

const MODEL_ROUTES = Object.freeze({
  analyst: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.7, max_tokens: 4096 }),
  planner: Object.freeze({ profile: 'planning', temperature: 0.7, max_tokens: 4096 }),
  reviewer: Object.freeze({ profile: 'review', temperature: 0.2, max_tokens: 4096 }),
  executor: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.3, max_tokens: 8192 }),
});

const allNonRootTypes = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function planningCardType(): CardTypesSource[CardTypeName] {
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'plan' }, CHANGED: { node: 'plan' }, BLOCKED: { node: 'plan' }, STOPPED: { node: 'recover', prompt: 'stopped-recovery' } },
      nodes: {
        plan: { agent: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
        review: { agent: 'reviewer', prompt: 'review', correction_prompt: 'correct-review-result', records: { 'review.md': { mode: 'clean', gate: 'updated' } }, descendant_context: { records: ['status.md'], require_unchanged_until_accept: true }, edges: {
          approved: { target: { terminal: 'DONE', promote: 'current', export_records: ['review.md'] } },
          revision_required: { target: { node: 'plan' }, prompt: 'review-to-plan' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['review.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['review.md'] } },
        } },
        recover: { agent: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
      },
    },
  };
}

function executionCardType(): CardTypesSource[CardTypeName] {
  return {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: 'stopped-recovery' } },
      nodes: { execute: { agent: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
        done: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
        blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
        failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
      } } },
    },
  };
}

const cardTypes: CardTypesSource = deepFreeze({
  project: planningCardType(), goal: planningCardType(), architecture: executionCardType(), code: executionCardType(), test: executionCardType(), doc: executionCardType(), data: executionCardType(), research: executionCardType(), ops: executionCardType(),
});

const config: SaivageConfigSource = deepFreeze({agents:structuredClone(CLASSIC_AGENTS) as unknown as SaivageConfigSource['agents'],analyst_agent:'analyst',models:{routes:structuredClone(MODEL_ROUTES) as unknown as SaivageConfigSource['models']['routes'],profiles:{planning:{preferred:['gpt-5.6'],allowed:[]},review:{preferred:['gpt-5.6'],allowed:[]}},equivalents:[],failover:{}},providers:{},server:{host:'0.0.0.0',port:8080},compaction:{enabled:true,context_utilization_fraction:0.80,trigger_fraction:0.90,tail_fraction:0.25,snap:'keep_straddler_verbatim',summarizer_candidate:{provider:'openai',account:null,model:'gpt-5.6'}},card_types:cardTypes});

export const CLASSIC_TEMPLATE = Object.freeze({ name: 'classic', config, promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)) });
