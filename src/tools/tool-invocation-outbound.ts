import { z, type ZodTypeAny } from 'zod';

import { projectBoundedAgentSessionWrapper } from '../application/read-models/canonical-conversation-outbound.js';
import { projectCardDiff, projectCardHistory, projectCardRecordForOutbound } from '../application/read-models/card-outbound.js';
import { projectProcessForOutbound } from '../application/read-models/process-outbound.js';
import { reconfigureParamsSchema } from '../config/index.js';
import { projectEffectiveConfigForOutbound } from '../config/effective-config-outbound.js';
import {
  analystCancelCardInputSchema, analystCreateCardInputSchema, analystDeleteCardInputSchema, analystReorderChildInputSchema,
  applyPatchInputSchema, diffCardInputSchema, editWorkspaceInputSchema, emptyToolInputSchema,
  getCardHistoryEntryInputSchema, getCardInputSchema, getTreeInputSchema, globWorkspaceInputSchema, grepWorkspaceInputSchema,
  killProcessInputSchema, listCardHistoryInputSchema, listCardsInputSchema, listProcessesInputSchema,
  navigateWorkspaceInputSchema, plannerCancelCardInputSchema, plannerCreateCardInputSchema, plannerEditCardInputSchema,
  plannerQueueNotificationInputSchema, plannerReorderChildInputSchema, queueNotificationInputSchema,
  readAgentSessionInputSchema, readControlActionsInputSchema, readRuntimeErrorsInputSchema, readRuntimeEventsInputSchema,
  readWorkspaceInputSchema, runCommandInputSchema, skillInputSchema, waitProcessInputSchema, websearchInputSchema,
  writeWorkspaceInputSchema,
} from '../contracts/builtin-tool-inputs.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../contracts/result-envelope.js';
import { activateCardArgumentsSchema } from '../contracts/tool-api.js';
import { WebfetchInvocationSchema } from '../contracts/webfetch.js';
import {
  ToolInvocationResultSchema,
  type ToolInvocationProjectionInput,
} from '../contracts/tool-invocation-projection.js';
import { projectLoggedEvent } from '../observability/logged-event-projection.js';
import { projectControlAction } from '../persistence/control-action-outbound.js';
import { cardHistoryEntrySchema, cardHistoryHeaderSchema, cardRecordSchema, controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { redactTextForOutbound, redactUrl, SECRET_REDACTION_PLACEHOLDER } from '../redaction/text.js';
import { projectMcpReconcileResultForOutbound, projectMcpToolCallArgumentsForOutbound, projectMcpToolCallResultForOutbound } from './mcp-invocation-outbound.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';
import { projectWebfetchInvocationForOutbound, projectWebfetchResultForOutbound } from './webfetch-outbound.js';

const emitResultArgumentsSchema = z.object({ outcome: z.string(), summary: z.string() }).strict();

export const KNOWN_TOOL_INVOCATION_NAMES = [
  'create_card', 'cancel_card', 'delete_card', 'reorder_child', 'queue_notification',
  'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'mcp_reconcile',
  'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure',
  'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool',
  'list_agent_sessions', 'read_agent_session', 'list_cards', 'get_card', 'get_tree',
  'list_card_history', 'get_card_history_entry', 'diff_card',
  'read', 'write', 'edit', 'glob', 'grep', 'apply_patch',
  'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call',
  'edit_card', 'activate_card', TERMINAL_RESULT_TOOL_NAME,
] as const;

export type KnownToolInvocationName = typeof KNOWN_TOOL_INVOCATION_NAMES[number];
const knownToolNames = new Set<string>(KNOWN_TOOL_INVOCATION_NAMES);

export function projectToolInvocation(input: ToolInvocationProjectionInput): ToolInvocationProjectionInput {
  if (!knownToolNames.has(input.identity.toolName)) return projectUnsupportedInvocation(input);
  const toolName = input.identity.toolName as KnownToolInvocationName;

  switch (input.shape) {
    case 'complete': {
      const identity = { ...input.identity };
      const projectedArguments = projectParsedArguments(toolName, input.arguments);
      return {
        shape: 'complete',
        identity,
        arguments: projectedArguments,
        result: projectKnownResult(toolName, input.result),
      };
    }
    case 'call-row': {
      const identity = { ...input.identity };
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.arguments) as unknown;
      } catch {
        return { shape: 'call-row', identity, arguments: redactTextForOutbound(input.arguments) };
      }
      const projectedArguments = projectParsedArguments(toolName, parsed);
      return { shape: 'call-row', identity, arguments: JSON.stringify(projectedArguments) };
    }
    case 'result-row':
      return { shape: 'result-row', identity: { ...input.identity }, result: projectKnownResult(toolName, input.result) };
  }
}

