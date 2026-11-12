import type {
  AgentCapabilities,
  CapabilityResource,
  CardTypesSource,
  SaivageConfigSource,
} from '../../schemas/index.js';
import { OVERSIGHT_ALLOWED_TOOL_NAMES } from '../../contracts/index.js';

const prompt = (reference: string) => ({ reference, compactable: true });
const allCards: CapabilityResource[] = [{ kind: 'card', scopes: ['all'] }];
const allRecords: CapabilityResource[] = [{ kind: 'record', scopes: ['all'], patterns: ['*'] }];
const workspace: CapabilityResource = { kind: 'workspace' };
const allReads: CapabilityResource[] = [workspace, ...allRecords];
const plannerWrites: CapabilityResource[] = [
  workspace,
  { kind: 'record', scopes: ['self'], patterns: ['status.md'] },
  { kind: 'record', scopes: ['children'], patterns: ['brief.md'] },
];
const reviewerWrites: CapabilityResource[] = [
  workspace,
  { kind: 'record', scopes: ['self'], patterns: ['review.md', 'review-*.md'] },
];
const executorWrites: CapabilityResource[] = [
  workspace,
  { kind: 'record', scopes: ['self'], patterns: ['status.md'] },
];
const analystWrites: CapabilityResource[] = [
  workspace,
  { kind: 'record', scopes: ['all'], patterns: ['brief.md'] },
];
const grant = (
  tools: string[],
  resources?: CapabilityResource[],
): AgentCapabilities['grants'][number] => ({
  tools,
  ...(resources ? { resources: structuredClone(resources) } : {}),
});
const capabilities = (...grants: AgentCapabilities['grants']): AgentCapabilities => ({
  format_version: 2,
  grants,
});

/** Root closure reconciles the owner objective separately from bounded review acceptance. */
export function projectCompletion(definition: CardTypesSource[string]): CardTypesSource[string] {
  const { 'handle-notifications': _handler, ...nodes } = definition.workflow.nodes;
  const planning = (node: (typeof nodes)[string]) => {
    const { complete_direct: _complete, ...edges } = node.edges;
    return {
      ...node,
      edges: { ...edges, assess_completion: { target: { node: 'assess-completion' } } },
    };
  };
  return {
    ...definition,
    workflow: {
      ...definition.workflow,
      nodes: {
        ...nodes,
        plan: planning(nodes.plan!),
        recover: planning(nodes.recover!),
        review: {
          ...nodes.review!,
          edges: { ...nodes.review!.edges, approved: { target: { node: 'assess-completion' } } },
        },
        'assess-completion': {
          execution: {
            kind: 'agent',
            agent: 'planner',
            prompt: prompt('assess-completion'),
            correction_prompt: prompt('correct-plan-result'),
          },
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            replan: { target: { node: 'plan' } },
            admit_review: nodes.plan!.edges.admit_review!,
            complete_direct: {
              target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] },
            },
            complete_reviewed: {
              target: {
                terminal: 'DONE',
                promote: { latest_node: 'review' },
                export_records: ['status.md'],
              },
            },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] },
            },
          },
        },
      },
    },
  };
}

