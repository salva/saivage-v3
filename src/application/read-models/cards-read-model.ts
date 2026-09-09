import { basename } from 'node:path';
import type { CardService } from '../../cards/card-api.js';
import { positiveSafeIntegerSchema, type CardLifecycleState, type CardRecord } from '../../schemas/index.js';
import { allowedOperatorCardActions } from '../../permissions/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import type {
  OperatorApiHandlerResult,
  OperatorApiQuery,
  OperatorApiResponse,
  ServerAvailability,
} from '../../contracts/index.js';
import {
  CardDetailSchema,
  CardChildrenResponseSchema,
  CardDetailResponseSchema,
  CardDiffResponseSchema,
  CardHistoryEntryResponseSchema,
  CardHistoryListResponseSchema,
  CardRecordContentResponseSchema,
  CardRecordListResponseSchema,
} from '../../contracts/index.js';
import type { CanonicalReadInstrumentation } from '../../persistence/growing-file.js';
import { redactTextForOutbound } from '../../redaction/text.js';
import { projectCardRecordForOutbound } from './card-outbound.js';

function projectLifecycle(lifecycle: CardLifecycleState): CardLifecycleState {
  switch (lifecycle.status) {
    case 'done': return { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) } };
    case 'failed': return { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) }, error: redactTextForOutbound(lifecycle.error) };
    case 'blocked': return lifecycle.result.kind === 'content-policy-refusal'
      ? { ...lifecycle, result: { ...lifecycle.result }, error: redactTextForOutbound(lifecycle.error) }
      : { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) }, error: redactTextForOutbound(lifecycle.error) };
    default: return { ...lifecycle };
  }
}

function detail(card: CardRecord) {
  return CardDetailSchema.parse({ id: card.id, title: redactTextForOutbound(card.title), type: card.type, lifecycle: projectLifecycle(card.lifecycle), version_seq: card.version_seq, urgency: card.urgency, created_at: card.created_at, updated_at: card.updated_at, allowedActions: allowedOperatorCardActions(card.lifecycle.status) });
}

function invalidNumberBody(path: 'version' | 'from' | 'to'): OperatorApiResponse<'cards.history.get', 400> {
  const subject = path === 'version' ? 'History version' : `Diff ${path} pivot`;
  const message = `${subject} must be a positive safe integer`;
  return {
    error: 'ValidationError',
    message,
    issues: [{ path, message }],
  };
}

export class CardsReadModelService {
  constructor(private readonly projectRoot: string, private readonly store: CardService, private readonly runtime: Pick<RuntimeApi, 'getRuntimeState'>) {}

  getRuntimeState(serverAvailability: ServerAvailability): OperatorApiHandlerResult<'runtime.getState'> {
    const projectId = basename(this.projectRoot);
    const state = this.runtime.getRuntimeState();
    return { body: { projectId, runtime: state, serverAvailability } };
  }

