import { fileURLToPath } from 'node:url';
import type { CardTypeName } from '../../../schemas/card-type-name.js';
import type { CardTypesSource, SaivageConfigSource } from '../../../schemas/saivage-config.js';

const AGENTS = Object.freeze({
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

type CardTypeSource = CardTypesSource[CardTypeName];
type ProcessEdge = CardTypeSource['workflow']['nodes'][string]['edges'][string];
type ProcessNode = CardTypeSource['workflow']['nodes'][string];

const allNonRootTypes = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function terminal(
  state: 'DONE' | 'BLOCKED' | 'FAILED',
  record: 'status.md' | 'review.md',
  promote: 'current' | { latest_node: 'draft' } = 'current',
): ProcessEdge {
  return { target: { terminal: state, promote, export_records: [record] } };
}

function transition(node: string, prompt: string): ProcessEdge {
  return { target: { node }, prompt };
}

function executionEntries(node: string): CardTypeSource['workflow']['entries'] {
  return {
    BACKLOG: { node },
    CHANGED: { node },
    BLOCKED: { node },
    STOPPED: { node, prompt: 'stopped-recovery' },
  };
}

function executorNode(prompt: string, edges: ProcessNode['edges']): ProcessNode {
  return {
    agent: 'executor',
    prompt,
    correction_prompt: 'correct-execution-result',
    records: { 'status.md': { mode: 'continue', gate: 'updated' } },
    edges,
  };
}

function planningCardType(): CardTypeSource {
  const planningEdges: ProcessNode['edges'] = {
    complete_direct: terminal('DONE', 'status.md'),
    admit_review: transition('review', 'specialized-plan-to-review'),
    blocked: terminal('BLOCKED', 'status.md'),
    failed: terminal('FAILED', 'status.md'),
  };
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      entries: {
        BACKLOG: { node: 'plan' },
        CHANGED: { node: 'plan' },
        BLOCKED: { node: 'plan' },
        STOPPED: { node: 'recover', prompt: 'stopped-recovery' },
      },
      nodes: {
        plan: {
          agent: 'planner',
          prompt: 'specialized-plan',
          correction_prompt: 'correct-plan-result',
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: planningEdges,
        },
        review: {
          agent: 'reviewer',
          prompt: 'specialized-review',
          correction_prompt: 'correct-review-result',
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          descendant_context: { records: ['status.md'], require_unchanged_until_accept: true },
          edges: {
            approved: terminal('DONE', 'review.md'),
            revision_required: transition('plan', 'specialized-review-to-plan'),
            blocked: terminal('BLOCKED', 'review.md'),
            failed: terminal('FAILED', 'review.md'),
          },
        },
        recover: {
          agent: 'planner',
          prompt: 'specialized-recover',
          correction_prompt: 'correct-plan-result',
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: planningEdges,
        },
      },
    },
  };
}

function codeCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      entries: executionEntries('red'),
      nodes: {
        red: executorNode('code-red', {
          red_confirmed: transition('green', 'code-red-to-green'),
          already_green: transition('refactor', 'code-to-refactor'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        green: executorNode('code-green', {
          green: transition('refactor', 'code-to-refactor'),
          still_red: transition('green', 'code-green-retry'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        refactor: executorNode('code-refactor', {
          done: terminal('DONE', 'status.md'),
          regressed: transition('green', 'code-regression-to-green'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
      },
    },
  };
}

function testCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      entries: executionEntries('diagnose'),
      nodes: {
        diagnose: executorNode('test-diagnose', {
          coverage_gap: transition('add-coverage', 'test-to-add-coverage'),
          failing_test: transition('repair', 'test-to-repair'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        'add-coverage': executorNode('test-add-coverage', {
          coverage_passing: transition('verify', 'test-to-verify'),
          repair_needed: transition('repair', 'test-to-repair'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        repair: executorNode('test-repair', {
          tests_passing: transition('verify', 'test-to-verify'),
          still_failing: transition('repair', 'test-repair-retry'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        verify: executorNode('test-verify', {
          done: terminal('DONE', 'status.md'),
          coverage_gap: transition('add-coverage', 'test-to-add-coverage'),
          repair_needed: transition('repair', 'test-to-repair'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
      },
    },
  };
}

function researchCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      entries: executionEntries('explore'),
      nodes: {
        explore: executorNode('research-explore', {
          evidence_ready: transition('assess', 'research-to-assess'),
          more_exploration: transition('explore', 'research-continue-exploration'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        assess: executorNode('research-assess', {
          supported: transition('report', 'research-supported-to-report'),
          refuted: transition('report', 'research-refuted-to-report'),
          bounded_inconclusive: transition('report', 'research-inconclusive-to-report'),
          evidence_gap: transition('explore', 'research-continue-exploration'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        report: executorNode('research-report', {
          done: terminal('DONE', 'status.md'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
      },
    },
  };
}

function dataCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      entries: executionEntries('schema'),
      nodes: {
        schema: executorNode('data-schema', {
          schema_ready: transition('validate', 'data-to-validate'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        validate: executorNode('data-validate', {
          valid: transition('implement', 'data-to-implement'),
          schema_invalid: transition('schema', 'data-revise-schema'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        implement: executorNode('data-implement', {
          done: terminal('DONE', 'status.md'),
          implementation_retry: transition('implement', 'data-implementation-retry'),
          schema_revision: transition('schema', 'data-revise-schema'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
      },
    },
  };
}

function architectureCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      entries: executionEntries('draft'),
      nodes: {
        draft: executorNode('architecture-draft', {
          ready_for_component_review: transition('component-review', 'architecture-to-component-review'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        'component-review': {
          agent: 'reviewer',
          prompt: 'architecture-component-review',
          correction_prompt: 'correct-review-result',
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          edges: {
            approved: transition('system-review', 'architecture-to-system-review'),
            revision_required: transition('draft', 'architecture-component-revision'),
            blocked: terminal('BLOCKED', 'review.md'),
            failed: terminal('FAILED', 'review.md'),
          },
        },
        'system-review': {
          agent: 'reviewer',
          prompt: 'architecture-system-review',
          correction_prompt: 'correct-review-result',
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          edges: {
            approved: terminal('DONE', 'review.md', { latest_node: 'draft' }),
            revision_required: transition('draft', 'architecture-system-revision'),
            blocked: terminal('BLOCKED', 'review.md'),
            failed: terminal('FAILED', 'review.md'),
          },
        },
      },
    },
  };
}

function simpleExecutionCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      entries: executionEntries('execute'),
      nodes: {
        execute: executorNode('execute', {
          done: terminal('DONE', 'status.md'),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
      },
    },
  };
}

function leafRecords(): CardTypeSource['records'] {
  return {
    'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
    'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
  };
}

const cardTypes: CardTypesSource = deepFreeze({
  project: planningCardType(),
  goal: planningCardType(),
  architecture: architectureCardType(),
  code: codeCardType(),
  test: testCardType(),
  doc: simpleExecutionCardType(),
  data: dataCardType(),
  research: researchCardType(),
  ops: simpleExecutionCardType(),
});

const config: SaivageConfigSource = deepFreeze({agents:structuredClone(AGENTS) as unknown as SaivageConfigSource['agents'],analyst_agent:'analyst',models:{routes:structuredClone(MODEL_ROUTES) as unknown as SaivageConfigSource['models']['routes'],profiles:{planning:{preferred:['gpt-5.6'],allowed:[]},review:{preferred:['gpt-5.6'],allowed:[]}},equivalents:[],failover:{}},providers:{},server:{host:'0.0.0.0',port:8080},compaction:{enabled:true,context_utilization_fraction:0.80,trigger_fraction:0.90,tail_fraction:0.25,snap:'keep_straddler_verbatim',summarizer_candidate:{provider:'openai',account:null,model:'gpt-5.6'}},card_types:cardTypes});

export const CLASSIC_TYPED_TEMPLATE = Object.freeze({ name: 'classic-typed', config, promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)) });
