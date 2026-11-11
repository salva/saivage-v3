import { fileURLToPath } from 'node:url';
import type { CardTypeName, CardTypesSource } from '../../../schemas/index.js';
import { createClassicConfig } from '../classic-shared.js';
const prompt = (reference: string) => ({ reference, compactable: true });

type CardTypeSource = CardTypesSource[CardTypeName];
type ProcessEdge = CardTypeSource['workflow']['nodes'][string]['edges'][string];
type ProcessNode = CardTypeSource['workflow']['nodes'][string];

const allNonRootTypes = [
  'goal',
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
] as const;

function terminal(
  state: 'DONE' | 'BLOCKED' | 'FAILED',
  record: 'status.md' | 'review.md',
  promote: 'current' = 'current',
): ProcessEdge {
  return { target: { terminal: state, promote, export_records: [record] } };
}

function transition(node: string, prompt: string): ProcessEdge {
  return { target: { node }, prompt: { reference: prompt, compactable: true } };
}

function executionEntries(
  node: string,
  resume = 'resume-assess',
): CardTypeSource['workflow']['entries'] {
  return {
    BACKLOG: { node },
    CHANGED: { node: resume },
    BLOCKED: { node: resume },
    STOPPED: { node: resume, prompt: prompt('stopped-recovery') },
  };
}

function executorNode(prompt: string, edges: ProcessNode['edges']): ProcessNode {
  return {
    execution: {
      kind: 'agent',
      agent: 'executor',
      prompt: { reference: prompt, compactable: true },
      correction_prompt: { reference: 'correct-result', compactable: true },
    },
    records: { 'status.md': { mode: 'continue', gate: 'updated' } },
    edges,
  };
}

function planningCardType(project = false): CardTypeSource {
  const route = (node: string): ProcessEdge => ({ target: { node } });
  const node = (id: string, reviewer: boolean, edges: ProcessNode['edges']): ProcessNode => {
    const record = reviewer ? 'review.md' : 'status.md';
    return {
      execution: {
        kind: 'agent',
        agent: reviewer ? 'reviewer' : 'planner',
        prompt: prompt(id),
        correction_prompt: prompt('correct-result'),
      },
      records: { [record]: { mode: reviewer ? 'clean' : 'continue', gate: 'updated' } },
      ...(reviewer
        ? { descendant_context: { records: ['status.md'], require_unchanged_until_accept: true } }
        : {}),
      edges: { ...edges, blocked: terminal('BLOCKED', record), failed: terminal('FAILED', record) },
    };
  };
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      format_version: 7,
      notification_recipient: 'planner',
      entries: executionEntries('frame-plan'),
      nodes: {
        'resume-assess': node('resume-assess', false, {
          frame: route('frame-plan'),
          align: route('alignment'),
          deliver: route('deliver'),
          accept: route('integrated-acceptance'),
          assess_debt: route('debt-assessment'),
          ...(project ? { reconcile: route('objective-assessment') } : {}),
        }),
        'frame-plan': node('frame-plan', false, { ready: route('alignment') }),
        alignment: node('alignment', true, {
          aligned: route('deliver'),
          revise: route('frame-plan'),
        }),
        deliver: node('deliver', false, {
          replan: route('frame-plan'),
          candidate_ready: route(project ? 'objective-assessment' : 'integrated-acceptance'),
        }),
        ...(project
          ? {
              'objective-assessment': node('objective-assessment', false, {
                replan: route('frame-plan'),
                candidate_ready: route('integrated-acceptance'),
              }),
            }
          : {}),
        'integrated-acceptance': node('integrated-acceptance', true, {
          accepted: route('debt-assessment'),
          repair: route('deliver'),
          replan: route('frame-plan'),
        }),
        'debt-assessment': node('debt-assessment', true, {
          clear: {
            ...terminal('DONE', 'review.md'),
            pending_notifications: {
              node: 'resume-assess',
              prompt: prompt('verdict-to-assessment'),
            },
          },
          refactor: route('frame-plan'),
          reassess: route('resume-assess'),
        }),
      },
    },
  };
}