/** Shipped graph declarations, materialized before the startup compiler owns them. */
export function classicRecordContext(definition: CardTypesSource[string]): CardTypesSource[string] {
  const bootstrap = Object.entries(definition.records).find(([, record]) => record.bootstrap)![0];
  return {
    ...definition,
    records: Object.fromEntries(
      Object.entries(definition.records).map(([name, record]) => [
        name,
        name === 'status.md'
          ? {
              ...record,
              initialization: {
                format_version: 1 as const,
                template:
                  '# Current assessment\n\nNot yet assessed. Replace this scaffold with the current brief-relative state, supporting evidence and remaining work.\n',
              },
            }
          : name === 'review.md'
            ? {
                ...record,
                initialization: {
                  format_version: 1 as const,
                  template:
                    "# Review: {{cardTitle}}\n\nNot yet assessed against the accepted brief and this review node's criteria.\n",
                },
              }
            : record,
      ]),
    ),
    workflow: {
      ...definition.workflow,
      nodes: Object.fromEntries(
        Object.entries(definition.workflow.nodes).map(([id, node]) => [
          id,
          {
            ...node,
            initialize_records: ['status.md', 'review.md'].filter((name) => node.records?.[name]),
            record_prompts: [
              {
                record: bootstrap,
                selection: 'accepted' as const,
                presence: 'required' as const,
                prompt: prompt('changed-record'),
              },
              ...Object.keys(node.records ?? {})
                .filter((name) => name !== bootstrap)
                .map((record) => ({
                  record,
                  selection: 'effective' as const,
                  presence: 'optional' as const,
                  prompt: prompt('changed-record-with-body'),
                })),
            ],
          },
        ]),
      ),
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function createClassicConfig(cardTypes: CardTypesSource): SaivageConfigSource {
  const agents: SaivageConfigSource['agents'] = {
    analyst: {
      prompt: prompt('analyst'),
      capabilities: capabilities(
        grant(['create_card', 'reorder_child', 'reopen_card', 'queue_notification'], allCards),
        grant([
          'get_status',
          'start_project',
          'pause_runtime',
          'resume_runtime',
          'stop_project',
          'restart_server',
          'navigate_workspace',
          'navigate_back',
          'show_config',
          'reconfigure',
          'read_runtime_events',
          'read_runtime_errors',
          'read_control_actions',
          'list_processes_tool',
          'list_agent_sessions',
          'read_agent_session',
        ]),
        grant(
          [
            'cancel_card',
            'delete_card',
            'list_cards',
            'get_card',
            'get_tree',
            'list_card_versions',
            'get_card_version',
            'diff_card_versions',
          ],
          allCards,
        ),
        grant(['read_record_version'], allRecords),
        grant(['read'], allReads),
        grant(['view_image'], [workspace]),
        grant(['write', 'edit'], analystWrites),
        grant(['glob', 'grep'], allReads),
        grant(['apply_patch'], [workspace]),
        grant(['run_command', 'wait_process', 'kill_process', 'websearch']),
        grant(['webfetch'], analystWrites),
        grant([
          'skill',
          'list_observed_collections',
          'query_observed_collections',
          'mcp_tool_call',
          'mcp_server_control',
          'mcp_tools',
        ]),
      ),
      model_route: 'analyst',
      skills: true,
      session: 'global',
    },
    oversight: {
      prompt: prompt('oversight'),
      capabilities: capabilities(
        ...OVERSIGHT_ALLOWED_TOOL_NAMES.map((tool) => {
          if (
            [
              'queue_notification',
              'list_cards',
              'get_card',
              'get_tree',
              'list_card_versions',
              'get_card_version',
              'diff_card_versions',
            ].includes(tool)
          )
            return grant([tool], allCards);
          if (tool === 'read_record_version') return grant([tool], allRecords);
          if (['read', 'glob', 'grep'].includes(tool)) return grant([tool], allReads);
          return grant([tool]);
        }),
      ),
      model_route: 'oversight',
      skills: false,
      session: 'global',
    },
    planner: {
      prompt: prompt('planner'),
      capabilities: capabilities(
        grant(['create_card'], [{ kind: 'card', scopes: ['self'] }]),
        grant(
          ['edit_card', 'cancel_card', 'activate_card', 'reopen_card'],
          [{ kind: 'card', scopes: ['children'] }],
        ),
        grant(['reorder_child'], [{ kind: 'card', scopes: ['self'] }]),
        grant(['list_cards', 'get_card', 'get_tree'], allCards),
        grant(['read'], allReads),
        grant(['write', 'edit'], plannerWrites),
        grant(['glob', 'grep'], allReads),
        grant(['list_card_versions', 'get_card_version', 'diff_card_versions'], allCards),
        grant(['read_record_version'], allRecords),
        grant(['websearch']),
        grant(['webfetch'], plannerWrites),
        grant(['list_observed_collections', 'query_observed_collections']),
      ),
      model_route: 'planner',
      skills: false,
      session: 'card',
    },
    reviewer: {
      prompt: prompt('reviewer'),
      capabilities: capabilities(
        grant(['read'], allReads),
        grant(['view_image'], [workspace]),
        grant(['write', 'edit'], reviewerWrites),
        grant(['glob', 'grep'], allReads),
        grant(['list_card_versions', 'get_card_version', 'diff_card_versions'], allCards),
        grant(['read_record_version'], allRecords),
        grant(['websearch']),
        grant(['webfetch'], reviewerWrites),
        grant(['skill', 'list_observed_collections', 'query_observed_collections']),
      ),
      model_route: 'reviewer',
      skills: true,
      session: 'card',
    },
    executor: {
      prompt: prompt('executor'),
      capabilities: capabilities(
        grant(['read'], allReads),
        grant(['view_image'], [workspace]),
        grant(['write', 'edit'], executorWrites),
        grant(['glob', 'grep'], allReads),
        grant(['apply_patch'], [workspace]),
        grant(['run_command', 'wait_process', 'kill_process']),
        grant(['list_card_versions', 'get_card_version', 'diff_card_versions'], allCards),
        grant(['read_record_version'], allRecords),
        grant(['websearch']),
        grant(['webfetch'], executorWrites),
        grant([
          'skill',
          'list_observed_collections',
          'query_observed_collections',
          'mcp_tool_call',
          'mcp_server_control',
          'mcp_tools',
        ]),
      ),
      model_route: 'executor',
      skills: true,
      session: 'card',
    },
  };
  const routes: SaivageConfigSource['models']['routes'] = {
    analyst: { candidates: ['gpt-6.1-sol'], temperature: 0.7, max_tokens: 4096 },
    oversight: { profile: 'planning', temperature: 0.2, max_tokens: 4096 },
    planner: { profile: 'planning', temperature: 0.7, max_tokens: 4096 },
    reviewer: { profile: 'review', temperature: 0.2, max_tokens: 4096 },
    executor: { candidates: ['gpt-6.1-sol'], temperature: 0.3, max_tokens: 8192 },
  };
  const config: SaivageConfigSource = {
    agents,
    analyst_agent: 'analyst',
    oversight: { enabled: true, agent: 'oversight', interval_seconds: 7200 },
    models: {
      routes,
      profiles: {
        planning: { preferred: ['gpt-5.6'], allowed: [] },
        review: { preferred: ['gpt-6.1-sol'], allowed: [] },
      },
      equivalents: [],
      failover: {},
    },
    providers: {},
    server: { host: '0.0.0.0', port: 8080 },
    compaction: {
      enabled: true,
      context_utilization_fraction: 0.8,
      trigger_fraction: 0.9,
      tail_fraction: 0.25,
      snap: 'keep_straddler_verbatim',
      summarizer_candidate: { provider: 'openai', account: null, model: 'gpt-6.1-sol' },
    },
    card_types: cardTypes,
  };
  return deepFreeze(config);
}
