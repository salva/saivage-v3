import { DEFAULT_CARD_TYPE_SET, STANDARD_CARD_TYPE_SET } from '../config/config-api.js';
import type { SaivageConfig, SaivageConfigSource } from '../schemas/saivage-config.js';

export const DEFAULT_AGENTS = Object.freeze({
  analyst: Object.freeze({ prompt: 'analyst', tools: Object.freeze(['create_card', 'reorder_child', 'reopen_card', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'analyst', skills: true, session: 'global', can_create_children: true, record_writes: Object.freeze(['brief.md']) }),
  planner: Object.freeze({ prompt: 'planner', tools: Object.freeze(['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch']), model_route: 'planner', skills: false, session: 'card', can_create_children: true, record_writes: Object.freeze(['brief.md', 'status.md']) }),
  reviewer: Object.freeze({ prompt: 'reviewer', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill']), model_route: 'reviewer', skills: true, session: 'card', can_create_children: false, record_writes: Object.freeze(['review.md', 'review-*.md']) }),
  executor: Object.freeze({ prompt: 'executor', tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']), model_route: 'executor', skills: true, session: 'card', can_create_children: false, record_writes: Object.freeze(['status.md']) }),
});

export const DEFAULT_MODEL_ROUTES = Object.freeze({
  analyst: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.7, max_tokens: 4096 }),
  planner: Object.freeze({ profile: 'planning', temperature: 0.7, max_tokens: 4096 }),
  reviewer: Object.freeze({ profile: 'review', temperature: 0.2, max_tokens: 4096 }),
  executor: Object.freeze({ candidates: Object.freeze(['gpt-5.6']), temperature: 0.3, max_tokens: 8192 }),
});

const DEFAULT_GLOBAL_CONFIG: Omit<SaivageConfig, 'card_types'> = {agents:structuredClone(DEFAULT_AGENTS) as unknown as SaivageConfig['agents'],analyst_agent:'analyst',models:{routes:structuredClone(DEFAULT_MODEL_ROUTES) as unknown as SaivageConfig['models']['routes'],profiles:{planning:{preferred:['gpt-5.6'],allowed:[]},review:{preferred:['gpt-5.6'],allowed:[]}},equivalents:[],failover:{}},providers:{},server:{host:'0.0.0.0',port:8080},compaction:{enabled:true,input_budget_tokens:32768,trigger_fraction:0.75,completion_reserve_fraction:0.25,merge_line_fraction:0.3,summary_line_fraction:0.5,escalate_merge_line_fraction:0.4,escalate_summary_line_fraction:0.6,snap:'keep_straddler_verbatim',summarizer_candidate:{provider:'openai',account:null,model:'gpt-5.6'}}};

export const DEFAULT_SAIVAGE_CONFIG: SaivageConfig = Object.freeze({
  ...structuredClone(DEFAULT_GLOBAL_CONFIG),
  card_types: structuredClone(STANDARD_CARD_TYPE_SET.cardTypes),
});

export const DEFAULT_SAIVAGE_CONFIG_SOURCE: SaivageConfigSource = Object.freeze({
  ...structuredClone(DEFAULT_GLOBAL_CONFIG),
  card_type_set: DEFAULT_CARD_TYPE_SET,
});