function projectUnsupportedInvocation(input: ToolInvocationProjectionInput): ToolInvocationProjectionInput {
  switch (input.shape) {
    case 'complete':
      return { shape: 'complete', identity: { ...input.identity }, arguments: projectDynamicForOutbound(input.arguments), result: projectUnsupportedResult(input.result) };
    case 'call-row': {
      try {
        return { shape: 'call-row', identity: { ...input.identity }, arguments: JSON.stringify(projectDynamicForOutbound(JSON.parse(input.arguments) as unknown)) };
      } catch {
        return { shape: 'call-row', identity: { ...input.identity }, arguments: redactTextForOutbound(input.arguments) };
      }
    }
    case 'result-row':
      return { shape: 'result-row', identity: { ...input.identity }, result: projectUnsupportedResult(input.result) };
  }
}

function projectParsedArguments(toolName: KnownToolInvocationName, value: unknown): unknown {
  const parsed = inputSchemaFor(toolName).safeParse(value);
  if (!parsed.success) return projectDynamicForOutbound(value);
  return projectValidArguments(toolName, parsed.data);
}

function projectValidArguments(toolName: KnownToolInvocationName, value: unknown): unknown {
  const input = value as Record<string, unknown>;
  switch (toolName) {
    case 'create_card':
      return copyWithText(input, ['title', 'brief']);
    case 'cancel_card':
      return copyWithText(input, ['reason']);
    case 'queue_notification':
      return copyWithText(input, ['body']);
    case 'edit_card':
      return copyWithText(input, ['title']);
    case 'navigate_workspace': {
      const target = input['target'] as Record<string, unknown>;
      return { target: copyWithText(target, ['refinement']) };
    }
    case 'reconfigure':
      return projectReconfigureArguments(input);
    case 'write':
      return { ...input, content: redactTextForOutbound(input['content'] as string) };
    case 'edit':
      return { ...input, old_string: redactTextForOutbound(input['old_string'] as string), new_string: redactTextForOutbound(input['new_string'] as string) };
    case 'glob':
      return copyWithText(input, ['pattern']);
    case 'grep':
      return copyWithText(input, ['pattern', 'include']);
    case 'apply_patch':
      return { patch: redactTextForOutbound(input['patch'] as string) };
    case 'run_command':
      return { ...input, command: redactTextForOutbound(input['command'] as string) };
    case 'websearch':
      return { ...input, query: redactTextForOutbound(input['query'] as string) };
    case 'webfetch':
      return projectWebfetchInvocationForOutbound(inputSchemaFor(toolName).parse(input));
    case 'mcp_tool_call':
      return projectMcpToolCallArgumentsForOutbound(McpToolCallArgumentsSchema.parse(input));
    case 'emit_result':
      return { outcome: input['outcome'], summary: redactTextForOutbound(input['summary'] as string) };
    case 'delete_card': case 'reorder_child': case 'get_status': case 'start_project': case 'pause_runtime':
    case 'resume_runtime': case 'stop_project': case 'restart_server': case 'mcp_reconcile': case 'navigate_back':
    case 'show_config': case 'read_runtime_events': case 'read_runtime_errors': case 'read_control_actions':
    case 'list_processes_tool': case 'list_agent_sessions': case 'read_agent_session': case 'list_cards':
    case 'get_card': case 'get_tree': case 'list_card_history': case 'get_card_history_entry': case 'diff_card':
    case 'read': case 'wait_process': case 'kill_process': case 'skill': case 'activate_card':
      return structuredClone(value);
  }
}

function projectReconfigureArguments(input: Record<string, unknown>): unknown {
  switch (input['action']) {
    case 'mcp_add':
    case 'mcp_edit': {
      const env = input['env'] as Record<string, string> | undefined;
      return {
        ...input,
        command: redactTextForOutbound(input['command'] as string),
        ...(input['args'] === undefined ? {} : { args: (input['args'] as string[]).map(redactTextForOutbound) }),
        ...(env === undefined ? {} : { env: Object.fromEntries(Object.keys(env).map((key) => [key, SECRET_REDACTION_PLACEHOLDER])) }),
      };
    }
    case 'set_role_routing': case 'set_failover_chain': case 'mcp_remove': case 'set_runtime_setting': case 'set_server_setting':
      return structuredClone(input);
    default:
      throw new Error(`Unhandled valid reconfigure action '${String(input['action'])}'.`);
  }
}

