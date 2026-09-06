import type { CardService } from '../cards/card-service.js';
import { analystRecordEditEffect } from '../cards/status-api.js';
import { parseRecordUrl, RecordMutationFailureSchema, RecordMutationSuccessSchema, type AnalystPreNetworkAdmission, type RecordMutationDenialReason, type RecordMutationFailure, type RecordMutationResult, type RecordMutationSuccess } from '../contracts/record-mutation.js';
import { effectiveRecordContent, isEmptyRecordContent } from '../persistence/canonical-record-artifacts.js';
import type { RecordProjection } from '../persistence/authored-record-files.js';
import type { AgentName } from '../schemas/index.js';

export interface RecordMutationRequest {
  path: string;
  operation: 'write' | 'edit';
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  surface: 'card_agent' | 'analyst';
  agentName: AgentName;
  cardId?: string;
  requiredTools: readonly ('write' | 'edit' | 'webfetch')[];
  onRecordWritten?: (name: string) => void;
}

type Admission = { parsed: ReturnType<typeof parseRecordUrl>; current: RecordProjection | null };

function failure(value: RecordMutationFailure): RecordMutationFailure { return RecordMutationFailureSchema.parse(value); }
function denied(parsed: ReturnType<typeof parseRecordUrl>, operation: 'write' | 'edit', reason: RecordMutationDenialReason): RecordMutationFailure {
  return failure({ kind: 'rejected', error: 'Record mutation is not authorized.', data: { code: 'record_mutation_denied', card_id: parsed.cardId, name: parsed.name as never, operation, reason } });
}

export function admitRecordMutation(store: CardService, request: RecordMutationRequest): Admission | RecordMutationFailure {
  const parsed = parseRecordUrl(request.path);
  if (parsed.version !== null) throw new Error('Historical record URLs cannot be mutated.');
  let card: ReturnType<CardService['read']>;
  try { card = store.read(parsed.cardId); }
  catch { return failure({ kind: 'rejected', error: 'Current record state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: 'card', owner_id: parsed.cardId, operation: request.operation, restart_required: true } }); }
  if (!card) return denied(parsed, request.operation, 'card_not_active');
  if (request.surface === 'card_agent' && request.cardId !== parsed.cardId) return denied(parsed, request.operation, 'cross_card_scope');
  const configured = request.surface === 'analyst' ? store.workflows.analyst : store.workflows.agents.get(request.agentName);
  if (!configured || !configured.recordWrites.some(({ matcher }) => matcher.test(parsed.name))) return denied(parsed, request.operation, 'writer_not_authorized');
  if (request.requiredTools.some((name) => !configured.tools.some((tool) => tool.name === name))) return denied(parsed, request.operation, 'tool_not_authorized');
  if (request.surface === 'analyst' && analystRecordEditEffect(card.lifecycle.status) === null) return denied(parsed, request.operation, 'lifecycle_unsupported');
  let classification: ReturnType<CardService['classifyCurrentRecord']>;
  try { classification = store.classifyCurrentRecord(parsed.cardId, parsed.name); }
  catch { return failure({ kind: 'rejected', error: 'Current record state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: 'authored_record', owner_id: `${parsed.cardId}/${parsed.name}`, operation: request.operation, restart_required: true } }); }
  const current = classification.kind === 'present' ? classification.projection : null;
  if (request.surface === 'analyst' && current?.artifact.state === 'open') return failure({ kind: 'rejected', error: 'Record already has an open workflow draft.', data: { code: 'record_open_conflict', card_id: parsed.cardId, name: parsed.name as never, current_head: current.headVersion, operation: request.operation } });
  return { parsed, current };
}

export function preflightAnalystRecordWrite(store: CardService, request: Omit<RecordMutationRequest, 'content' | 'oldString' | 'newString' | 'replaceAll'>): AnalystPreNetworkAdmission {
  const admitted = admitRecordMutation(store, request);
  if ('kind' in admitted) {
    if (admitted.error === 'Record mutation is not authorized.') return { ok: false, result: admitted, audit_outcome: 'denied' };
    if (admitted.error === 'Record already has an open workflow draft.') return { ok: false, result: admitted, audit_outcome: 'error' };
    if (admitted.error === 'Current record state unavailable; restart required.') return { ok: false, result: admitted, audit_outcome: 'error' };
    throw new Error('Pre-network admission returned a content-dependent failure.');
  }
  return { ok: true };
}

export function mutateRecord(store: CardService, request: RecordMutationRequest, propagate?: () => { ok: true } | { ok: false; partial: true; error: string }): RecordMutationResult {
  const admitted = admitRecordMutation(store, request); if ('kind' in admitted) return admitted;
  const { parsed, current } = admitted; const currentHead = current?.headVersion ?? null; const effective = current ? effectiveRecordContent(current.artifact) : null;
  let nextContent: string;
  if (request.operation === 'edit') {
    if (!effective) return failure({ kind: 'rejected', error: 'Record has no content to edit.', data: { code: 'record_content_absent', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead } });
    const oldString = request.oldString!; const occurrences = effective.content.split(oldString).length - 1;
    if (occurrences === 0) return failure({ kind: 'rejected', error: 'old_string was not found in current record content.', data: { code: 'record_edit_old_string_not_found', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead! } });
    if (occurrences > 1 && request.replaceAll !== true) return failure({ kind: 'rejected', error: 'old_string matched multiple locations; set replace_all to true.', data: { code: 'record_edit_old_string_multiple_matches', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead!, occurrences, replace_all_required: true } });
    nextContent = request.replaceAll ? effective.content.split(oldString).join(request.newString!) : effective.content.replace(oldString, request.newString!);
  } else nextContent = request.content!;
  if (isEmptyRecordContent(nextContent)) return failure({ kind: 'rejected', error: 'Record content must not be empty.', data: { code: 'record_result_content_empty', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead, operation: request.operation } });
  if (effective?.content === nextContent) return failure({ kind: 'rejected', error: 'Record content is unchanged.', data: { code: 'record_content_unchanged', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead!, operation: request.operation } });
  if (current?.artifact.state !== 'open') store.openRecord(parsed.cardId, parsed.name);
  const edited = store.editRecord(parsed.cardId, parsed.name, nextContent);
  const result = request.surface === 'analyst' ? store.closeRecord(parsed.cardId, parsed.name, request.agentName) : edited;
  const success: RecordMutationSuccess = { kind: 'applied', data: { card_id: parsed.cardId, name: parsed.name as never, state: request.surface === 'analyst' ? 'closed' : 'open', head_version: result.headVersion, head_entry_id: result.artifact.entry_id, current_url: result.currentUrl, version_url: result.versionUrl, bytes: Buffer.byteLength(nextContent), written: true, surface: request.surface, ...(request.surface === 'analyst' ? { propagation: propagate ? propagate() : { ok: true as const } } : {}) } };
  const validated = RecordMutationSuccessSchema.parse(success);
  if (request.surface === 'card_agent') request.onRecordWritten?.(parsed.name);
  return validated;
}
