import { describe, expect, it, jest } from '@jest/globals';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  VALUE_CONTRACT_MANIFEST,
  formatVerificationResult,
  serializeValueContractClaim,
  verifyCardDiffPivotDocs,
  verifyClosedVocabularyDocs,
  verifyDocSourceContracts,
  verifyErrorShapeDocs,
  verifyIdentityGrammarDocs,
  verifySourceConstantDocs,
  verifyToolContractDocs,
} from '../../scripts/verify-doc-routes.js';

const SCRIPT = join(process.cwd(), 'scripts/verify-doc-routes.js');
jest.setTimeout(240_000);
const CUTOVERS = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/doc-value-contracts/cutover-paragraphs.json'), 'utf8'));
const CARD_ERROR_PATHS = ['src/application/read-models/cards-read-model.ts', 'src/cards/card-service.ts', 'src/contracts/historical-version-not-found.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/server/routes/operator-runtime-card-handlers.ts'];
const PROCESS_PATHS = ['src/application/runtime-composition.ts', 'src/mcp/mcp-manager.ts', 'src/mcp/server-runtime.ts', 'src/runtime/actors/supervisor-runtime-api.ts', 'src/runtime/managed-process-group-registry.ts', 'src/tools/process-provider.ts'];
const TOOL_RELATION_PATHS = ['src/config/system-templates/classic-typed/template.ts', 'src/config/system-templates/classic/template.ts', 'src/config/system-templates/registry.ts', 'src/contracts/result-envelope.ts', 'src/tools/tool-invocation-outbound.ts', 'web/src/utils/tool-presenters/presenters.ts'];
const EXPECTED_CATALOG = {
  'constant.analyst-orientation-max-bytes': ['constants', ['src/application/read-models/analyst-orientation.ts']],
  'constant.analyst-title-preview-max-bytes': ['constants', ['src/application/read-models/analyst-orientation.ts']],
  'constant.app-cleanup-leaf-timeout-ms': ['constants', ['src/boot/app.ts']],
  'constant.compaction-refine-max-invocations': ['constants', ['src/runtime/actors/compaction/refine-accumulator.ts']],
  'constant.emit-result-summary-max-chars': ['constants', ['src/runtime/card-process/card-process-config.ts']],
  'constant.managed-process-post-kill-verification-ms': ['constants', PROCESS_PATHS],
  'constant.managed-process-term-grace-ms': ['constants', PROCESS_PATHS],
  'constant.maximum-card-depth-segments': ['constants', ['src/application/read-models/canonical-card-files-read-model.ts', 'src/cards/card-service.ts', 'src/schemas/card-id.ts']],
  'constant.node-corrective-rearm-limit': ['constants', ['src/runtime/actors/agent-node-execution.ts']],
  'constant.summarizer-completion-tokens': ['constants', ['src/runtime/actors/compaction/summarizer.ts']],
  'constant.summarizer-output-target-bytes': ['constants', ['src/runtime/actors/compaction/summarizer.ts']],
  'constant.sync-hub-debounce-ms': ['constants', ['src/server/sync-hub.ts']],
  'constant.tool-result-envelope-max-bytes': ['constants', ['src/contracts/builtin-tool-inputs.ts', 'src/tools/card-inspection-provider.ts', 'src/tools/card-version-provider.ts', 'src/tools/project-file-tools.ts', 'src/tools/response-packer.ts']],
  'error.analyst-turn-busy': ['errors', ['src/contracts/operator-api-chats.ts', 'src/contracts/operator-events.ts', 'src/server/analyst-ws-handler.ts', 'src/server/routes/operator-chat-handlers.ts']],
  'error.cards-diff-404': ['errors', CARD_ERROR_PATHS],
  'error.cards-history-404': ['errors', CARD_ERROR_PATHS],
  'error.unauthorized': ['errors', ['src/contracts/operator-api-core.ts']],
  'error.unexpected-internal': ['errors', ['src/contracts/operator-api-core.ts', 'src/server/contract-runtime.ts']],
  'identity.card': ['identities', ['src/application/read-models/canonical-card-files-read-model.ts', 'src/cards/card-service.ts', 'src/schemas/card-id.ts']],
  'identity.conversation-session': ['identities', ['src/schemas/conversation-session-id.ts']],
  'pivot.cards-diff-from': ['pivots', ['src/application/read-models/cards-read-model.ts', 'src/cards/card-service.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/server/routes/operator-runtime-card-handlers.ts']],
  'pivot.cards-diff-to': ['pivots', ['src/application/read-models/cards-read-model.ts', 'src/cards/card-service.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/server/routes/operator-runtime-card-handlers.ts']],
  'pivot.ui-cards-diff-current-request': ['pivots', ['web/src/api/client.ts', 'web/src/stores/cards.ts']],
  'tools.exclusive-identities': ['tools', TOOL_RELATION_PATHS],
  'tools.projector-presenter-equality': ['tools', TOOL_RELATION_PATHS],
  'tools.shipped-role-inventories': ['tools', ['src/config/system-templates/classic-typed/template.ts', 'src/config/system-templates/classic/template.ts', 'src/config/system-templates/registry.ts']],
  'vocabulary.app-log-type': ['vocabularies', ['src/contracts/app-log.ts', 'src/persistence/app-log.ts']],
  'vocabulary.availability-component-source': ['vocabularies', ['src/contracts/operator-api-availability.ts']],
  'vocabulary.availability-state': ['vocabularies', ['src/contracts/operator-api-availability.ts']],
  'vocabulary.card-version-change-kind': ['vocabularies', ['src/schemas/card-version-change.ts']],
  'vocabulary.lifecycle-status': ['vocabularies', ['src/contracts/builtin-tool-inputs.ts', 'src/contracts/operator-api-runtime-cards.ts', 'src/schemas/lifecycle.ts', 'src/schemas/types.ts', 'src/schemas/validators.ts']],
  'vocabulary.logged-event-kind': ['vocabularies', ['src/application/event-query-service.ts', 'src/contracts/app-log.ts', 'src/contracts/builtin-tool-inputs.ts', 'src/contracts/operator-api-events.ts', 'src/schemas/event-catalog.ts', 'src/server/routes/operator-events-handlers.ts', 'src/tools/global-observation-tools.ts']],
};
const EXPECTED_MANIFEST = [
  ['card-identity', ['identities', 'constants'], 'docs/spec/system-specification.md', '### Exact card identity contract', ['identity.card', 'constant.maximum-card-depth-segments']],
  ['card-lifecycle-vocabulary', ['vocabularies'], 'docs/spec/system-specification.md', '### Exact card lifecycle vocabulary', ['vocabulary.lifecycle-status']],
  ['card-change-vocabulary', ['vocabularies'], 'docs/spec/system-specification.md', '### Exact card history vocabulary', ['vocabulary.card-version-change-kind']],
  ['session-identity', ['identities'], 'docs/spec/system-specification.md', '### Exact conversation-session identity contract', ['identity.conversation-session']],
  ['emit-result-limit', ['constants'], 'docs/spec/system-specification.md', '### Exact terminal-result limit', ['constant.emit-result-summary-max-chars']],
  ['node-corrective-rearm-limit', ['constants'], 'docs/spec/system-specification.md', '### Exact node corrective budget', ['constant.node-corrective-rearm-limit']],
  ['cleanup-limits', ['constants'], 'docs/spec/system-specification.md', '### Exact cleanup timing contract', ['constant.app-cleanup-leaf-timeout-ms', 'constant.managed-process-term-grace-ms', 'constant.managed-process-post-kill-verification-ms']],
  ['availability-contract', ['vocabularies'], 'docs/spec/system-specification.md', '### Exact availability vocabulary', ['vocabulary.availability-state', 'vocabulary.availability-component-source']],
  ['app-log-contract', ['vocabularies'], 'docs/spec/system-specification.md', '### Exact app-log vocabularies', ['vocabulary.app-log-type', 'vocabulary.logged-event-kind']],
  ['context-limits', ['constants'], 'docs/spec/system-specification.md', '### Exact context and compaction limits', ['constant.analyst-orientation-max-bytes', 'constant.analyst-title-preview-max-bytes', 'constant.tool-result-envelope-max-bytes', 'constant.summarizer-completion-tokens', 'constant.summarizer-output-target-bytes', 'constant.compaction-refine-max-invocations']],
  ['tool-identities', ['tools'], 'docs/architecture/system-architecture.md', '### Exact shipped tool identities', ['tools.shipped-role-inventories', 'tools.projector-presenter-equality', 'tools.exclusive-identities']],
  ['operator-error-contracts', ['errors'], 'docs/spec/system-specification.md', '### Exact shared operator error contracts', ['error.analyst-turn-busy', 'error.unauthorized', 'error.unexpected-internal']],
  ['backend-card-history-diff', ['errors', 'pivots'], 'docs/spec/system-specification.md', '### Exact backend card history and diff contract', ['error.cards-history-404', 'error.cards-diff-404', 'pivot.cards-diff-from', 'pivot.cards-diff-to']],
  ['sync-debounce', ['constants'], 'docs/architecture/system-architecture.md', '### Exact SyncHub debounce policy', ['constant.sync-hub-debounce-ms']],
  ['displayed-current-diff', ['pivots'], 'docs/spec/operator-ui.md', '### Exact displayed-current-diff request contract', ['pivot.ui-cards-diff-current-request']],
];
const families = [
  ['errors', verifyErrorShapeDocs, 'error.analyst-turn-busy'],
  ['vocabularies', verifyClosedVocabularyDocs, 'vocabulary.lifecycle-status'],
  ['constants', verifySourceConstantDocs, 'constant.emit-result-summary-max-chars'],
  ['tools', verifyToolContractDocs, 'tools.exclusive-identities'],
  ['identities', verifyIdentityGrammarDocs, 'identity.conversation-session'],
  ['pivots', verifyCardDiffPivotDocs, 'pivot.ui-cards-diff-current-request'],
];