  getChildren(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.children'> {
    const result = this.store.getCardChildren(id, instrumentation);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.value.parent.id !== id) throw new Error(`Hierarchy parent '${result.value.parent.id}' does not match requested card '${id}'.`);
    const hierarchy = (card: CardRecord) => {
      const workflow = this.store.workflows.cardTypes.get(card.type);
      if (!workflow) throw new Error(`No compiled workflow for card type '${card.type}'.`);
      return { id: card.id, title: redactTextForOutbound(card.title), type: card.type, status: card.lifecycle.status, permitted_child_types: [...workflow.permittedChildTypes] };
    };
    return { body: CardChildrenResponseSchema.parse({ parent: hierarchy(result.value.parent), children: result.value.activeChildren.map(hierarchy) }) };
  }

  getCard(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.get'> {
    const result = this.store.getCardDetail(id, instrumentation);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    return { body: CardDetailResponseSchema.parse({ card: detail(result.value) }) };
  }

  listRecords(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.records.list'> {
    const result=this.store.listDeclaredRecordMetadata(id,instrumentation);if(result.kind==='card-not-found')return{statusCode:404,body:{error:'Card not found',cardId:id}};
    const records = result.value.definitions.map(({definition:{filename,format,schema,bootstrap},classification}) => {
      const entry = classification.kind==='present'?classification.projection.artifact:undefined;
      return { name: filename, format, schema: redactTextForOutbound(schema), bootstrap, current: entry ? { head_version: entry.version, head_entry_id: entry.entry_id, state: entry.state, accepted_source_version: entry.accepted?.source_version ?? null, draft_present: entry.draft !== null } : null };
    });
    return { body: CardRecordListResponseSchema.parse({ card_id: id, records }) };
  }

  getRecord(id: string, name: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.records.get'> {
    {
      const result=this.store.readRecordCurrent(id,name,instrumentation);if(result.kind==='card-not-found')return{statusCode:404,body:{error:'Card not found',cardId:id}};const projection=result.value.projection;
      if(!projection)return { statusCode: 404, body: { error: 'Card record not found', cardId: id, name } };
      return { body: CardRecordContentResponseSchema.parse({ card_id: id, record: projectRecord(projection) }) };
    }
  }

  listRecordHistory(id: string, name: string): OperatorApiHandlerResult<'cards.records.history.list'> {
    const result=this.store.readRecordHistory(id,name);if(result.kind==='card-not-found')return{statusCode:404,body:{error:'Card not found',cardId:id}};const versions = result.value.catalog.versions.map((entry) => ({ entry_id: entry.entry_id, version: entry.version, published_at: entry.published_at, state: entry.state, accepted_source_version: entry.accepted?.source_version ?? null, draft_present: entry.draft !== null, discarded_at: entry.discarded?.discarded_at ?? null }));
    return { body: { card_id: id, name, versions, total: versions.length } };
  }

  getRecordVersion(id: string, name: string, version: number): OperatorApiHandlerResult<'cards.records.versions.get'> {
    const result=this.store.readRecordVersion(id,name,version);if(result.kind==='card-not-found')return{statusCode:404,body:{error:'Card not found',cardId:id}};if(result.kind==='version-not-found')return{statusCode:404,body:{error:'historical_version_not_found',resource:'authored_record',owner_id:`${id}/${name}`,version}};const projection=result.value.projection;return { body: { card_id: id, name, version, entry_id: projection.artifact.entry_id, published_at: projection.artifact.published_at, artifact: projectRecordArtifact(projection.artifact) } };
  }

  diffRecord(id: string, name: string, query: OperatorApiQuery<'cards.records.diff'>): OperatorApiHandlerResult<'cards.records.diff'> {
    const result=this.store.diffRecordVersions(id,name,{from:query.from,to:query.to});if(result.kind==='card-not-found')return{statusCode:404,body:{error:'Card not found',cardId:id}};if(result.kind==='invalid-pivots')return { statusCode: 400, body: { error: 'ValidationError', message: 'Diff from pivot must not exceed to pivot', issues: [{ path: 'from', message: 'Diff from pivot must not exceed to pivot' }] } };if(result.kind==='version-not-found')return{statusCode:404,body:{error:'historical_version_not_found',resource:'authored_record',owner_id:`${id}/${name}`,version:result.version}};const to=result.value.to.headVersion;
    const view = query.view ?? 'effective';const before = recordView(projectRecordArtifact(result.value.from.artifact), view); if (before === null) return { statusCode: 400, body: { error: 'record_diff_view_unavailable', card_id: id, name, side: 'from', view } }; const after = recordView(projectRecordArtifact(result.value.to.artifact), view); if (after === null) return { statusCode: 400, body: { error: 'record_diff_view_unavailable', card_id: id, name, side: 'to', view } };
    const hunks = before === after ? [] : [{ old_start: 0, old_lines: before.split('\n').length, new_start: 0, new_lines: after.split('\n').length, lines: [...before.split('\n').map((line) => `-${line}`), ...after.split('\n').map((line) => `+${line}`)] }];
    return { body: { card_id: id, name, from: query.from, to, view, hunks } };
  }

  listHistory(id: string): OperatorApiHandlerResult<'cards.history.list'> {
    const result = this.store.listCardVersions(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const versions = result.value.map((entry) => ({ entry_id: entry.entry_id, version: entry.version, published_at: entry.committed_at, artifact_kind: entry.artifact_kind }));
    return { body: CardHistoryListResponseSchema.parse({ card_id: id, versions, total: versions.length }) };
  }

  getHistoryEntry(id: string, version: number): OperatorApiHandlerResult<'cards.history.get'> {
    if (!positiveSafeIntegerSchema.safeParse(version).success) return { statusCode: 400, body: invalidNumberBody('version') };
    const result = this.store.readCardVersion(id, version);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'version-not-found') return { statusCode: 404, body: { error: 'historical_version_not_found', resource: 'card', owner_id: id, version } };
    const value = result.value; const artifact = value.kind === 'card-version' ? { kind: value.kind, card: projectCardRecordForOutbound(value.card) } : { kind: value.kind, final_card: projectCardRecordForOutbound(value.final_card) };
    return { body: CardHistoryEntryResponseSchema.parse({ card_id: id, version, entry_id: value.entry_id, published_at: value.committed_at, artifact }) };
  }

  diffCard(id: string, query: OperatorApiQuery<'cards.diff'>): OperatorApiHandlerResult<'cards.diff'> {
    for (const [path, pivot] of [['from', query.from], ['to', query.to]] as const) {
      if (pivot !== undefined && pivot !== 'current' && !positiveSafeIntegerSchema.safeParse(pivot).success) {
        return { statusCode: 400, body: invalidNumberBody(path) };
      }
    }
    const result = this.store.diffCardVersions(id, { fromVersion: query.from, toVersion: query.to });
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'invalid-pivots') return { statusCode: 400, body: { error: 'Invalid diff pivots', from: result.from, to: result.to } };
    if (result.kind === 'version-not-found') return { statusCode: 404, body: { error: 'historical_version_not_found', resource: 'card', owner_id: id, version: result.version } };
    const diff = redactForOutbound({ source: 'card-diff', value: result.diff });
    return { body: CardDiffResponseSchema.parse({ diff, from: result.from, to: result.to, card_id: id }) };
  }
}

