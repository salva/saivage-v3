import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/agents/default-workflow-config.js';
import { BUNDLED_CARD_TYPE_SETS, resolveCardTypeSelection } from '../../../src/config/card-type-sets/registry.js';
import { effectiveSaivageConfigSchema, saivageConfigSchema, type CardTypeSource, type CardTypesSource, type SaivageConfig } from '../../../src/schemas/saivage-config.js';

type Edge = CardTypeSource['workflow']['nodes'][string]['edges'][string];
type Node = CardTypeSource['workflow']['nodes'][string];

const children = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'];
const leafRecords = () => ({
  'brief.md': { format: 'markdown' as const, schema: 'card-brief.v1', bootstrap: true },
  'status.md': { format: 'markdown' as const, schema: 'work-status.v1', bootstrap: false },
});
const reviewRecords = () => ({ ...leafRecords(), 'review.md': { format: 'markdown' as const, schema: 'work-review.v1', bootstrap: false } });
const terminal = (state: 'DONE' | 'BLOCKED' | 'FAILED', record: 'status.md' | 'review.md', promote: 'current' | { latest_node: string } = 'current'): Edge => ({ target: { terminal: state, promote, export_records: [record] } });
const transition = (node: string, prompt: string): Edge => ({ target: { node }, prompt });
const entries = (node: string) => ({ BACKLOG: { node }, CHANGED: { node }, BLOCKED: { node }, STOPPED: { node, prompt: 'stopped-recovery' } });
const executor = (prompt: string, edges: Node['edges']): Node => ({ agent: 'executor', prompt, correction_prompt: 'correct-execution-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges });
const endings = () => ({ blocked: terminal('BLOCKED', 'status.md'), failed: terminal('FAILED', 'status.md') });

function planning(): CardTypeSource {
  const planEdges = { complete_direct: terminal('DONE', 'status.md'), admit_review: transition('review', 'specialized-plan-to-review'), ...endings() };
  return { permitted_child_types: [...children], records: reviewRecords(), workflow: { entries: { BACKLOG: { node: 'plan' }, CHANGED: { node: 'plan' }, BLOCKED: { node: 'plan' }, STOPPED: { node: 'recover', prompt: 'stopped-recovery' } }, nodes: {
    plan: { agent: 'planner', prompt: 'specialized-plan', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: planEdges },
    review: { agent: 'reviewer', prompt: 'specialized-review', correction_prompt: 'correct-review-result', records: { 'review.md': { mode: 'clean', gate: 'updated' } }, descendant_context: { records: ['status.md'], require_unchanged_until_accept: true }, edges: { approved: terminal('DONE', 'review.md'), revision_required: transition('plan', 'specialized-review-to-plan'), blocked: terminal('BLOCKED', 'review.md'), failed: terminal('FAILED', 'review.md') } },
    recover: { agent: 'planner', prompt: 'specialized-recover', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: planEdges },
  } } };
}

function leaf(nodes: CardTypeSource['workflow']['nodes'], first: string, records = leafRecords()): CardTypeSource {
  return { permitted_child_types: [], records, workflow: { entries: entries(first), nodes } };
}

export const EXPECTED_SPECIALIZED_CARD_TYPES: CardTypesSource = {
  project: planning(),
  goal: planning(),
  architecture: leaf({
    draft: executor('architecture-draft', { ready_for_component_review: transition('component-review', 'architecture-to-component-review'), ...endings() }),
    'component-review': { agent: 'reviewer', prompt: 'architecture-component-review', correction_prompt: 'correct-review-result', records: { 'review.md': { mode: 'clean', gate: 'updated' } }, edges: { approved: transition('system-review', 'architecture-to-system-review'), revision_required: transition('draft', 'architecture-component-revision'), blocked: terminal('BLOCKED', 'review.md'), failed: terminal('FAILED', 'review.md') } },
    'system-review': { agent: 'reviewer', prompt: 'architecture-system-review', correction_prompt: 'correct-review-result', records: { 'review.md': { mode: 'clean', gate: 'updated' } }, edges: { approved: terminal('DONE', 'review.md', { latest_node: 'draft' }), revision_required: transition('draft', 'architecture-system-revision'), blocked: terminal('BLOCKED', 'review.md'), failed: terminal('FAILED', 'review.md') } },
  }, 'draft', reviewRecords()),
  code: leaf({
    red: executor('code-red', { red_confirmed: transition('green', 'code-red-to-green'), already_green: transition('refactor', 'code-to-refactor'), ...endings() }),
    green: executor('code-green', { green: transition('refactor', 'code-to-refactor'), still_red: transition('green', 'code-green-retry'), ...endings() }),
    refactor: executor('code-refactor', { done: terminal('DONE', 'status.md'), regressed: transition('green', 'code-regression-to-green'), ...endings() }),
  }, 'red'),
  test: leaf({
    diagnose: executor('test-diagnose', { coverage_gap: transition('add-coverage', 'test-to-add-coverage'), failing_test: transition('repair', 'test-to-repair'), ...endings() }),
    'add-coverage': executor('test-add-coverage', { coverage_passing: transition('verify', 'test-to-verify'), repair_needed: transition('repair', 'test-to-repair'), ...endings() }),
    repair: executor('test-repair', { tests_passing: transition('verify', 'test-to-verify'), still_failing: transition('repair', 'test-repair-retry'), ...endings() }),
    verify: executor('test-verify', { done: terminal('DONE', 'status.md'), coverage_gap: transition('add-coverage', 'test-to-add-coverage'), repair_needed: transition('repair', 'test-to-repair'), ...endings() }),
  }, 'diagnose'),
  doc: leaf({ execute: executor('execute', { done: terminal('DONE', 'status.md'), ...endings() }) }, 'execute'),
  data: leaf({
    schema: executor('data-schema', { schema_ready: transition('validate', 'data-to-validate'), ...endings() }),
    validate: executor('data-validate', { valid: transition('implement', 'data-to-implement'), schema_invalid: transition('schema', 'data-revise-schema'), ...endings() }),
    implement: executor('data-implement', { done: terminal('DONE', 'status.md'), implementation_retry: transition('implement', 'data-implementation-retry'), schema_revision: transition('schema', 'data-revise-schema'), ...endings() }),
  }, 'schema'),
  research: leaf({
    explore: executor('research-explore', { evidence_ready: transition('assess', 'research-to-assess'), more_exploration: transition('explore', 'research-continue-exploration'), ...endings() }),
    assess: executor('research-assess', { supported: transition('report', 'research-supported-to-report'), refuted: transition('report', 'research-refuted-to-report'), bounded_inconclusive: transition('report', 'research-inconclusive-to-report'), evidence_gap: transition('explore', 'research-continue-exploration'), ...endings() }),
    report: executor('research-report', { done: terminal('DONE', 'status.md'), ...endings() }),
  }, 'explore'),
  ops: leaf({ execute: executor('execute', { done: terminal('DONE', 'status.md'), ...endings() }) }, 'execute'),
};

export function specializedConfig(): SaivageConfig {
  const { card_types: _cardTypes, ...globals } = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  const source = saivageConfigSchema.parse({ ...globals, card_type_set: 'specialized' });
  return effectiveSaivageConfigSchema.parse(resolveCardTypeSelection(source, BUNDLED_CARD_TYPE_SETS));
}

export function specializedDefinition() {
  const definition = BUNDLED_CARD_TYPE_SETS.find(({ name }) => name === 'specialized');
  if (!definition) throw new Error("Bundled card type set 'specialized' is missing.");
  return definition;
}
