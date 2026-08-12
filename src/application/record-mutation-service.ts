import type { CardService } from '../cards/card-service.js';
import { analystRecordEditEffect } from '../cards/status-api.js';
import { buildRecordMutationUrl, parseRecordMutationUrl, RecordMutationFailureSchema, RecordMutationSuccessSchema, type AnalystPreNetworkAdmission, type RecordMutationFailure, type RecordMutationResult, type RecordMutationSuccess } from '../contracts/record-mutation.js';
import { effectiveRecordContent, isEmptyRecordContent } from '../persistence/canonical-record-artifacts.js';
import { AuthoredRecordDefinitionNotFoundError, RecordHeadMismatchError, type RecordProjection } from '../persistence/authored-record-files.js';
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
}

type Admission = { parsed: ReturnType<typeof parseRecordMutationUrl>; current: RecordProjection | null };

function failure(value: RecordMutationFailure): RecordMutationFailure { return RecordMutationFailureSchema.parse(value); }
function denied(parsed: ReturnType<typeof parseRecordMutationUrl>, operation: 'write' | 'edit', reason: z.infer<typeof reasonSchema>): RecordMutationFailure {
  return failure({ success: false, error: 'Record mutation is not authorized.', data: { code: 'record_mutation_denied', card_id: parsed.cardId, name: parsed.name as never, operation, reason } });
}
import { z } from 'zod';
const reasonSchema = z.enum(['card_not_active', 'record_not_configured', 'writer_not_authorized', 'tool_not_authorized', 'cross_card_scope', 'lifecycle_unsupported']);

export function admitRecordMutation(store: CardService, request: RecordMutationRequest): Admission | RecordMutationFailure {
  const parsed = parseRecordMutationUrl(request.path); let card: ReturnType<CardService['read']>;
  try { card = store.read(parsed.cardId); }
  catch { return failure({ success: false, error: 'Current record state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: 'card', owner_id: parsed.cardId, operation: request.operation, restart_required: true } }); }
  if (!card) return denied(parsed, request.operation, 'card_not_active');
  let definition; try { definition = store.recordReader.definition(parsed.cardId, parsed.name); } catch (error) { if (error instanceof AuthoredRecordDefinitionNotFoundError) return denied(parsed, request.operation, 'record_not_configured'); throw error; }
  if (request.surface === 'card_agent' && request.cardId !== parsed.cardId) return denied(parsed, request.operation, 'cross_card_scope');
  if (!definition.writers.includes(request.agentName)) return denied(parsed, request.operation, 'writer_not_authorized');
  const configured = request.surface === 'analyst' ? store.workflows.analyst : store.workflows.agents.get(request.agentName);
  if (!configured || request.requiredTools.some((name) => !configured.tools.some((tool) => tool.name === name))) return denied(parsed, request.operation, 'tool_not_authorized');
  if (request.surface === 'analyst' && analystRecordEditEffect(card.lifecycle.status) === null) return denied(parsed, request.operation, 'lifecycle_unsupported');
  let current: RecordProjection | null;
  try { current = store.readCurrentRecordOrNull(parsed.cardId, parsed.name); }
  catch { return failure({ success: false, error: 'Current record state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: 'authored_record', owner_id: `${parsed.cardId}/${parsed.name}`, operation: request.operation, restart_required: true } }); }
  const currentHead = current?.headVersion ?? null; const expected = parsed.expectedHead === 'absent' ? null : parsed.expectedHead;
  if (currentHead !== expected) return failure({ success: false, error: 'Record mutation is stale.', data: { code: 'record_mutation_stale', card_id: parsed.cardId, name: parsed.name as never, operation: request.operation, expected_head: parsed.expectedHead, current_head: currentHead } });
  if (request.surface === 'analyst' && current?.artifact.state === 'open') return failure({ success: false, error: 'Record already has an open workflow draft.', data: { code: 'record_open_conflict', card_id: parsed.cardId, name: parsed.name as never, current_head: current.headVersion, operation: request.operation } });
  return { parsed, current };
}

export function preflightAnalystRecordWrite(store: CardService, request: Omit<RecordMutationRequest, 'content' | 'oldString' | 'newString' | 'replaceAll'>): AnalystPreNetworkAdmission {
  const admitted = admitRecordMutation(store, request);
  if ('success' in admitted) return { ok: false, result: admitted, audit_outcome: admitted.data.code === 'record_mutation_denied' ? 'denied' : 'error' } as AnalystPreNetworkAdmission;
  return { ok: true };
}

export function mutateRecord(store: CardService, request: RecordMutationRequest, propagate?: () => { ok: true } | { ok: false; partial: true; error: string }): RecordMutationResult {
  const admitted = admitRecordMutation(store, request); if ('success' in admitted) return admitted;
  const { parsed, current } = admitted; const currentHead = current?.headVersion ?? null; const effective = current ? effectiveRecordContent(current.artifact) : null;
  let nextContent: string;
  if (request.operation === 'edit') {
    if (!effective) return failure({ success: false, error: 'Record has no content to edit.', data: { code: 'record_content_absent', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead } });
    const oldString = request.oldString!; const occurrences = effective.content.split(oldString).length - 1;
    if (occurrences === 0) return failure({ success: false, error: 'old_string was not found in current record content.', data: { code: 'record_edit_old_string_not_found', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead! } });
    if (occurrences > 1 && request.replaceAll !== true) return failure({ success: false, error: 'old_string matched multiple locations; set replace_all to true.', data: { code: 'record_edit_old_string_multiple_matches', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead!, occurrences, replace_all_required: true } });
    nextContent = request.replaceAll ? effective.content.split(oldString).join(request.newString!) : effective.content.replace(oldString, request.newString!);
  } else nextContent = request.content!;
  if (isEmptyRecordContent(nextContent)) return failure({ success: false, error: 'Record content must not be empty.', data: { code: 'record_result_content_empty', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead, operation: request.operation } });
  if (effective?.content === nextContent) return failure({ success: false, error: 'Record content is unchanged.', data: { code: 'record_content_unchanged', card_id: parsed.cardId, name: parsed.name as never, current_head: currentHead!, operation: request.operation } });
  try {
    let open: RecordProjection;
    if (current?.artifact.state === 'open') open = current;
    else open = store.openRecord(parsed.cardId, parsed.name, currentHead);
    const edited = store.editRecord(parsed.cardId, parsed.name, open.headVersion, nextContent);
    const result = request.surface === 'analyst' ? store.closeRecord(parsed.cardId, parsed.name, edited.headVersion, request.agentName) : edited;
    const success: RecordMutationSuccess = { success: true, data: { card_id: parsed.cardId, name: parsed.name as never, state: request.surface === 'analyst' ? 'closed' : 'open', head_version: result.headVersion, head_entry_id: result.artifact.entry_id, current_url: result.currentUrl, version_url: result.versionUrl, mutation_url: buildRecordMutationUrl(parsed.cardId, parsed.name, result.headVersion), bytes: Buffer.byteLength(nextContent), written: true, surface: request.surface, ...(request.surface === 'analyst' ? { propagation: propagate ? propagate() : { ok: true as const } } : {}) } };
    return RecordMutationSuccessSchema.parse(success);
  } catch (error) {
    if (error instanceof RecordHeadMismatchError) return failure({ success: false, error: 'Record mutation is stale.', data: { code: 'record_mutation_stale', card_id: parsed.cardId, name: parsed.name as never, operation: request.operation, expected_head: parsed.expectedHead, current_head: error.currentHead } });
    throw error;
  }
}
