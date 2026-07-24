import { z, type ZodTypeAny } from 'zod';

import { reconfigureParamsSchema } from '../config/index.js';
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
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { redactTextForOutbound } from '../redaction/text.js';
import { projectMcpToolCallArgumentsForOutbound } from './mcp-invocation-outbound.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';
import { projectWebfetchInvocationForOutbound } from './webfetch-outbound.js';

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
        result: projectOpaqueResult(input.result),
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
      return { shape: 'result-row', identity: { ...input.identity }, result: projectOpaqueResult(input.result) };
  }
}

function projectUnsupportedInvocation(input: ToolInvocationProjectionInput): ToolInvocationProjectionInput {
  switch (input.shape) {
    case 'complete':
      return { shape: 'complete', identity: { ...input.identity }, arguments: projectDynamicForOutbound(input.arguments), result: projectOpaqueResult(input.result) };
    case 'call-row': {
      try {
        return { shape: 'call-row', identity: { ...input.identity }, arguments: JSON.stringify(projectDynamicForOutbound(JSON.parse(input.arguments) as unknown)) };
      } catch {
        return { shape: 'call-row', identity: { ...input.identity }, arguments: redactTextForOutbound(input.arguments) };
      }
    }
    case 'result-row':
      return { shape: 'result-row', identity: { ...input.identity }, result: projectOpaqueResult(input.result) };
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
      return copyWithText(input, ['title', 'bootstrap_content']);
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
    case 'set_agent_model_route':case 'set_model_failover':case 'set_server_setting':return structuredClone(input);
    default:throw new Error(`Unhandled valid reconfigure action '${String(input['action'])}'.`);
  }
}

function projectOpaqueResult(value: unknown): ReturnType<typeof ToolInvocationResultSchema.parse> {
  const result = ToolInvocationResultSchema.parse(value);
  return ToolInvocationResultSchema.parse({
    success: result.success,
    ...(!result.success ? { error: projectDynamicForOutbound(result.error) } : {}),
    ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }),
  });
}

function copyWithText(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const output = structuredClone(input);
  for (const key of keys) if (typeof input[key] === 'string') output[key] = redactTextForOutbound(input[key] as string);
  return output;
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