function codeCardType(): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      notification_recipient: 'executor',
      format_version: 7,
      entries: executionEntries('red'),
      nodes: {
        'resume-assess': assessmentNode(['red', 'green', 'refactor']),
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
      notification_recipient: 'executor',
      format_version: 7,
      entries: executionEntries('diagnose', 'diagnose'),
      nodes: {
        diagnose: executorNode('test-diagnose', {
          coverage_ready: transition('verify', 'test-to-verify'),
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
      notification_recipient: 'executor',
      format_version: 7,
      entries: executionEntries('explore'),
      nodes: {
        'resume-assess': assessmentNode(['explore', 'assess', 'report']),
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
      notification_recipient: 'executor',
      format_version: 7,
      entries: executionEntries('schema'),
      nodes: {
        'resume-assess': assessmentNode(['schema', 'validate', 'implement']),
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
      notification_recipient: 'executor',
      entries: executionEntries('draft'),
      format_version: 7,
      nodes: {
        'resume-assess': assessmentNode(['draft', 'component-review', 'system-review']),
        draft: executorNode('architecture-draft', {
          ready_for_component_review: transition(
            'component-review',
            'architecture-to-component-review',
          ),
          blocked: terminal('BLOCKED', 'status.md'),
          failed: terminal('FAILED', 'status.md'),
        }),
        'component-review': {
          execution: {
            kind: 'agent',
            agent: 'reviewer',
            prompt: prompt('architecture-component-review'),
            correction_prompt: prompt('correct-result'),
          },
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          edges: {
            approved: transition('system-review', 'architecture-to-system-review'),
            revision_required: transition('draft', 'architecture-component-revision'),
            blocked: terminal('BLOCKED', 'review.md'),
            failed: terminal('FAILED', 'review.md'),
          },
        },
        'system-review': {
          execution: {
            kind: 'agent',
            agent: 'reviewer',
            prompt: prompt('architecture-system-review'),
            correction_prompt: prompt('correct-result'),
          },
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          edges: {
            approved: {
              ...terminal('DONE', 'review.md'),
              pending_notifications: {
                node: 'resume-assess',
                prompt: prompt('verdict-to-assessment'),
              },
            },
            revision_required: transition('draft', 'architecture-system-revision'),
            blocked: terminal('BLOCKED', 'review.md'),
            failed: terminal('FAILED', 'review.md'),
          },
        },
      },
    },
  };
}

function simpleExecutionCardType(type: 'doc' | 'ops'): CardTypeSource {
  return {
    permitted_child_types: [],
    records: leafRecords(),
    workflow: {
      notification_recipient: 'executor',
      entries: executionEntries('execute', 'execute'),
      format_version: 7,
      nodes: {
        execute: executorNode(`${type}-execute`, {
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

function assessmentNode(stages: string[]): ProcessNode {
  return executorNode('leaf-resume-assess', {
    ...Object.fromEntries(
      stages.map((stage) => [stage.replaceAll('-', '_'), { target: { node: stage } }]),
    ),
    blocked: terminal('BLOCKED', 'status.md'),
    failed: terminal('FAILED', 'status.md'),
  });
}

/** Inputs are evidence, not an own-record freshness fence or an approval cache. */
function recordContext(definition: CardTypeSource): CardTypeSource {
  const feed = (record: string, selection: 'accepted' | 'effective', required = false) => ({
    record,
    selection,
    presence: required ? ('required' as const) : ('optional' as const),
    prompt: prompt(required ? 'changed-record' : 'changed-record-with-body'),
  });
  return {
    ...definition,
    records: Object.fromEntries(
      Object.entries(definition.records).map(([name, record]) => [
        name,
        record.bootstrap
          ? record
          : {
              ...record,
              initialization: {
                format_version: 1,
                template:
                  name === 'status.md'
                    ? '# Current assessment\n\nNot yet assessed. Replace this scaffold with brief-relative facts, evidence and remaining work.\n'
                    : '# Review: {{cardTitle}}\n\nNot yet assessed against this node’s criteria.\n',
              },
            },
      ]),
    ),
    workflow: {
      ...definition.workflow,
      nodes: Object.fromEntries(
        Object.entries(definition.workflow.nodes).map(([id, node]) => [
          id,
          {
            ...node,
            initialize_records: Object.keys(node.records ?? {}),
            record_prompts: [
              feed('brief.md', 'accepted', true),
              feed('status.md', 'effective'),
              ...(definition.records['review.md'] ? [feed('review.md', 'accepted')] : []),
              ...(node.records?.['review.md'] ? [feed('review.md', 'effective')] : []),
            ],
          },
        ]),
      ),
    },
  };
}

const cardTypes: CardTypesSource = {
  project: recordContext(planningCardType(true)),
  goal: recordContext(planningCardType()),
  architecture: recordContext(architectureCardType()),
  code: recordContext(codeCardType()),
  test: recordContext(testCardType()),
  doc: recordContext(simpleExecutionCardType('doc')),
  data: recordContext(dataCardType()),
  research: recordContext(researchCardType()),
  ops: recordContext(simpleExecutionCardType('ops')),
};

const config = createClassicConfig(cardTypes);

export const NEWLOOP2_TEMPLATE = Object.freeze({
  name: 'newloop2',
  config,
  promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)),
});