function projectRecordArtifact(artifact: import('../../persistence/canonical-record-artifacts.js').AuthoredRecordVersionArtifact) { return { state: artifact.state, published_at: artifact.published_at, accepted: artifact.accepted ? { ...artifact.accepted, content: redactTextForOutbound(artifact.accepted.content) } : null, draft: artifact.draft ? { ...artifact.draft, content: redactTextForOutbound(artifact.draft.content) } : null, discarded: artifact.discarded ? { ...artifact.discarded, reason: redactTextForOutbound(artifact.discarded.reason) } : null }; }
function projectRecord(projection: import('../../persistence/authored-record-files.js').RecordProjection) { const artifact = projectRecordArtifact(projection.artifact); return { name: projection.filename, head_version: projection.headVersion, head_entry_id: projection.artifact.entry_id, state: projection.artifact.state, accepted: artifact.accepted, draft: artifact.draft, discarded: artifact.discarded, effective_content_source: projection.artifact.state === 'open' ? 'draft' as const : projection.artifact.accepted ? 'accepted' as const : null }; }
function recordView(artifact: ReturnType<typeof projectRecordArtifact>, view: 'effective' | 'accepted' | 'draft'): string | null { if (view === 'accepted') return artifact.accepted?.content ?? null; if (view === 'draft') return artifact.draft?.content ?? null; return artifact.state === 'open' ? artifact.draft?.content ?? null : artifact.accepted?.content ?? null; }