function withProject(testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-doc-values-'));
  try {
    for (const path of ['src', 'web/src', 'docs', 'README.md']) cpSync(join(process.cwd(), path), join(root, path), { recursive: true });
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function replaceChecked(root, path, before, after) {
  const target = join(root, path);
  const source = readFileSync(target, 'utf8');
  expect(source).toContain(before);
  writeFileSync(target, source.replace(before, after));
}

function replaceAllChecked(root, path, before, after) {
  const target = join(root, path);
  const source = readFileSync(target, 'utf8');
  expect(source).toContain(before);
  writeFileSync(target, source.replaceAll(before, after));
}

function driftClaimRow(root, claimKey) {
  const entry = VALUE_CONTRACT_MANIFEST.find((candidate) => candidate.claims.includes(claimKey));
  replaceChecked(root, entry.file, `${claimKey} = {`, `${claimKey} = {"fixture":true,`);
}

const INVENTED_SHAPES = {
  'error.unexpected-internal': { strict: true, variants: [{ strict: true, fields: { inventedLiteral: { kind: 'literal', value: 'fixture' } } }, { strict: true, fields: { inventedSchema: { kind: 'schema', name: 'FixtureSchema' } } }, { strict: true, fields: { inventedType: { kind: 'type', name: 'boolean' } } }] },
  'vocabulary.availability-state': { members: ['fixture-z', 'fixture-a'] },
  'constant.sync-hub-debounce-ms': { unit: 'milliseconds', value: 17 },
  'tools.shipped-role-inventories': { templates: ['template-z', 'template-a'], agents: [{ name: 'role-z', tools: ['second', 'first'] }, { name: 'role-a', tools: ['only'] }] },
  'tools.projector-presenter-equality': { names: ['tool-z', 'tool-a'], sources: ['source-z', 'source-a'], gates: ['gate-z', 'gate-a'] },
  'tools.exclusive-identities': { analystPresenterOnly: ['analyst-z', 'analyst-a'], plannerOnly: ['planner-z', 'planner-a'] },
  'identity.card': { alternatives: [{ kind: 'literal', value: 'root-fixture' }, { kind: 'pattern', source: '^fixture$' }], pattern: { source: '^fixture$', flags: 'u', anchored: true }, segment: { source: '^x+$', flags: 'u', anchored: true }, stem: 'fixture', separator: '.', minimumSegments: 2, maximumSegments: 7 },
  'identity.conversation-session': { inputGuard: 'string', pattern: { source: '^fixture:(.+)$', flags: 'u', anchored: true }, captures: [{ index: 4, meaning: 'fixture-agent' }, { index: 8, meaning: 'fixture-scope' }], nullTest: 'fixture !== null', agentParser: 'FixtureAgentParser', scopeAlternatives: ['fixture-global', 'FixtureScopeParser'], constructors: [{ name: 'fixtureGlobal', template: '`fixture:${agent}:global`' }, { name: 'fixtureScoped', template: '`fixture:${agent}:${scope}`' }], identityParser: 'fixtureIdentity', operators: ['&&', '||'], grouping: 'fixture && (other || final)' },
  'pivot.cards-diff-from': { field: 'from', presence: 'required', variants: [{ kind: 'canonical-positive-safe-integer' }], mapping: 'fromVersion', regex: '^fixture-from$', refinement: 'fixtureFromRefinement', transform: 'Number' },
  'pivot.cards-diff-to': { field: 'to', presence: 'optional', variants: [{ kind: 'literal', value: 'current' }, { kind: 'canonical-positive-safe-integer' }], mapping: 'toVersion', regex: '^fixture-to$', refinement: 'fixtureToRefinement', transform: 'Number', meanings: { numeric: 'historical-version', omitted: 'current-artifact', current: 'current-artifact' } },
  'pivot.ui-cards-diff-current-request': { key: [{ name: 'fixtureCard', type: 'FixtureCard' }, { name: 'fixtureFrom', type: 'FixtureFrom' }], selection: { construction: { cardId: 'fixtureCard', fromSeq: 'fixtureFrom', to: 'current' }, frozen: true, startArgument: 'fixtureKey' }, request: { operation: 'cards.diff', params: { id: 'fixture.id' }, query: { from: 'fixture.from', to: 'fixture.to' }, signal: 'forwarded' }, currentness: { abortPreviousOwner: true, freshOwner: ['fixture-controller', 'fixture-promise'], fences: ['fixture-success', 'fixture-rejection', 'fixture-finally'], selectionGuards: ['fixture-card-guard', 'fixture-version-guard'], acceptedSideCondition: ['fixture-card-match', 'fixture-version-match'], retainedKey: 'fixture-original-key' }, reuse: { refresh: 'fixture-refresh', retry: 'fixture-retry', invalidationGates: ['fixture-scope', 'fixture-visible'], reconnectGates: ['fixture-key', 'fixture-freshness'] } },
};

function objectFieldPaths(value, prefix = []) {
  if (Array.isArray(value)) return value.flatMap((item, index) => objectFieldPaths(item, [...prefix, index]));
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value).flatMap((key) => [[...prefix, key], ...objectFieldPaths(value[key], [...prefix, key])]);
}

function parentAt(value, path) {
  let current = value;
  for (const part of path.slice(0, -1)) current = current[part];
  return current;
}

function mutateShape(value, path, kind) {
  const copy = structuredClone(value);
  const parent = parentAt(copy, path);
  const key = path.at(-1);
  const original = parent[key];
  if (kind === 'remove') delete parent[key];
  if (kind === 'add') parent.fixtureUnexpected = 'unexpected';
  if (kind === 'rename') { delete parent[key]; parent[`${String(key)}Renamed`] = original; }
  if (kind === 'renest') parent[key] = { nested: original };
  if (kind === 'wrong-type') parent[key] = null;
  return copy;
}

function detached(fragment) {
  let index = fragment.search(/[A-Za-z_]/u);
  if (index < 0) index = fragment.search(/[0-9]/u);
  if (index < 0) throw new Error(`Cannot detach fragment ${fragment}`);
  return `${fragment.slice(0, index)}x${fragment.slice(index + 1)}`;
}

const SOURCE_MUTATIONS = [
  ['historical declaration', verifyErrorShapeDocs, 'src/contracts/historical-version-not-found.ts', "HistoricalVersionNotFoundErrorSchema = historicalVersionNotFoundSchema(\n  'card',\n  cardIdSchema,\n)"],
  ['history union', verifyErrorShapeDocs, 'src/contracts/operator-api-runtime-cards.ts', 'CardHistoryEntryNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, HistoricalVersionNotFoundErrorSchema])'],
  ['diff union', verifyErrorShapeDocs, 'src/contracts/operator-api-runtime-cards.ts', 'CardDiffNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, HistoricalVersionNotFoundErrorSchema])'],
  ['history route union reference', verifyErrorShapeDocs, 'src/contracts/operator-api-runtime-cards.ts', '404: CardHistoryEntryNotFoundUnionSchema'],
  ['diff route union reference', verifyErrorShapeDocs, 'src/contracts/operator-api-runtime-cards.ts', '404: CardDiffNotFoundUnionSchema'],
  ['history handler pass-through', verifyErrorShapeDocs, 'src/server/routes/operator-runtime-card-handlers.ts', 'getHistoryEntry(params.id, params.version)'],
  ['diff handler pass-through', verifyErrorShapeDocs, 'src/server/routes/operator-runtime-card-handlers.ts', 'diffCard(params.id, query)'],
  ['historical read-model serialization', verifyErrorShapeDocs, 'src/application/read-models/cards-read-model.ts', "body: { error: 'historical_version_not_found', resource: 'card', owner_id: id, version"],
  ['history catalog selection', verifyErrorShapeDocs, 'src/cards/card-service.ts', 'readCommittedCardArtifactCatalog(this.projectRoot, id, instrumentation)'],
  ['history card absence', verifyErrorShapeDocs, 'src/cards/card-service.ts', "if (catalog.kind === 'card-not-found') return catalog"],
  ['history exact row', verifyErrorShapeDocs, 'src/cards/card-service.ts', 'catalog.value.rows[version - 1]'],
  ['history exact version', verifyErrorShapeDocs, 'src/cards/card-service.ts', 'row.version === version'],
  ['history version absence', verifyErrorShapeDocs, 'src/cards/card-service.ts', "{ kind: 'version-not-found', version }"],
  ['diff service selection', verifyErrorShapeDocs, 'src/cards/card-service.ts', "kind:'version-not-found' as const,version,side"],
  ['Analyst busy declaration', verifyErrorShapeDocs, 'src/contracts/operator-api-chats.ts', "error: z.literal('analyst_turn_busy')"],
  ['Analyst busy frozen constant', verifyErrorShapeDocs, 'src/contracts/operator-api-chats.ts', 'ANALYST_TURN_BUSY_ERROR = Object.freeze('],
  ['Analyst busy REST mapping', verifyErrorShapeDocs, 'src/server/routes/operator-chat-handlers.ts', 'statusCode: 409, body: ANALYST_TURN_BUSY_ERROR'],
  ['Analyst busy WebSocket member', verifyErrorShapeDocs, 'src/contracts/operator-events.ts', '  AnalystTurnBusyErrorSchema,\n  AnalystProcessingFailedErrorSchema,'],
  ['Analyst busy WebSocket producer', verifyErrorShapeDocs, 'src/server/analyst-ws-handler.ts', '? ANALYST_TURN_BUSY_ERROR'],
  ['lifecycle domain union', verifyClosedVocabularyDocs, 'src/schemas/types.ts', 'cardStatusValues'],
  ['lifecycle schema variants', verifyClosedVocabularyDocs, 'src/schemas/lifecycle.ts', "status: z.literal('backlog')"],
  ['lifecycle validator', verifyClosedVocabularyDocs, 'src/schemas/validators.ts', 'cardStatusSchema = z.enum(cardStatusValues)'],
  ['lifecycle operator status', verifyClosedVocabularyDocs, 'src/contracts/operator-api-runtime-cards.ts', 'status: cardStatusSchema'],
  ['lifecycle operator detail', verifyClosedVocabularyDocs, 'src/contracts/operator-api-runtime-cards.ts', 'lifecycle: CardDetailLifecycleSchema'],
  ['lifecycle scalar tool filter', verifyClosedVocabularyDocs, 'src/contracts/builtin-tool-inputs.ts', 'z.union([z.enum(cardStatusValues),'],
  ['lifecycle array tool filter', verifyClosedVocabularyDocs, 'src/contracts/builtin-tool-inputs.ts', 'z.array(z.enum(cardStatusValues))'],
  ['card-change declaration', verifyClosedVocabularyDocs, 'src/schemas/card-version-change.ts', "'child_link'"],
  ['availability state declaration', verifyClosedVocabularyDocs, 'src/contracts/operator-api-availability.ts', "'available'"],
  ['availability source declaration', verifyClosedVocabularyDocs, 'src/contracts/operator-api-availability.ts', "'health-check'"],
  ['app-log lane declaration', verifyClosedVocabularyDocs, 'src/contracts/app-log.ts', "type: z.literal('event')"],
  ['app-log direct union', verifyClosedVocabularyDocs, 'src/contracts/app-log.ts', 'appLogEntrySchema = z.discriminatedUnion'],
  ['app-log strict read', verifyClosedVocabularyDocs, 'src/persistence/app-log.ts', 'readStrictCanonicalGrowingFile(path, appLogEntrySchema)'],
  ['app-log append preparation', verifyClosedVocabularyDocs, 'src/persistence/app-log.ts', 'prepareGrowingEnvelope([candidate], appLogEntrySchema)'],
  ['app-log type fence', verifyClosedVocabularyDocs, 'src/persistence/app-log.ts', 'candidate.type !== entryType'],
  ['logged-event declaration list', verifyClosedVocabularyDocs, 'src/schemas/event-catalog.ts', 'eventKindValues'],
  ['logged-event variant', verifyClosedVocabularyDocs, 'src/schemas/event-catalog.ts', "kind: z.literal('runtime_diagnostic')"],
  ['logged-event app-log acceptance', verifyClosedVocabularyDocs, 'src/contracts/app-log.ts', 'data: loggedEventSchema'],
  ['logged-event tool filter', verifyClosedVocabularyDocs, 'src/contracts/builtin-tool-inputs.ts', 'kind: z.enum(eventKindValues).optional()'],
  ['logged-event REST filter', verifyClosedVocabularyDocs, 'src/contracts/operator-api-events.ts', 'kind: z.enum(eventKindValues).optional()'],
  ['logged-event REST output', verifyClosedVocabularyDocs, 'src/contracts/operator-api-events.ts', 'events: z.array(loggedEventSchema)'],
  ['logged-event persisted read', verifyClosedVocabularyDocs, 'src/application/event-query-service.ts', "readAppLogEntries(this.projectRoot, 'event')"],
  ['logged-event query comparison', verifyClosedVocabularyDocs, 'src/application/event-query-service.ts', 'event.kind === query.kind'],
  ['logged-event route pass-through', verifyClosedVocabularyDocs, 'src/server/routes/operator-events-handlers.ts', 'readModel.queryEvents(query)'],
  ['logged-event tool vocabulary', verifyClosedVocabularyDocs, 'src/tools/global-observation-tools.ts', 'eventKindValues'],
  ['logged-event tool query', verifyClosedVocabularyDocs, 'src/tools/global-observation-tools.ts', "queryEvents({selection:'newest_tail'"],
  ['classic template registry member', verifyToolContractDocs, 'src/config/system-templates/registry.ts', 'CLASSIC_TEMPLATE,'],
  ['typed template registry member', verifyToolContractDocs, 'src/config/system-templates/registry.ts', 'CLASSIC_TYPED_TEMPLATE'],
  ['classic template name', verifyToolContractDocs, 'src/config/system-templates/classic/template.ts', "name: 'classic'"],
  ['typed template name', verifyToolContractDocs, 'src/config/system-templates/classic-typed/template.ts', "name: 'classic-typed'"],
  ['classic materialization', verifyToolContractDocs, 'src/config/system-templates/classic/template.ts', 'agents:structuredClone(CLASSIC_AGENTS)'],
  ['typed materialization', verifyToolContractDocs, 'src/config/system-templates/classic-typed/template.ts', 'agents:structuredClone(AGENTS)'],
  ...['classic', 'classic-typed'].flatMap((template) => {
    const path = `src/config/system-templates/${template}/template.ts`;
    return [
      [`${template} Analyst tool set`, verifyToolContractDocs, path, "analyst: Object.freeze({ prompt: prompt('analyst'), tools: Object.freeze(['create_card'"],
      [`${template} Planner tool set`, verifyToolContractDocs, path, "planner: Object.freeze({ prompt: prompt('planner'), tools: Object.freeze(['create_card'"],
      [`${template} Reviewer tool set`, verifyToolContractDocs, path, "reviewer: Object.freeze({ prompt: prompt('reviewer'), tools: Object.freeze(['read'"],
      [`${template} Executor tool set`, verifyToolContractDocs, path, "executor: Object.freeze({ prompt: prompt('executor'), tools: Object.freeze(['read'"],
    ];
  }),
  ['known projected tools', verifyToolContractDocs, 'src/tools/tool-invocation-outbound.ts', 'KNOWN_TOOL_INVOCATION_NAMES'],
  ['tool presenters', verifyToolContractDocs, 'web/src/utils/tool-presenters/presenters.ts', 'TOOL_PRESENTERS'],
  ['terminal result union member', verifyToolContractDocs, 'src/contracts/result-envelope.ts', 'TERMINAL_RESULT_TOOL_NAME'],
  ['first projector gate', verifyToolContractDocs, 'src/tools/tool-invocation-outbound.ts', 'knownToolNames.has(input.identity.toolName)', 0],
  ['second projector gate', verifyToolContractDocs, 'src/tools/tool-invocation-outbound.ts', 'knownToolNames.has(input.identity.toolName)', 1],
  ['card segment grammar', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '/^[a-z]+$/u'],
  ['card segment minimum quantifier', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '[a-z]+$/u'],
  ['card root alternative', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', "z.literal('project')"],
  ['card patterned alternative', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', 'nonRootCardIdSchema])'],
  ['card stem', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '^card-[a-z]+'],
  ['card separator', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '(?:-[a-z]+)'],
  ['card pattern terminal anchor', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '}}$`, \'u\')'],
  ['card pattern flags', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', "MAX_CARD_DEPTH - 1}}$`, 'u')"],
  ['card constructor', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', "parentId === 'project' ? `card-${segment}` : `${parentId}-${segment}`"],
  ['card depth regex use', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '${MAX_CARD_DEPTH - 1}'],
  ['card depth message use', verifyIdentityGrammarDocs, 'src/schemas/card-id.ts', '${MAX_CARD_DEPTH} alphabetic segments'],
  ['CardService over-limit depth use', verifyIdentityGrammarDocs, 'src/cards/card-service.ts', 'depth > MAX_CARD_DEPTH'],
  ['CardService leaf depth use', verifyIdentityGrammarDocs, 'src/cards/card-service.ts', 'depth===MAX_CARD_DEPTH'],
  ['CardService depth messages', verifyIdentityGrammarDocs, 'src/cards/card-service.ts', '${MAX_CARD_DEPTH}.'],
  ['canonical Files depth stop', verifyIdentityGrammarDocs, 'src/application/read-models/canonical-card-files-read-model.ts', 'depth === MAX_CARD_DEPTH'],
  ['session pattern', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', '/^agent:([a-z][a-z0-9-]{0,63}):(.+)$/u'],
  ['session input guard', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', "typeof value !== 'string'"],
  ['session null test', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'match !== null'],
  ['session agent parser', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'agentNameSchema.safeParse(match[1])'],
  ['session global alternative', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', "match[2] === 'global'"],
  ['session scope parser', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'cardIdSchema.safeParse(match[2])'],
  ['session global constructor', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', '`agent:${agentName}:global`'],
  ['session card constructor', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', '`agent:${agentName}:${cardId}`'],
  ['session identity agent capture', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'agentName: agentNameSchema.parse(match[1])'],
  ['session identity scope capture', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', "cardId: match[2] === 'global' ? null : cardIdSchema.parse(match[2])"],
  ['session identity parser name', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'function conversationSessionIdentity('],
  ['session global constructor name', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'function globalAgentSessionId('],
  ['session card constructor name', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', 'function cardAgentSessionId('],
  ['session validation grouping', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', "match !== null && agentNameSchema.safeParse(match[1]).success && (match[2] === 'global' || cardIdSchema.safeParse(match[2]).success)"],
  ['backend from query field', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', 'from: canonicalPositiveSafeIntegerStringSchema'],
  ['backend to query field', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', 'to: diffPivotSchema.optional()'],
  ['backend pivot ordered variants', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', "diffPivotSchema = z.union([z.literal('current'), canonicalPositiveSafeIntegerStringSchema])"],
  ['backend strict query shape', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', 'CardDiffQuerySchema = z.object({ from: canonicalPositiveSafeIntegerStringSchema, to: diffPivotSchema.optional() }).strict()'],
  ['backend numeric regex', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', '/^[1-9][0-9]*$/'],
  ['backend numeric refinement', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', 'positiveSafeIntegerSchema.safeParse(Number(raw)).success'],
  ['backend numeric transform', verifyCardDiffPivotDocs, 'src/contracts/operator-api-runtime-cards.ts', '.transform(Number)'],
  ['backend read-model mapping', verifyCardDiffPivotDocs, 'src/application/read-models/cards-read-model.ts', 'fromVersion: query.from, toVersion: query.to'],
  ['backend service numeric meaning', verifyCardDiffPivotDocs, 'src/cards/card-service.ts', "typeof pivots.toVersion === 'number' ? pivots.toVersion"],
  ['backend service catalog', verifyCardDiffPivotDocs, 'src/cards/card-service.ts', 'readCommittedCardArtifactCatalog(this.projectRoot, id, instrumentation)'],
  ['backend service current artifact', verifyCardDiffPivotDocs, 'src/cards/card-service.ts', "pivots.toVersion===undefined||pivots.toVersion==='current'?catalog.value.head"],
  ...[
    ['UI previous-owner abort', 'diffOwner?.controller.abort()'],
    ['UI accepted card key', 'cardHistoryDiffKey.value?.cardId === key.cardId'],
    ['UI accepted version key', 'cardHistoryDiffKey.value.fromSeq === key.fromSeq'],
    ['UI fresh controller', 'const controller = new AbortController()'],
    ['UI fresh owner', 'let owner!: RequestOwner'],
    ['UI owner promise', 'const promise = getCardDiff(key, controller.signal)'],
    ['UI success owner fence', 'diffOwner !== owner'],
    ['UI card selection guard', 'selectedCardId.value !== key.cardId'],
    ['UI version selection guard', 'cardHistorySelectedVersion.value !== key.fromSeq'],
    ['UI rejection owner fence', 'if (diffOwner !== owner || aborted(error)) return'],
    ['UI finalization owner fence', 'if (diffOwner === owner)'],
    ['UI owner installation', 'owner = markRaw({ controller, promise })'],
    ['UI owner retention', 'diffOwner = owner'],
    ['UI request-key retention', 'cardHistoryDiffKey.value = key'],
    ['UI frozen key construction', "Object.freeze({ cardId, fromSeq: version, to: 'current' as const })"],
    ['UI selected key start', 'startDiff(key, null)'],
    ['UI refresh reuse', 'return startDiff(cardHistoryDiffKey.value, reason)'],
    ['UI Retry delegation', "return refreshDiff('invalidated')"],
    ['UI invalidation scope', "target.scope === 'diff' && cardHistoryVisible.value && cardHistoryDiffKey.value"],
    ['UI invalidation refresh', "void refreshDiff('invalidated')"],
    ['UI reconnect freshness', "cardHistoryDiffFreshness.value.staleReason !== 'refresh-failed'"],
    ['UI reconnect refresh', "void refreshDiff('reconnect')"],
  ].map(([label, fragment]) => [label, verifyCardDiffPivotDocs, 'web/src/stores/cards.ts', fragment]),
  ['UI API operation', verifyCardDiffPivotDocs, 'web/src/api/client.ts', "operatorRequest('cards.diff'"],
  ['UI API params', verifyCardDiffPivotDocs, 'web/src/api/client.ts', 'params: { id: key.cardId }'],
  ['UI API from serialization', verifyCardDiffPivotDocs, 'web/src/api/client.ts', 'from: String(key.fromSeq)'],
  ['UI API direct current pivot', verifyCardDiffPivotDocs, 'web/src/api/client.ts', 'to: key.to'],
  ['UI API signal forwarding', verifyCardDiffPivotDocs, 'web/src/api/client.ts', 'signal,'],
];

const CONSTANT_OCCURRENCE_SPECS = [
  ['src/application/read-models/analyst-orientation.ts', 'ANALYST_ORIENTATION_MAX_BYTES'],
  ['src/application/read-models/analyst-orientation.ts', 'ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES'],
  ['src/boot/app.ts', 'APP_CLEANUP_LEAF_TIMEOUT_MS'],
  ['src/runtime/card-process/card-process-config.ts', 'EMIT_RESULT_SUMMARY_MAX_CHARS'],
  ['src/runtime/managed-process-group-registry.ts', 'MANAGED_PROCESS_POST_KILL_VERIFICATION_MS'],
  ['src/runtime/managed-process-group-registry.ts', 'MANAGED_PROCESS_TERM_GRACE_MS'],
  ['src/runtime/actors/compaction/summarizer.ts', 'SUMMARY_COMPLETION_TOKENS'],
  ['src/runtime/actors/compaction/summarizer.ts', 'SUMMARY_OUTPUT_TARGET_BYTES'],
  ['src/runtime/actors/compaction/refine-accumulator.ts', 'MAX_REFINE_INVOCATIONS'],
  ['src/server/sync-hub.ts', 'SYNC_HUB_DEBOUNCE_MS'],
  ['src/contracts/builtin-tool-inputs.ts', 'DISCOVERY_RESPONSE_MAX_BYTES'],
  ['src/tools/card-inspection-provider.ts', 'DISCOVERY_RESPONSE_MAX_BYTES'],
  ['src/tools/card-version-provider.ts', 'DISCOVERY_RESPONSE_MAX_BYTES'],
  ['src/tools/project-file-tools.ts', 'DISCOVERY_RESPONSE_MAX_BYTES'],
  ['src/tools/response-packer.ts', 'DISCOVERY_RESPONSE_MAX_BYTES'],
];
const CONSTANT_OCCURRENCE_MUTATIONS = CONSTANT_OCCURRENCE_SPECS.flatMap(([path, token]) => {
  const count = readFileSync(join(process.cwd(), path), 'utf8').split(token).length - 1;
  return Array.from({ length: count }, (_, index) => [`${path} ${token} occurrence ${index + 1}`, path, token, index]);
});
const TERM_DEFAULT_CALL_MUTATIONS = [
  ['src/application/runtime-composition.ts', 'processRunner.closeAndTerminateDirectScope({'],
  ['src/application/runtime-composition.ts', 'processRunner.terminateScopeTree({'],
  ['src/mcp/mcp-manager.ts', 'processRunner.terminateScopeTree({'],
  ['src/runtime/actors/supervisor-runtime-api.ts', 'processRunner.terminateScopeTree({'],
  ['src/tools/process-provider.ts', 'processRunner.closeAndTerminateDirectScope({'],
].flatMap(([path, token]) => {
  const count = readFileSync(join(process.cwd(), path), 'utf8').split(token).length - 1;
  return Array.from({ length: count }, (_, index) => [`${path} call ${index + 1}`, path, token, index]);
});

function replaceOccurrence(root, path, token, occurrence) {
  const target = join(root, path);
  const source = readFileSync(target, 'utf8');
  let seen = -1;
  const changed = source.replaceAll(token, (match) => {
    seen += 1;
    return seen === occurrence ? 'FIXTURE_DETACHED' : match;
  });
  expect(seen).toBeGreaterThanOrEqual(occurrence);
  writeFileSync(target, changed);
}

describe('documentation value contracts', () => {
  it('publishes a closed, total fourteen-block catalog', () => {
    expect(VALUE_CONTRACT_MANIFEST.map(({ key, family, file, heading, claims }) => [key, family, file, heading, claims])).toEqual(EXPECTED_MANIFEST);
    const uses = VALUE_CONTRACT_MANIFEST.flatMap((entry) => entry.claims).sort();
    expect(uses).toEqual(Object.keys(EXPECTED_CATALOG).sort());
    expect(new Set(uses).size).toBe(uses.length);
    for (const [family, verify] of families) {
      const result = verify({ projectRoot: process.cwd() });
      const expectedClaims = Object.entries(EXPECTED_CATALOG).filter(([, [candidate]]) => candidate === family).map(([key]) => key).sort();
      const expectedPaths = [...new Set(Object.entries(EXPECTED_CATALOG).filter(([, [candidate]]) => candidate === family).flatMap(([, [, paths]]) => paths))].sort();
      const expectedBlocks = EXPECTED_MANIFEST.filter(([, blockFamilies]) => blockFamilies.includes(family)).map(([key]) => key).sort();
      expect(result.checkedClaimKeys).toEqual(expectedClaims);
      expect(result.checkedBlockKeys).toEqual(expectedBlocks);
      expect(result.selectedSourcePaths).toEqual(expectedPaths);
      for (const values of [result.checkedClaimKeys, result.checkedBlockKeys, result.selectedSourcePaths]) {
        expect(values).toEqual([...values].sort());
        expect(new Set(values).size).toBe(values.length);
      }
    }
  });

  it('canonicalizes invented JSON values and rejects unsupported values', () => {
    expect(serializeValueContractClaim('vocabulary.availability-state', { members: ['zebra', 'alpha'] }))
      .toBe('{"members":["alpha","zebra"]}');
    expect(serializeValueContractClaim('constant.sync-hub-debounce-ms', { unit: 'milliseconds', value: 17 }))
      .toBe('{"unit":"milliseconds","value":17}');
    expect(serializeValueContractClaim('constant.app-cleanup-leaf-timeout-ms', { unit: 'bytes', value: 17 }))
      .not.toBe(serializeValueContractClaim('constant.app-cleanup-leaf-timeout-ms', { unit: 'milliseconds', value: 17 }));
    expect(() => serializeValueContractClaim('constant.sync-hub-debounce-ms', { unit: 'milliseconds', value: Number.POSITIVE_INFINITY })).toThrow('finite safe integer');
    expect(() => serializeValueContractClaim('constant.sync-hub-debounce-ms', { unit: 'milliseconds', value: 1.5 })).toThrow('finite safe integer');
    expect(() => serializeValueContractClaim('vocabulary.availability-state', { members: [undefined] })).toThrow('string');
    expect(() => serializeValueContractClaim('vocabulary.availability-state', { members: ['two\nlines'] })).toThrow('single-line string');
    expect(() => serializeValueContractClaim('vocabulary.availability-state', { members: ['duplicate', 'duplicate'] })).toThrow('duplicates');
    expect(() => serializeValueContractClaim('tools.fixture-unknown', { analystPresenterOnly: [], plannerOnly: [] })).toThrow('Unknown value-contract claim');
  });

  it.each(Object.entries(INVENTED_SHAPES))('%s rejects every missing, extra, renamed, re-nested, and wrong-type field', (claimKey, value) => {
    expect(() => serializeValueContractClaim(claimKey, value)).not.toThrow();
    for (const path of objectFieldPaths(value)) {
      for (const mutation of ['remove', 'add', 'rename', 'renest', 'wrong-type']) {
        expect(() => serializeValueContractClaim(claimKey, mutateShape(value, path, mutation))).toThrow();
      }
    }
  });

  it('distinguishes ordered arrays from mathematical sets in invented values', () => {
    const vocabulary = { members: ['z', 'a'] };
    expect(serializeValueContractClaim('vocabulary.logged-event-kind', vocabulary))
      .toBe(serializeValueContractClaim('vocabulary.logged-event-kind', { members: [...vocabulary.members].reverse() }));
    const tools = INVENTED_SHAPES['tools.shipped-role-inventories'];
    expect(serializeValueContractClaim('tools.shipped-role-inventories', tools))
      .toBe(serializeValueContractClaim('tools.shipped-role-inventories', { ...tools, agents: [...tools.agents].reverse(), templates: [...tools.templates].reverse() }));
    expect(serializeValueContractClaim('tools.shipped-role-inventories', tools))
      .not.toBe(serializeValueContractClaim('tools.shipped-role-inventories', { ...tools, agents: [{ ...tools.agents[0], tools: [...tools.agents[0].tools].reverse() }, tools.agents[1]] }));
    const error = INVENTED_SHAPES['error.unexpected-internal'];
    expect(serializeValueContractClaim('error.unexpected-internal', error))
      .toBe(serializeValueContractClaim('error.unexpected-internal', { ...error, variants: [...error.variants].reverse() }));
    expect(() => serializeValueContractClaim('error.unexpected-internal', { ...error, variants: [error.variants[0], error.variants[0]] })).toThrow('duplicates');
    for (const [claimKey, field] of [['identity.card', 'alternatives'], ['identity.conversation-session', 'captures'], ['pivot.cards-diff-to', 'variants'], ['pivot.ui-cards-diff-current-request', 'key']]) {
      const value = INVENTED_SHAPES[claimKey];
      expect(serializeValueContractClaim(claimKey, value)).not.toBe(serializeValueContractClaim(claimKey, { ...value, [field]: [...value[field]].reverse() }));
    }
  });

  it('detects every independently mapped source field and live edge', () => {
    withProject((root) => {
      for (const [label, verify, path, fragment, occurrence] of SOURCE_MUTATIONS) {
        const target = join(root, path);
        const source = readFileSync(target, 'utf8');
        if (typeof occurrence !== 'number') replaceAllChecked(root, path, fragment, detached(fragment));
        else {
          let seen = -1;
          writeFileSync(target, source.replaceAll(fragment, (match) => { seen += 1; return seen === occurrence ? detached(match) : match; }));
          expect(seen).toBeGreaterThanOrEqual(occurrence);
        }
        const result = verify({ projectRoot: root });
        writeFileSync(target, source);
        if (result.ok) throw new Error(`Source mutation was not detected: ${label}`);
      }
    });
  });

  it('detects every named constant declaration and direct use', () => {
    withProject((root) => {
      for (const [label, path, token, occurrence] of CONSTANT_OCCURRENCE_MUTATIONS) {
        const target = join(root, path);
        const source = readFileSync(target, 'utf8');
        replaceOccurrence(root, path, token, occurrence);
        const result = verifySourceConstantDocs({ projectRoot: root });
        writeFileSync(target, source);
        if (result.ok) throw new Error(`Constant mutation was not detected: ${label}`);
      }
    });
  });

  it('rejects a same-policy TERM override at every default-consuming caller', () => {
    withProject((root) => {
      for (const [label, path, call, occurrence] of TERM_DEFAULT_CALL_MUTATIONS) {
        const target = join(root, path);
        const source = readFileSync(target, 'utf8');
        let seen = -1;
        writeFileSync(target, source.replaceAll(call, (match) => { seen += 1; return seen === occurrence ? `${match} graceMs: 5_000,` : match; }));
        expect(seen).toBeGreaterThanOrEqual(occurrence);
        const result = verifySourceConstantDocs({ projectRoot: root });
        writeFileSync(target, source);
        if (result.ok) throw new Error(`TERM override was not detected: ${label}`);
      }
    });
  });

  it('detects detachment of the unchanged MCP server default consumer', () => {
    withProject((root) => {
      replaceChecked(root, 'src/mcp/server-runtime.ts', 'closeAndTerminateDirectScope({', 'closeAndTerminateDirectScope({ graceMs: 5_000,');
      expect(verifySourceConstantDocs({ projectRoot: root }).ok).toBe(false);
    });
  });

  it('applies exactly the fourteen focused before/after cutovers and preserves the reviewed clauses', () => {
    expect(CUTOVERS).toHaveLength(14);
    expect(new Set(CUTOVERS.map((cutover) => cutover.id)).size).toBe(14);
    for (const cutover of CUTOVERS) {
      expect(cutover.before).toHaveLength(cutover.after.length);
      let local = cutover.before.join('\nfixture-separator\n');
      cutover.before.forEach((before, index) => { local = local.replace(before, cutover.after[index]); });
      cutover.before.forEach((before) => expect(local).not.toContain(before));
      cutover.after.forEach((after) => expect(local.split(after)).toHaveLength(2));

      const current = readFileSync(join(process.cwd(), cutover.file), 'utf8');
      cutover.before.forEach((before) => expect(current).not.toContain(before));
      cutover.after.forEach((after) => expect(current.split(after)).toHaveLength(2));
    }

    const system = readFileSync(join(process.cwd(), 'docs/spec/system-specification.md'), 'utf8');
    const architecture = readFileSync(join(process.cwd(), 'docs/architecture/system-architecture.md'), 'utf8');
    const runbook = readFileSync(join(process.cwd(), 'docs/runbook/index.md'), 'utf8');
    expect(system).toContain('one parent append adding the child to both `child_membership` and `active_child_order`');
    expect(architecture).toContain('`src/contracts/historical-version-not-found.ts` is the singular schema authority');
    expect(architecture).not.toContain("Card history entry not found");
    expect(runbook).toContain('For explicit event inspection, use the authenticated `/api/events` query or the Analyst `read_runtime_events` tool.');
    expect(runbook).toContain('Debug has no Timeline.');
    for (const responseClaim of ['numeric response `to`', 'numeric response `to` is evidence', 'response `to` records']) {
      expect(`${system}\n${architecture}\n${readFileSync(join(process.cwd(), 'docs/spec/operator-ui.md'), 'utf8')}`).not.toContain(responseClaim);
    }
  });

  it.each(families)('%s verification, aggregate reporting, and direct CLI fail on a drifted row', (_family, verify, claimKey) => {
    withProject((root) => {
      driftClaimRow(root, claimKey);
      const familyResult = verify({ projectRoot: root });
      expect(familyResult.ok).toBe(false);
      expect(familyResult.failures).toContainEqual(expect.objectContaining({ type: 'value-contract-block' }));

      const aggregate = verifyDocSourceContracts({ projectRoot: root });
      expect(aggregate.ok).toBe(false);
      expect(formatVerificationResult(aggregate, root)).toContain(claimKey);

      const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
      expect(cli.status).not.toBe(0);
      expect(cli.stdout).toContain(claimKey);
    });
  });

  it('allows block movement within its semantic heading and rejects cross-heading movement', () => {
    withProject((root) => {
      const file = 'docs/spec/system-specification.md';
      const source = readFileSync(join(root, file), 'utf8');
      const start = '<!-- saivage:value-contract:emit-result-limit:start -->';
      const end = '<!-- saivage:value-contract:emit-result-limit:end -->';
      const block = source.slice(source.indexOf(start), source.indexOf(end) + end.length);
      const without = source.replace(`${block}\n`, '');
      const anchor = '### Exact terminal-result limit\n';
      writeFileSync(join(root, file), without.replace(anchor, `${anchor}\nMoved within the semantic section.\n\n${block}\n`));
      expect(verifySourceConstantDocs({ projectRoot: root }).ok).toBe(true);

      replaceChecked(root, file, `${block}\n`, '');
      replaceChecked(root, file, '## 4. Full-Chain Stopped Recovery', `${block}\n\n## 4. Full-Chain Stopped Recovery`);
      expect(verifySourceConstantDocs({ projectRoot: root }).failures)
        .toContainEqual(expect.objectContaining({ type: 'value-contract-block', message: expect.stringContaining('outside') }));
    });
  });

  it('rejects a canonical block moved to a different manifest file', () => {
    withProject((root) => {
      const sourceFile = join(root, 'docs/spec/system-specification.md');
      const targetFile = join(root, 'docs/spec/operator-ui.md');
      const source = readFileSync(sourceFile, 'utf8');
      const start = '<!-- saivage:value-contract:emit-result-limit:start -->';
      const end = '<!-- saivage:value-contract:emit-result-limit:end -->';
      const block = source.slice(source.indexOf(start), source.indexOf(end) + end.length);
      writeFileSync(sourceFile, source.replace(`${block}\n`, ''));
      writeFileSync(targetFile, `${readFileSync(targetFile, 'utf8')}\n${block}\n`);
      expect(verifySourceConstantDocs({ projectRoot: root }).ok).toBe(false);
    });
  });

  it('fails the Analyst-busy claim when WebSocket schema membership alone is detached', () => {
    withProject((root) => {
      replaceChecked(
        root,
        'src/contracts/operator-events.ts',
        '  AnalystTurnBusyErrorSchema,\n  AnalystProcessingFailedErrorSchema,',
        '  AnalystProcessingFailedErrorSchema,\n  AnalystProcessingFailedErrorSchema,',
      );
      const result = verifyErrorShapeDocs({ projectRoot: root });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.objectContaining({
        claim: 'error.analyst-turn-busy',
        message: expect.stringContaining('must directly contain AnalystTurnBusyErrorSchema'),
      }));
    });
  });

  it.each([
    ['errors', verifyErrorShapeDocs, 'src/contracts/operator-api-core.ts', "z.literal('Unauthorized')", "z.literal('FixtureUnauthorized')"],
    ['vocabularies', verifyClosedVocabularyDocs, 'src/schemas/types.ts', "'backlog',", "'fixture_backlog',"],
    ['constants', verifySourceConstantDocs, 'src/runtime/card-process/card-process-config.ts', 'EMIT_RESULT_SUMMARY_MAX_CHARS = 2000', 'EMIT_RESULT_SUMMARY_MAX_CHARS = 2001'],
    ['tools', verifyToolContractDocs, 'src/config/system-templates/classic-typed/template.ts', "'read', 'write', 'edit'", "'fixture_read', 'write', 'edit'"],
    ['identities', verifyIdentityGrammarDocs, 'src/schemas/conversation-session-id.ts', '^agent:', '^fixture-agent:'],
    ['pivots', verifyCardDiffPivotDocs, 'web/src/api/client.ts', 'from: String(key.fromSeq)', 'from: String(key.fromSeq + 1)'],
  ])('%s family detects a representative source mutation', (_family, verify, path, before, after) => {
    withProject((root) => {
      replaceChecked(root, path, before, after);
      expect(verify({ projectRoot: root }).ok).toBe(false);
    });
  });

  it('rejects malformed, duplicated, unknown, and cross-heading block markers', () => {
    for (const mutate of [
      (root) => replaceChecked(root, 'docs/spec/system-specification.md', '```text\nidentity.card =', '```json\nidentity.card ='),
      (root) => replaceChecked(root, 'docs/spec/system-specification.md', '<!-- saivage:value-contract:card-identity:end -->', '<!-- saivage:value-contract:card-identity:end -->\n<!-- saivage:value-contract:card-identity:end -->'),
      (root) => replaceChecked(root, 'README.md', '# Saivage v3', '# Saivage v3\n<!-- saivage:value-contract:invented:start -->'),
    ]) {
      withProject((root) => {
        mutate(root);
        expect(verifyIdentityGrammarDocs({ projectRoot: root }).ok).toBe(false);
      });
    }
  });

  it.each(['README.md', 'docs/spec/system-specification.md', 'docs/spec/operator-ui.md', 'docs/architecture/system-architecture.md'])('rejects an unknown marker in %s', (file) => {
    withProject((root) => {
      const target = join(root, file);
      writeFileSync(target, `${readFileSync(target, 'utf8')}\n<!-- saivage:value-contract:invented:start -->\n`);
      expect(verifyIdentityGrammarDocs({ projectRoot: root }).failures).toContainEqual(expect.objectContaining({ type: 'value-contract-marker' }));
    });
  });
});
