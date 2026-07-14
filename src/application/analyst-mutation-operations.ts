import type { ConfigMutation } from '../config/index.js';
import type { ToolResult } from '../tools/analyst-tool-types.js';
import type { CreateAnalystCardInput } from './analyst-mutation-services.js';
import type { AnalystMutationContext, MutationAdmission } from '../agents/analyst-tool-runner.js';
import type { PreparedFetchedBrief } from './analyst-prepare/webfetch.js';

export function allowAnalystMutation(): MutationAdmission { return { allowed: true }; }

export function recheckCreateCard(_prepared: undefined, input: CreateAnalystCardInput, ctx: AnalystMutationContext): MutationAdmission { return ctx.services.cards.validateCreate(input); }
export function recheckDeleteCards(_prepared: undefined, input: { ids: string[] }, ctx: AnalystMutationContext): MutationAdmission { return ctx.services.cards.validateDelete(input.ids); }
export function recheckCancelCard(_prepared: undefined, input: { cardId: string }, ctx: AnalystMutationContext): MutationAdmission { return ctx.services.cards.validateCancel(input.cardId); }
export function recheckReorderChildren(_prepared: undefined, input: { parentId: string; orderedChildIds: string[] }, ctx: AnalystMutationContext): MutationAdmission { return ctx.services.cards.validateReorder(input.parentId, input.orderedChildIds); }
export function recheckQueueNotification(): MutationAdmission { return { allowed: true }; }

export function commitCreateCard(_prepared: undefined, input: CreateAnalystCardInput, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.cards.create(input);
}

export function commitDeleteCards(_prepared: undefined, input: { ids: string[] }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.cards.delete(input.ids);
}

export function commitCancelCard(_prepared: undefined, input: { cardId: string; reason?: string }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.cards.cancel(input.cardId, input.reason);
}

export function commitReorderChildren(_prepared: undefined, input: { parentId: string; orderedChildIds: string[] }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.cards.reorder(input.parentId, input.orderedChildIds);
}

export function commitQueueNotification(_prepared: undefined, input: { recipient: string; kind: string; body: string }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.notifications.queue(input.recipient, input.kind, input.body);
}

export function commitConfigChange(prepared: ConfigMutation, _input: Record<string, unknown>, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.config.apply(prepared);
}

export function commitReconfigure(_prepared: undefined, input: { action: string; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; key?: string; value?: unknown }, ctx: AnalystMutationContext): ToolResult {
  const mutation = reconfigureMutation(input);
  if (!mutation) return { success: false, error: 'Unknown reconfigure action.', data: { reason: 'invalid_argument', fieldPath: 'action', detail: 'Unknown reconfigure action.' } };
  return ctx.services.config.apply(mutation);
}

export function recheckReconfigure(_prepared: undefined, input: { action: string; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; key?: string; value?: unknown }, ctx: AnalystMutationContext): MutationAdmission {
  const mutation = reconfigureMutation(input);
  return mutation ? ctx.services.config.validate(mutation) : { allowed: false, reason: 'unknown reconfigure action' };
}

function reconfigureMutation(input: { action: string; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; key?: string; value?: unknown }): ConfigMutation | null {
  switch (input.action) {
    case 'set_role_routing': return { kind: 'set_role_routing', role: input.role!, modelCandidate: input.model_candidate! };
    case 'set_failover_chain': return { kind: 'set_failover_chain', forModel: input.for_model!, orderedFailoverModels: input.ordered_failover_models! };
    case 'set_runtime_setting': return { kind: 'set_runtime_setting', key: input.key!, value: input.value };
    case 'set_server_setting': return { kind: 'set_server_setting', key: input.key!, value: input.value };
    default: return null;
  }
}

export function commitWriteBrief(_prepared: undefined, input: { path: string; content: string }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.briefRecords.write(input.path, input.content);
}

export function commitEditBrief(_prepared: undefined, input: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: AnalystMutationContext): ToolResult {
  return ctx.services.briefRecords.edit(input.path, input.old_string, input.new_string, input.replace_all === true);
}

export function commitFetchedBrief(prepared: PreparedFetchedBrief, input: { save_as: string }, ctx: AnalystMutationContext): ToolResult {
  const result = ctx.services.briefRecords.write(input.save_as, prepared.content);
  if (!result.success) return result;
  return { success: true, data: { ...prepared.metadata, saved_as: (result.data as Record<string, unknown>)['record_url'], write: result.data, bytes: Buffer.byteLength(prepared.content, 'utf8') } };
}

export function recheckWriteBrief(_prepared: undefined, input: { path: string; content: string }, ctx: AnalystMutationContext): MutationAdmission {
  return ctx.services.briefRecords.validateWrite(input.path, input.content);
}

export function recheckEditBrief(_prepared: undefined, input: { path: string; old_string: string; replace_all?: boolean }, ctx: AnalystMutationContext): MutationAdmission {
  return ctx.services.briefRecords.validateEdit(input.path, input.old_string, input.replace_all === true);
}

export function recheckFetchedBrief(prepared: PreparedFetchedBrief, input: { save_as: string }, ctx: AnalystMutationContext): MutationAdmission {
  return ctx.services.briefRecords.validateWrite(input.save_as, prepared.content);
}