function projectKnownResult(toolName: KnownToolInvocationName, value: unknown): ReturnType<typeof ToolInvocationResultSchema.parse> {
  const result = ToolInvocationResultSchema.parse(value);
  if (!result.success) {
    return ToolInvocationResultSchema.parse({
      success: false,
      error: redactTextForOutbound(result.error),
      ...(result.data === undefined ? {} : { data: toolName === 'emit_result' ? projectDynamicForOutbound(result.data) : projectKnownData(toolName, result.data) }),
    });
  }
  return ToolInvocationResultSchema.parse({
    success: true,
    ...(result.data === undefined ? {} : { data: projectKnownData(toolName, result.data) }),
  });
}

function projectKnownData(toolName: KnownToolInvocationName, data: unknown): unknown {
  switch (toolName) {
    case 'show_config': {
      const value = strictRecord(data, toolName);
      return { config: projectEffectiveConfigForOutbound(value['config'] as never) };
    }
    case 'list_processes_tool':
      return z.array(z.unknown()).parse(data).map((item) => projectProcessForOutbound(item as never));
    case 'run_command': case 'wait_process': case 'kill_process':
      return projectProcessForOutbound(data as never);
    case 'webfetch':
      return projectSuccessfulWebfetchData(data);
    case 'mcp_tool_call':
      return projectMcpToolCallResultForOutbound({ success: true, data }).data;
    case 'mcp_reconcile':
      return projectMcpReconcileResultForOutbound({ success: false, error: '', data } as never).data;
    case 'read_agent_session':
      return projectBoundedAgentSessionWrapper(data, projectToolInvocation);
    case 'read_runtime_events': case 'read_runtime_errors':
      return projectEventQueryData(data);
    case 'read_control_actions':
      return projectControlActionQueryData(data);
    case 'list_card_history':
      return z.array(cardHistoryHeaderSchema).parse(data).map(projectCardHistory);
    case 'get_card_history_entry':
      return projectCardHistory(cardHistoryEntrySchema.parse(data));
    case 'diff_card': {
      const value = strictRecord(data, toolName);
      return { ...value, diff: projectCardDiff(value['diff'] as never) };
    }
    case 'websearch':
      return projectWebsearchData(data);
    case 'emit_result':
      return projectDirectResultData(data, new Set(['summary', 'error']));
    case 'read': case 'write': case 'edit': case 'glob': case 'grep': case 'apply_patch':
      return projectDirectResultData(data, WORKSPACE_RESULT_TEXT_KEYS);
    case 'create_card': case 'cancel_card': case 'delete_card': case 'reorder_child': case 'queue_notification':
    case 'edit_card': case 'activate_card': case 'list_cards': case 'get_card': case 'get_tree':
      return projectDirectResultData(data, CARD_RESULT_TEXT_KEYS);
    case 'get_status': case 'start_project': case 'pause_runtime': case 'resume_runtime': case 'stop_project':
    case 'restart_server': case 'navigate_workspace': case 'navigate_back': case 'reconfigure':
      return projectDirectResultData(data, CONTROL_RESULT_TEXT_KEYS);
    case 'list_agent_sessions':
      return projectDirectResultData(data, new Set());
    case 'skill':
      return projectDirectResultData(data, new Set(['skill_content']));
  }
}

function projectUnsupportedResult(value: unknown): ReturnType<typeof ToolInvocationResultSchema.parse> {
  const result = ToolInvocationResultSchema.parse(value);
  return ToolInvocationResultSchema.parse({
    success: result.success,
    ...(!result.success ? { error: redactTextForOutbound(result.error) } : {}),
    ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }),
  });
}

function projectSuccessfulWebfetchData(data: unknown): unknown {
  const projected = projectWebfetchResultForOutbound({ success: true, data } as never);
  if (!projected.success) throw new Error('Successful webfetch data projected to a failed result.');
  return projected.data;
}

function projectEventQueryData(data: unknown): unknown {
  const value = strictRecord(data, 'event query');
  const key = Object.hasOwn(value, 'events') ? 'events' : 'errors';
  return { ...value, [key]: z.array(loggedEventSchema).parse(value[key]).map(projectLoggedEvent) };
}

