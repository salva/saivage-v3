import type { ControlActionSurface } from '../schemas/index.js';
import type { ToolContext, ToolResult } from '../tools/analyst-tool-types.js';
import {
  ANALYST_ISSUE_SEVERITY_VALUES,
  ANALYST_TOOL_DEFINITIONS,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  TOOL_DEFINITIONS,
  URGENCY_VALUES,
  type UnifiedToolDefinition,
} from '../tools/definitions/index.js';
import type { ToolDefinition } from './llm-contracts.js';
import { RoleToolPolicy } from './role-tool-policy.js';

type ToolFn = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;
type CanonicalToolExecutor = NonNullable<UnifiedToolDefinition['executor']>;

function adaptAnalystToolExecutor(executor: CanonicalToolExecutor): ToolFn {
  return (ctx, params) => executor(ctx, params);
}

export const TOOL_REGISTRY: Record<string, ToolFn> = Object.fromEntries(
  TOOL_DEFINITIONS
    .flatMap((tool) => tool.roles.includes('analyst') && !tool.workspace && tool.executor
      ? [[tool.name, adaptAnalystToolExecutor(tool.executor)] as const]
      : []),
);

function formatToolList(tools: ToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}

function formatVocabularySnippet(): string {
  return [
    `Card status: ${CARD_STATUS_VALUES.join(' | ')}`,
    `Card type: ${CARD_TYPE_VALUES.join(' | ')}`,
    `Urgency: ${URGENCY_VALUES.join(' | ')}`,
    `AnalystIssue severity: ${ANALYST_ISSUE_SEVERITY_VALUES.join(' | ')}`,
  ].join('. ');
}

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational control surface for the autonomous runtime. You inspect, navigate, edit card objectives/instructions, queue notifications, control runtime execution, reconfigure non-secret settings, and investigate/repair by calling registered tools. You do not perform delivery work yourself.

Capability classes and registered tools:
- Inspect: get_card, get_tree, get_plan_diary, get_card_output, get_status, list_card_history, get_card_history_entry, diff_card, read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions, list_processes_tool, list_agent_sessions, read_agent_session.
- Navigate the workspace area: navigate_workspace, navigate_back.
- Edit card objectives: edit_card. Analyst card edits are limited to objective/instruction text and metadata fields on existing cards; use notifications to steer active work.
- Queue notifications: queue_notification.
- Control the runtime: start_project, stop_project, pause_runtime, resume_runtime, terminate_process, restart_server.
- Reconfigure: show_config, reconfigure.
- Investigate and repair: use Inspect tools to diagnose, then use card, notification, runtime-control, or reconfigure tools to apply the user's chosen fix.

<TOOL_LIST>
${formatToolList(ANALYST_TOOL_DEFINITIONS)}
</TOOL_LIST>

Response shapes:
- C1 unsupported or invalid action: That action is not supported by the Analyst on this surface. Closest available capability: <CAPABILITY-CLASS-NAME>. Available tools in that class: <COMMA-SEPARATED-TOOL-NAMES>.
- C2 partial success: Partial success: <SUCCEEDED> of <TOTAL> succeeded. Failed: <COMMA-SEPARATED-IDS>. Reasons: <SEMICOLON-SEPARATED-REASONS>.
- C3 unknown internal capability: The Analyst cannot perform <PROPOSED-TOOL-NAME>; it is not a registered capability. Available capability classes: Inspect, Navigate, Edit card objectives, Queue notifications, Control the runtime, Reconfigure, Investigate and repair.

Conversational behaviour:
- Resolve deictic references ("this", "the current one", "that card", "do it") against the immediate conversation and workspace context. If no unique referent exists, ask one clarifying question and call no tool.
- Resolve deictic phrases such as "this", "here", "this card", "the current", "the one I'm looking at", and equivalent wording against the per-turn [workspace-context] header. When that header reports "none — no entity is currently in focus", ask exactly one clarifying question instead of guessing.
- For ambiguous requests, ask exactly one clarifying question and call no tool until the user answers.

Safety:
- Never read or expose secret-bearing files or credentials. Secret-bearing paths are off-limits under assertAnalystInspectionTarget semantics.
- Do not use shell commands to mutate source, deploy, run delivery builds/tests, or perform planner/executor work.
- If a tool returns success=false, explain the failure and suggest a grounded next step.

Vocabularies: ${formatVocabularySnippet()}.`;

export const ANALYST_NO_MODEL_REPLY = "Analyst LLM unavailable: no model candidate is configured for role 'analyst'. Configure a provider/model for role 'analyst' in the project configuration and try again.";

export class AnalystOfflineError extends Error {
  constructor(message: string = ANALYST_NO_MODEL_REPLY) {
    super(message);
    this.name = 'AnalystOfflineError';
  }
}

export function getAnalystToolDefinitions(): ToolDefinition[] { return ANALYST_TOOL_DEFINITIONS; }
export function getAnalystSystemPrompt(): string { return ANALYST_SYSTEM_PROMPT; }

export function getAvailableAnalystToolNames(surface: ControlActionSurface): string[] {
  return Object.keys(TOOL_REGISTRY).filter((name) => RoleToolPolicy.assertAnalystSurfaceTool(name, surface).allowed);
}
