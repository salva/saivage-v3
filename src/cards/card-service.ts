import { randomUUID } from 'node:crypto';

import {
  CARD_RECORD_FIELDS,
  cardRecordSchema,
  positiveSafeIntegerSchema,
  valuesEqual,
  type AgentName,
  type CardRecord,
  type CardStatus,
  parseRecordName,
} from '../schemas/index.js';
import {
  closeOpenAuthoredRecord,
  discardOpenAuthoredRecord,
  openAuthoredRecord,
  readCurrentAuthoredRecord,
  editOpenAuthoredRecord,
  classifyCurrentAuthoredRecord,
  projectAuthoredRecordArtifact,
  AuthoredRecordNotFoundError,
  listAuthoredRecordVersions,
  type CurrentAuthoredRecordClassification,
  type RecordProjection,
} from '../persistence/authored-record-files.js';
import type { RecordDefinition } from '../records/record-definition.js';
import { effectiveRecordContent } from '../persistence/canonical-record-artifacts.js';
import { genericRecordDefinition,type CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import {
  listActiveCardTraversal,
  publishCardTombstone,
  publishCardVersion,
  publishInitialChildCard,
  readCard,
  readCanonicalCard,
  readCanonicalCardHierarchy,
  readCardDetail,
  readCardHierarchy,
  readCommittedCardArtifactCatalog,
  readActiveCardPath,
  readActiveCardSubtree,
  cardDiffValue,
  readLinkedChildren,
  readLinkedChildrenProjection,
  type CardTargetRead,
  type CanonicalCardProjection,
  type CanonicalLinkedChildrenProjection,
  type CanonicalCardFileSlot,
} from '../persistence/card-files.js';
import { cardVersionChangeSchema, type CardArtifact, type CardVersionChange, type CardVersionListEntry } from '../persistence/canonical-card-artifacts.js';
import type { CanonicalReadInstrumentation, GrowingFileIo } from '../persistence/growing-file.js';
import { NO_FRESHNESS_EFFECTS, type FreshnessEffects } from '../application/freshness-effects.js';
import type { LiveSyncCardRecordName } from '../contracts/index.js';
import { CardIndex } from './card-index.js';
import {
  assertSetStatusAdmission,
  buildSetStatusLifecycle,
  buildActivatedStoppedLifecycle,
  buildStoppedLifecycle,
  buildEditedCard,
  collectEditChangedFields,
  enqueueCardNotification,
  pruneCardEditPatch,
  removeCardNotifications,
  summarizeChangedFields,
  type CardEditPatch,
  type NewChildCardInput,
  type SetStatusTarget,
} from './lifecycle.js';
import { canCreateChildInStatus } from './card-status.js';
import type { CardNotification } from '../schemas/types.js';
import { CardServiceInvariantError } from './errors.js';
import { cardDepth, cardParentId, MAX_CARD_DEPTH } from '../schemas/card-id.js';
import type { CardActivationOutcome } from '../contracts/tool-api.js';

type CardActivationAdmissionProjection = {
  child: CardRecord;
  dependencies: Array<{ id: string; status: CardStatus }>;
};

export interface CardDiffEntry { field: string; before: unknown; after: unknown }
type CardVersionListResult = CardTargetRead<readonly CardVersionListEntry[]>;
export type { CanonicalCardFileSlot };
type CardVersionContentResult = CardTargetRead<CardArtifact>|{readonly kind:'version-not-found';readonly version:number};
type CardVersionDiffResult =
  | { readonly kind: 'found'; readonly from: number; readonly to: number; readonly fromArtifact:CardArtifact;readonly toArtifact:CardArtifact;readonly diff: CardDiffEntry[] }
  | { readonly kind: 'card-not-found' }
  | { readonly kind: 'invalid-pivots'; readonly from: number; readonly to: number }
  | { readonly kind: 'version-not-found'; readonly version: number; readonly side: 'from' | 'to' };

type TerminalActivationOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' | 'stopped' }>;
type TerminalPublication = {
  lifecycle: Extract<CardRecord['lifecycle'], { status: 'done' | 'failed' | 'blocked' }>;
  status_text: string | null;
  status_text_updated_at: string | null;
};

function clone<T>(value: T): T { return structuredClone(value); }

function diffArtifacts(from: CardArtifact, to: CardArtifact): CardDiffEntry[] {
  const before = cardDiffValue(from); const after = cardDiffValue(to);
  const lifecyclePosition = CARD_RECORD_FIELDS.indexOf('title') + 1;
  const cardFields: readonly (keyof CardRecord)[] = [
    ...CARD_RECORD_FIELDS.slice(0, lifecyclePosition),
    'lifecycle',
    ...CARD_RECORD_FIELDS.slice(lifecyclePosition).filter((field) => field !== 'lifecycle'),
  ];
  const fields: readonly ('deleted' | keyof CardRecord)[] = ['deleted', ...cardFields];
  return fields.flatMap((field) => {
    const left = field === 'deleted' ? before.deleted : before.card[field]; const right = field === 'deleted' ? after.deleted : after.card[field];
    return valuesEqual(left, right) ? [] : [{ field, before: left, after: right }];
  });
}

function versionChange(prior: CardRecord, next: CardRecord | null, kind: CardVersionChange['kind'], fields: string[], summary: string, reason: string,agentName?:AgentName): CardVersionChange {
  const provenance = kind === 'update' ? { changed_by_actor: agentName!, changed_by_surface: 'runtime' }
    : kind === 'delete' ? { changed_by_actor: agentName!, changed_by_surface: 'runtime' }
      : { changed_by_actor: 'runtime', changed_by_surface: 'runtime' };
  const changedAt = kind === 'terminal' ? next?.status_text_updated_at : new Date().toISOString();
  if (!changedAt) throw new Error('Terminal card change requires status_text_updated_at.');
  const terminalSummary = kind === 'terminal' ? (() => {
    if (!next || (next.lifecycle.status !== 'done' && next.lifecycle.status !== 'failed' && next.lifecycle.status !== 'blocked')) throw new Error('Terminal card change requires terminal lifecycle.');
    const result = next.lifecycle.result;
    return { status: next.lifecycle.status, result_kind: result.kind, summary: result.summary, content_policy: result.kind === 'content-policy-refusal' ? { session_id: result.session_id, marker_id: result.marker_id, evidence_url: result.evidence_url, blocked_at: changedAt } : null };
  })() : null;
  return cardVersionChangeSchema.parse({ entry_id: randomUUID(), kind, card_id: prior.id, resulting_version: kind === 'delete' ? prior.version_seq + 1 : next!.version_seq, changed_at: changedAt, ...provenance, change_reason: reason, changed_fields: fields, change_summary: summary, terminal_summary: terminalSummary });
}

function admitChildParent(parent:CardRecord,message:string,workflows:CompiledProjectWorkflows){const workflow=workflows.cardTypes.get(parent.type);if(!workflow)throw new Error(`No compiled workflow exists for card type '${parent.type}'.`);if(workflow.permittedChildTypes.size===0||!canCreateChildInStatus(parent.lifecycle.status))throw new Error(`${message} '${parent.id}'.`);return workflow;}
function assertPermittedChildType(parent:CardRecord,childType:string,message:string,workflow:ReturnType<typeof admitChildParent>):void{
  if(!workflow.permittedChildTypes.has(childType))throw new Error(`${message} '${parent.id}'.`);
}

type CardRecordCurrentResult=CardTargetRead<{readonly card:CardRecord;readonly definition:RecordDefinition;readonly projection:RecordProjection|null}>;
type CardRecordHistoryResult=CardTargetRead<{readonly card:CardRecord;readonly definition:RecordDefinition;readonly catalog:ReturnType<typeof listAuthoredRecordVersions>}>;
type CardRecordVersionResult=CardTargetRead<{readonly card:CardRecord;readonly definition:RecordDefinition;readonly projection:RecordProjection}>|{readonly kind:'version-not-found';readonly version:number};
type CardRecordDiffSelectionResult=CardTargetRead<{readonly card:CardRecord;readonly definition:RecordDefinition;readonly from:RecordProjection;readonly to:RecordProjection}>|{readonly kind:'invalid-pivots';readonly from:number;readonly to:number}|{readonly kind:'version-not-found';readonly version:number;readonly side:'from'|'to'};
export type CardDeclaredRecordMetadataResult=CardTargetRead<{readonly card:CardRecord;readonly definitions:readonly {readonly definition:RecordDefinition;readonly classification:CurrentAuthoredRecordClassification}[]}>;
interface CanonicalCardFilesMetadataProjection{readonly card:CanonicalCardProjection;readonly active:boolean;readonly recordFiles:readonly {readonly slot:import('../schemas/index.js').RecordName;readonly size:number;readonly modifiedAt:string}[]}
interface CardInspectionListRow{readonly card:CardRecord;readonly parentId:string|null;readonly activeChildrenCount:number}
interface CardInspectionTreeRow extends CardInspectionListRow{readonly relativeDepth:number;readonly activeDescendantCount:number}

export class CardService {
  constructor(readonly projectRoot: string, readonly workflows: CompiledProjectWorkflows, private readonly freshness: Pick<FreshnessEffects, 'cardProjectionChanged' | 'runtimeChanged' | 'agentMembershipChanged'> = NO_FRESHNESS_EFFECTS, private readonly cardAppendIo?: GrowingFileIo) {}

  private recordDefinitionFor(card:CardRecord,filename:string):RecordDefinition {
    const name=parseRecordName(filename);const workflow=this.workflows.cardTypes.get(card.type);if(!workflow)throw new Error(`No compiled workflow exists for card type '${card.type}'.`);const definition = workflow.records.get(name)??genericRecordDefinition(name);
    return { filename: definition.name, format: definition.format, schema: definition.schema, bootstrap: definition.bootstrap,declared:definition.declared };
  }
  private recordDefinitionsFor(card:CardRecord):RecordDefinition[]{const workflow=this.workflows.cardTypes.get(card.type);if(!workflow)throw new Error(`No workflow for '${card.type}'.`);return [...workflow.records.values()].map((definition)=>({filename:definition.name,format:definition.format,schema:definition.schema,bootstrap:definition.bootstrap,declared:true}));}
  private admittedRecord(cardId:string,filename:string,instrumentation?:CanonicalReadInstrumentation){const reached=readActiveCardPath(this.projectRoot,cardId,instrumentation);if(!reached)return null;const card=reached.fold.current.card;return{card,definition:this.recordDefinitionFor(card,filename)};}

  private buildFullIndex(): CardIndex {
    const state = new CardIndex();
    for (const {card} of [...listActiveCardTraversal(this.projectRoot)].sort((left, right) => cardDepth(left.card.id) - cardDepth(right.card.id))) state.upsert(card);
    return state;
  }

  private publishCardVersionEffects(change: CardVersionChange, parentId: string | null, runtimeChanged: boolean, recordNames: readonly LiveSyncCardRecordName[] = []): void {
    const cardId = change.card_id;
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'history', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'diff', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: cardId });
    if (parentId) this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: parentId });
    for (const record_name of recordNames) this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, record_name });
    if (runtimeChanged) this.freshness.runtimeChanged();
  }

  readActivationAdmission(cardId: string): CardActivationAdmissionProjection | null {
    const child = this.read(cardId);
    if (!child) return null;
    const dependencies = child.depends_on.map((id) => {
      const dependency = this.read(id);
      if (!dependency) throw new CardServiceInvariantError(`Card '${child.id}' depends_on missing card '${id}'.`);
      return { id, status: dependency.lifecycle.status };
    });
    return clone({ child, dependencies });
  }

  read(id: string): CardRecord | null { const card = readCard(this.projectRoot, id); return card ? clone(card) : null; }
  list(): CardRecord[] { return clone(this.buildFullIndex().list()); }
  listChildren(parentId: string): string[] { return readLinkedChildren(this.projectRoot, parentId).map((card) => card.id); }
  getParent(id: string): string | null { return readCanonicalCard(this.projectRoot, id).kind === 'found' ? cardParentId(id) : null; }
  getAncestors(id: string): string[] { if (readCanonicalCard(this.projectRoot, id).kind === 'card-not-found') return []; const out: string[] = []; let parent = cardParentId(id); while (parent) { out.unshift(parent); parent = cardParentId(parent); } return out; }
  getDescendantIds(id: string): string[] {const result=readActiveCardSubtree(this.projectRoot,id);return result.kind==='card-not-found'?[]:result.value.slice(1).map(({card})=>card.id);}
  readRecordCurrent(cardId:string,filename:string,instrumentation?:CanonicalReadInstrumentation):CardRecordCurrentResult{const admitted=this.admittedRecord(cardId,filename,instrumentation);if(!admitted)return{kind:'card-not-found'};const projection=readCurrentAuthoredRecord(this.projectRoot,admitted.card,admitted.definition,instrumentation);if(!projection&&admitted.definition.bootstrap)throw new Error(`Card '${cardId}' required bootstrap record '${filename}' is unavailable.`);return{kind:'found',value:{...admitted,projection}};}
  readRecordHistory(cardId:string,filename:string,instrumentation?:CanonicalReadInstrumentation):CardRecordHistoryResult{const admitted=this.admittedRecord(cardId,filename,instrumentation);if(!admitted)return{kind:'card-not-found'};const catalog=listAuthoredRecordVersions(this.projectRoot,admitted.card,admitted.definition,instrumentation);if(catalog.versions.length===0&&admitted.definition.bootstrap)throw new Error(`Card '${cardId}' required bootstrap record '${filename}' is unavailable.`);return{kind:'found',value:{...admitted,catalog}};}
  readRecordVersion(cardId:string,filename:string,version:number,instrumentation?:CanonicalReadInstrumentation):CardRecordVersionResult{positiveSafeIntegerSchema.parse(version);const history=this.readRecordHistory(cardId,filename,instrumentation);if(history.kind==='card-not-found')return history;const row=history.value.catalog.versions[version-1];if(!row||row.version!==version)return{kind:'version-not-found',version};return{kind:'found',value:{card:history.value.card,definition:history.value.definition,projection:projectAuthoredRecordArtifact(history.value.definition,row)}};}
  diffRecordVersions(cardId:string,filename:string,pivots:{from:number;to?:number|'current'},instrumentation?:CanonicalReadInstrumentation):CardRecordDiffSelectionResult{positiveSafeIntegerSchema.parse(pivots.from);if(typeof pivots.to==='number')positiveSafeIntegerSchema.parse(pivots.to);const history=this.readRecordHistory(cardId,filename,instrumentation);if(history.kind==='card-not-found')return history;const to=typeof pivots.to==='number'?pivots.to:history.value.catalog.versions.at(-1)?.version??0;if(pivots.from>to)return{kind:'invalid-pivots',from:pivots.from,to};const select=(version:number,side:'from'|'to')=>{const artifact=history.value.catalog.versions[version-1];return !artifact||artifact.version!==version?{kind:'version-not-found' as const,version,side}:projectAuthoredRecordArtifact(history.value.definition,artifact);};const from=select(pivots.from,'from');if('kind'in from)return from;const toProjection=select(to,'to');if('kind'in toProjection)return toProjection;return{kind:'found',value:{card:history.value.card,definition:history.value.definition,from,to:toProjection}};}
  listDeclaredRecordMetadata(cardId:string,instrumentation?:CanonicalReadInstrumentation):CardDeclaredRecordMetadataResult{const reached=readActiveCardPath(this.projectRoot,cardId,instrumentation);if(!reached)return{kind:'card-not-found'};const card=reached.fold.current.card;return{kind:'found',value:{card,definitions:this.recordDefinitionsFor(card).map((definition)=>{const classification=classifyCurrentAuthoredRecord(this.projectRoot,card,definition,instrumentation);if(classification.kind!=='present'&&definition.bootstrap)throw new Error(`Card '${cardId}' required bootstrap record '${definition.filename}' is unavailable.`);return{definition,classification};})}};}
  classifyCurrentRecord(card:CardRecord,filename:string,instrumentation?:CanonicalReadInstrumentation):CurrentAuthoredRecordClassification{return classifyCurrentAuthoredRecord(this.projectRoot,card,this.recordDefinitionFor(card,filename),instrumentation);}
  private admitWrite(cardId:string,filename:string){const admitted=this.admittedRecord(cardId,filename);if(!admitted)throw new AuthoredRecordNotFoundError();return admitted;}
  openRecord(cardId: string, filename: string): RecordProjection {const a=this.admitWrite(cardId,filename);return openAuthoredRecord(this.projectRoot,a.card,a.definition,this.cardAppendIo); }
  editRecord(cardId: string, filename: string, content: string): RecordProjection {const a=this.admitWrite(cardId,filename);return editOpenAuthoredRecord(this.projectRoot,a.card,a.definition,content,this.cardAppendIo); }
  closeRecord(cardId: string, filename: string, agentName: AgentName): RecordProjection {
    const a=this.admitWrite(cardId,filename);const closed = closeOpenAuthoredRecord(this.projectRoot,a.card,a.definition,agentName,this.cardAppendIo);
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, record_name: filename as never });
    return closed;
  }
  discardRecord(cardId: string, filename: string, reason: string): RecordProjection {const a=this.admitWrite(cardId,filename);return discardOpenAuthoredRecord(this.projectRoot,a.card,a.definition,reason,this.cardAppendIo); }

  getCardDetail(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> {
    return clone(readCardDetail(this.projectRoot, id, instrumentation));
  }
  getCanonicalCard(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardProjection> {
    return readCanonicalCard(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardChildren(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalLinkedChildrenProjection> {
    return readCanonicalCardHierarchy(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardFilesMetadata(id: string): CardTargetRead<CanonicalCardFilesMetadataProjection> {
    const catalog=readCommittedCardArtifactCatalog(this.projectRoot,id);if(catalog.kind==='card-not-found')return catalog;const head=catalog.value.head;const card=head.kind==='card-version'?head.card:head.final_card;if(head.kind==='card-tombstone')return{kind:'found',value:{card:{card,artifact:head},active:false,recordFiles:[]}};const definitions=this.recordDefinitionsFor(card);const recordFiles=definitions.flatMap((definition)=>{const classification=classifyCurrentAuthoredRecord(this.projectRoot,card,definition);if(classification.kind!=='present'){if(definition.bootstrap)throw new Error(`Card '${id}' required bootstrap record '${definition.filename}' is unavailable.`);return[];}const effective=effectiveRecordContent(classification.projection.artifact);return effective?[{slot:definition.filename,size:Buffer.byteLength(effective.content),modifiedAt:effective.modifiedAt}]:[];});return{kind:'found',value:{card:{card,artifact:head},active:true,recordFiles}};
  }
  getCardChildren(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<{ parent: CardRecord; activeChildren: CardRecord[] }> {
    return clone(readCardHierarchy(this.projectRoot, id, instrumentation));
  }
  listCardVersions(id: string, instrumentation?: CanonicalReadInstrumentation): CardVersionListResult {
    const catalog=readCommittedCardArtifactCatalog(this.projectRoot,id,instrumentation);return catalog.kind==='card-not-found'?catalog:{kind:'found',value:clone(catalog.value.versions)};
  }
  readCardVersion(id: string, version: number, instrumentation?: CanonicalReadInstrumentation): CardVersionContentResult {
    positiveSafeIntegerSchema.parse(version);
    const catalog = readCommittedCardArtifactCatalog(this.projectRoot, id, instrumentation);
    if (catalog.kind === 'card-not-found') return catalog;
    const row = catalog.value.rows[version - 1];
    return row && row.version === version
      ? { kind: 'found', value: clone(row) }
      : { kind: 'version-not-found', version };
  }
  diffCardVersions(id: string, pivots: { fromVersion: number; toVersion?: number | 'current' }, instrumentation?: CanonicalReadInstrumentation): CardVersionDiffResult {
    positiveSafeIntegerSchema.parse(pivots.fromVersion); if (pivots.toVersion !== undefined && pivots.toVersion !== 'current') positiveSafeIntegerSchema.parse(pivots.toVersion);
    const catalog = readCommittedCardArtifactCatalog(this.projectRoot, id, instrumentation); if (catalog.kind === 'card-not-found') return catalog;
    const to = typeof pivots.toVersion === 'number' ? pivots.toVersion : catalog.value.head.version; const from = pivots.fromVersion;
    if (from > to) return { kind: 'invalid-pivots', from, to };
    const select=(version:number,side:'from'|'to')=>{const row=catalog.value.rows[version-1];return row&&row.version===version?row:{kind:'version-not-found' as const,version,side};};const fromArtifact=select(from,'from');if('side'in fromArtifact)return fromArtifact;const toArtifact=pivots.toVersion===undefined||pivots.toVersion==='current'?catalog.value.head:select(to,'to');if('side'in toArtifact)return toArtifact;return { kind: 'found', from, to,fromArtifact:clone(fromArtifact),toArtifact:clone(toArtifact), diff: clone(diffArtifacts(fromArtifact,toArtifact)) };
  }
  readCommittedCardHead(id:string,instrumentation?:CanonicalReadInstrumentation):CardTargetRead<CardArtifact>{const catalog=readCommittedCardArtifactCatalog(this.projectRoot,id,instrumentation);return catalog.kind==='card-not-found'?catalog:{kind:'found',value:clone(catalog.value.head)};}
  listCardInspectionRows(instrumentation?:CanonicalReadInstrumentation):readonly CardInspectionListRow[]{return listActiveCardTraversal(this.projectRoot,instrumentation).map(({card,parentId,activeChildrenCount})=>clone({card,parentId,activeChildrenCount}));}
  readCardInspectionTree(rootId:string,maxDepth:number,instrumentation?:CanonicalReadInstrumentation):CardTargetRead<readonly CardInspectionTreeRow[]>{const result=readActiveCardSubtree(this.projectRoot,rootId,instrumentation);return result.kind==='card-not-found'?result:{kind:'found',value:result.value.filter(({relativeDepth})=>relativeDepth<=maxDepth).map((row)=>clone(row))};}

  create(input: NewChildCardInput): CardRecord {
    if(input.bootstrap_content.trim().length===0)throw new Error('Child bootstrap_content must contain non-whitespace Markdown.');
    if(input.title.length===0||!Number.isInteger(input.priority))throw new Error('Child title and priority are invalid.');
    const parent = this.read(input.parent);
    if (!parent) throw new Error(`Parent card '${input.parent}' does not exist.`);
    const depth = cardDepth(parent.id) + 1;
    if (depth > MAX_CARD_DEPTH) throw new Error(`Cannot create card at depth ${depth}. Maximum allowed depth is ${MAX_CARD_DEPTH}.`);
    const parentWorkflow=admitChildParent(parent,'Cannot create a child under',this.workflows);
    const childWorkflow=this.workflows.cardTypes.get(input.type);if(!childWorkflow)throw new Error(`No workflow for child type '${input.type}'.`);
    assertPermittedChildType(parent,input.type,'Cannot create a child under',parentWorkflow);
    if(depth===MAX_CARD_DEPTH&&childWorkflow.permittedChildTypes.size!==0)throw new Error(`Cannot create non-leaf child type '${input.type}' at maximum card depth ${MAX_CARD_DEPTH}.`);
    for (const dependencyId of input.depends_on) if (!this.read(dependencyId)) throw new Error(`Dependency card '${dependencyId}' does not exist.`);
    const parentBeforeClaim = this.read(parent.id);
    if (!parentBeforeClaim) throw new Error(`Parent '${parent.id}' changed before child namespace claim.`);
    assertPermittedChildType(parentBeforeClaim,input.type,'Cannot claim a child namespace under',admitChildParent(parentBeforeClaim,'Cannot claim a child namespace under',this.workflows));
    const card = publishInitialChildCard(this.projectRoot, input,childWorkflow);
    if (cardParentId(card.id) !== parentBeforeClaim.id || cardDepth(card.id) !== depth) throw new Error(`Claimed card '${card.id}' does not belong to requested parent '${parentBeforeClaim.id}'.`);
    const freshParent = this.read(parent.id);
    if (!freshParent || freshParent.child_membership.includes(card.id)) throw new Error(`Parent '${parent.id}' changed during child publication.`);
    assertPermittedChildType(freshParent,input.type,'Cannot link a child under',admitChildParent(freshParent,'Cannot link a child under',this.workflows));
    const linked = cardRecordSchema.parse({ ...freshParent, child_membership: [...freshParent.child_membership, card.id], active_child_order: [...freshParent.active_child_order, card.id], version_seq: freshParent.version_seq + 1, updated_at: new Date().toISOString() });
    const linkChange = versionChange(freshParent, linked, 'child_link', ['child_membership', 'active_child_order'], `linked child ${card.id}`, 'child linked');
    publishCardVersion(this.projectRoot, linked, linkChange, this.cardAppendIo);
    this.publishCardVersionEffects(linkChange, cardParentId(freshParent.id), true);
    this.freshness.agentMembershipChanged({ scope: 'card', cardId: card.id });
    return clone(card);
  }

  private publishVersion(existing: CardRecord, candidate: CardRecord, kind: CardVersionChange['kind'], fields: string[], reason: string, summary = summarizeChangedFields(fields),agentName?:AgentName): CardRecord {
    const parsed = cardRecordSchema.parse(candidate); const change = versionChange(existing, parsed, kind, fields, summary, reason,agentName);
    publishCardVersion(this.projectRoot, parsed, change, this.cardAppendIo);
    this.publishCardVersionEffects(change, cardParentId(existing.id), fields.includes('lifecycle'));
    return clone(candidate);
  }

  editCard(id: string, changes: CardEditPatch,agentName:AgentName): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    if (!['backlog', 'changed', 'stopped', 'blocked', 'failed'].includes(existing.lifecycle.status)) throw new Error(`Card '${id}' cannot be edited in status '${existing.lifecycle.status}'.`);
    const patch = pruneCardEditPatch(existing, changes);
    if (Object.keys(patch).length === 0) return existing;
    const updateBase = existing.lifecycle.status === 'blocked' || existing.lifecycle.status === 'failed'
      ? this.setStatus(id, 'changed')
      : existing;
    const candidate = buildEditedCard(updateBase, patch, new Date().toISOString());
    const fields = collectEditChangedFields(updateBase, candidate, patch);
    return this.publishVersion(updateBase, candidate, 'update', fields, 'agent edit_card',undefined,agentName);
  }

  setStatus(id: string, status: SetStatusTarget): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    assertSetStatusAdmission(existing, status);
    const notifications = status === 'cancelled' ? [] : existing.pending_notifications;
    const fields = ['lifecycle', ...(status === 'cancelled' && existing.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
    const candidate = { ...existing, lifecycle: buildSetStatusLifecycle(status), pending_notifications: notifications, updated_at: new Date().toISOString(), version_seq: existing.version_seq + 1 };
    return this.publishVersion(existing, candidate, 'status', fields, `status -> ${status}`);
  }
  stopRunning(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.lifecycle.status !== 'running') throw new Error(`Card '${id}' must be running before its lifecycle can be stopped.`);
    const candidate = { ...card, lifecycle: buildStoppedLifecycle(), updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 };
    return this.publishVersion(card, candidate, 'status', ['lifecycle'], 'recovery stopped lifecycle');
  }
  activateStopped(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.lifecycle.status !== 'stopped') throw new Error(`Card '${id}' must be stopped before it can be activated through STOPPED.`);
    const candidate = { ...card, lifecycle: buildActivatedStoppedLifecycle(), updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 };
    return this.publishVersion(card, candidate, 'status', ['lifecycle'], 'STOPPED activation');
  }
  enqueueNotification(id: string, notification: CardNotification): CardRecord {
    const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`);
    const next = enqueueCardNotification(card, notification);
    return this.publishVersion(card, { ...next, updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 }, 'notification_enqueue', ['pending_notifications'], 'notification enqueued', 'notification enqueued');
  }
  removeNotifications(id: string, notificationIds: readonly string[]): CardRecord {
    const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`);
    const next = removeCardNotifications(card, notificationIds);
    return this.publishVersion(card, { ...next, updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 }, 'notification_remove', ['pending_notifications'], 'notifications delivered', 'notifications delivered');
  }

  commitActivationOutcome(id: string, outcome: TerminalActivationOutcome, settledAt: string): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    if (existing.lifecycle.status !== 'running') throw new Error(`Card '${id}' must be running before terminal lifecycle commit.`);
    if (outcome.result.summary !== outcome.summary) throw new Error('Activation outcome summary must equal result summary.');
    const terminal: TerminalPublication = (() => {
      switch (outcome.status) {
        case 'done': return { lifecycle: { status: 'done', result: outcome.result, error: null, completed_at: settledAt }, status_text: outcome.summary, status_text_updated_at: settledAt };
        case 'failed': return { lifecycle: { status: 'failed', result: outcome.result, error: outcome.summary, completed_at: settledAt }, status_text: outcome.summary, status_text_updated_at: settledAt };
        case 'blocked': return { lifecycle: { status: 'blocked', result: outcome.result, error: outcome.summary, completed_at: null }, status_text: outcome.summary, status_text_updated_at: settledAt };
      }
    })();
    const fields = ['lifecycle', ...(!valuesEqual(existing.status_text, terminal.status_text) ? ['status_text'] : []), ...(!valuesEqual(existing.status_text_updated_at, terminal.status_text_updated_at) ? ['status_text_updated_at'] : []), ...(existing.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
    const candidate = { ...existing, ...terminal, pending_notifications: [], updated_at: new Date().toISOString(), version_seq: existing.version_seq + 1 };
    return this.publishVersion(existing, candidate, 'terminal', fields, 'terminal lifecycle commit');
  }

  reorderChildren(parentId: string, orderedChildIds: string[]): { ok: true; changed: number } | { ok: false; reason: string; missing: string[]; extra: string[] } {
    const { parent, activeChildren } = readLinkedChildrenProjection(this.projectRoot, parentId);
    const actual = activeChildren.map((card) => card.id);
    const actualSet = new Set(actual);
    const requestedSet = new Set(orderedChildIds);
    if (actual.length !== orderedChildIds.length || requestedSet.size !== orderedChildIds.length || actual.some((id) => !requestedSet.has(id))) {
      return { ok: false, reason: 'ordered child ids do not match current children', missing: actual.filter((id) => !requestedSet.has(id)), extra: orderedChildIds.filter((id) => !actualSet.has(id)) };
    }
    const retained = parent.active_child_order.filter((id) => !actualSet.has(id));
    const fullOrder = [...orderedChildIds, ...retained];
    const changed = orderedChildIds.reduce((count, id, index) => count + (actual[index] === id ? 0 : 1), 0);
    if (changed === 0) return { ok: true, changed: 0 };
    this.publishExactChildReorder(parent, fullOrder);
    return { ok: true, changed };
  }

  private publishExactChildReorder(parent: CardRecord, fullOrder: string[]): CardRecord {
    return this.publishVersion(parent, { ...parent, active_child_order: fullOrder, version_seq: parent.version_seq + 1, updated_at: new Date().toISOString() }, 'reorder', ['active_child_order'], 'children reordered', 'children reordered');
  }

  deleteSubtrees(requestedIds: readonly string[], allowed: (card: CardRecord) => boolean,agentName:AgentName): { deleted: string[]; requested: string[] } {
    if (requestedIds.length === 0) throw new Error('Deletion requires at least one card id.');
    const state = this.buildFullIndex(); const roots = [...new Set(requestedIds)]; const intended = new Set<string>();
    for (const id of roots) { const card = state.get(id); if (!card || id === 'project') throw new Error(`Card '${id}' cannot be deleted.`); intended.add(id); for (const child of state.descendantsOf(id)) intended.add(child); }
    for (const id of intended) if (!allowed(state.get(id)!)) throw new Error(`Deletion denied for card '${id}'.`);
    for (const survivor of state.list()) for (const dependency of survivor.depends_on) if (!intended.has(survivor.id) && intended.has(dependency)) throw new Error(`Surviving card '${survivor.id}' depends on deleted card '${dependency}'.`);
    const outgoing = new Map<string, Set<string>>([...intended].map((id) => [id, new Set()])); const indegree = new Map<string, number>([...intended].map((id) => [id, 0]));
    const edge = (from: string, to: string): void => { const set = outgoing.get(from)!; if (!set.has(to)) { set.add(to); indegree.set(to, indegree.get(to)! + 1); } };
    for (const id of intended) { const card = state.get(id)!; const parent = cardParentId(id); if (parent && intended.has(parent)) edge(id, parent); for (const dependency of card.depends_on) if (intended.has(dependency)) edge(id, dependency); }
    const ready = [...intended].filter((id) => indegree.get(id) === 0).sort(); const order: string[] = [];
    while (ready.length) { const id = ready.shift()!; order.push(id); for (const next of outgoing.get(id)!) { indegree.set(next, indegree.get(next)! - 1); if (indegree.get(next) === 0) { ready.push(next); ready.sort(); } } }
    if (order.length !== intended.size) throw new Error('Deletion dependency and hierarchy constraints conflict.');
    for (const id of order) { const card = state.get(id)!;const recordNames=[...this.workflows.cardTypes.get(card.type)!.records.keys()]; const change = versionChange(card, null, 'delete', ['__deleted__'], 'card deleted', 'analyst subtree deletion',agentName); publishCardTombstone(this.projectRoot, id, card, change, this.cardAppendIo); this.publishCardVersionEffects(change, cardParentId(card.id), true, recordNames); this.freshness.agentMembershipChanged({ scope: 'card', cardId: card.id }); }
    return { deleted: order, requested: roots };
  }
}