function projectControlActionQueryData(data: unknown): unknown {
  const value = strictRecord(data, 'read_control_actions');
  return { ...value, actions: z.array(controlActionAuditEntrySchema).parse(value['actions']).map(projectControlAction) };
}

function projectWebsearchData(data: unknown): unknown {
  const value = strictRecord(data, 'websearch');
  const results = z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() }).strict()).parse(value['results']);
  return {
    query: redactTextForOutbound(String(value['query'])),
    results: results.map((result) => ({
      title: redactTextForOutbound(result.title),
      url: redactUrl(result.url),
      snippet: redactTextForOutbound(result.snippet),
    })),
  };
}

const CARD_RESULT_TEXT_KEYS = new Set(['title', 'brief', 'reason', 'body', 'content', 'message', 'summary', 'error', 'change_reason', 'change_summary', 'resume_reason']);
const CONTROL_RESULT_TEXT_KEYS = new Set(['message', 'summary', 'error', 'refinement', 'confirmationMessage']);
const WORKSPACE_RESULT_TEXT_KEYS = new Set(['content', 'preview', 'pattern', 'message', 'error']);

function projectDirectResultData(value: unknown, textKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => projectDirectResultData(item, textKeys));
  if (value === null || typeof value !== 'object') return value;
  const card = cardRecordSchema.safeParse(value);
  if (card.success) return projectCardRecordForOutbound(card.data);
  const output: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (textKeys.has(key) && typeof member === 'string') output[key] = redactTextForOutbound(member);
    else output[key] = projectDirectResultData(member, textKeys);
  }
  return output;
}

function copyWithText(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const output = structuredClone(input);
  for (const key of keys) if (typeof input[key] === 'string') output[key] = redactTextForOutbound(input[key] as string);
  return output;
}

function strictRecord(value: unknown, owner: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${owner} result data must be an object.`);
  return value as Record<string, unknown>;
}

function inputSchemaFor(toolName: KnownToolInvocationName): ZodTypeAny {
  switch (toolName) {
    case 'create_card': return z.union([analystCreateCardInputSchema, plannerCreateCardInputSchema]);
    case 'cancel_card': return z.union([analystCancelCardInputSchema, plannerCancelCardInputSchema]);
    case 'delete_card': return analystDeleteCardInputSchema;
    case 'reorder_child': return z.union([analystReorderChildInputSchema, plannerReorderChildInputSchema]);
    case 'queue_notification': return z.union([queueNotificationInputSchema, plannerQueueNotificationInputSchema]);
    case 'get_status': case 'start_project': case 'pause_runtime': case 'resume_runtime': case 'stop_project':
    case 'restart_server': case 'mcp_reconcile': case 'navigate_back': case 'show_config': case 'list_agent_sessions':
      return emptyToolInputSchema;
    case 'navigate_workspace': return navigateWorkspaceInputSchema;
    case 'reconfigure': return reconfigureParamsSchema;
    case 'read_runtime_events': return readRuntimeEventsInputSchema;
    case 'read_runtime_errors': return readRuntimeErrorsInputSchema;
    case 'read_control_actions': return readControlActionsInputSchema;
    case 'list_processes_tool': return listProcessesInputSchema;
    case 'read_agent_session': return readAgentSessionInputSchema;
    case 'list_cards': return listCardsInputSchema;
    case 'get_card': return getCardInputSchema;
    case 'get_tree': return getTreeInputSchema;
    case 'list_card_history': return listCardHistoryInputSchema;
    case 'get_card_history_entry': return getCardHistoryEntryInputSchema;
    case 'diff_card': return diffCardInputSchema;
    case 'read': return readWorkspaceInputSchema;
    case 'write': return writeWorkspaceInputSchema;
    case 'edit': return editWorkspaceInputSchema;
    case 'glob': return globWorkspaceInputSchema;
    case 'grep': return grepWorkspaceInputSchema;
    case 'apply_patch': return applyPatchInputSchema;
    case 'run_command': return runCommandInputSchema;
    case 'wait_process': return waitProcessInputSchema;
    case 'kill_process': return killProcessInputSchema;
    case 'websearch': return websearchInputSchema;
    case 'webfetch': return WebfetchInvocationSchema;
    case 'skill': return skillInputSchema;
    case 'mcp_tool_call': return McpToolCallArgumentsSchema;
    case 'edit_card': return plannerEditCardInputSchema;
    case 'activate_card': return activateCardArgumentsSchema;
    case 'emit_result': return emitResultArgumentsSchema;
  }
}
