import type { ConversationSessionId } from './conversation-session-id.js';

export const cardTypeValues = ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;
export type CardType = typeof cardTypeValues[number];

export const planningCardTypeValues = ['project', 'goal'] as const satisfies readonly CardType[];
export const terminalCardTypeValues = ['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const satisfies readonly CardType[];

const planningCardTypes: ReadonlySet<CardType> = new Set<CardType>(planningCardTypeValues);
const terminalCardTypes: ReadonlySet<CardType> = new Set<CardType>(terminalCardTypeValues);

export function isPlanningCardType(type: CardType): boolean {
  return planningCardTypes.has(type);
}

export function isTerminalCardType(type: CardType): boolean {
  return terminalCardTypes.has(type);
}

export type PromptCardTypeKey = CardType | 'analyst';
export type PromptRoleKey = 'planner' | 'executor' | 'reviewer' | 'analyst';
export type PromptSlot = readonly [cardType: PromptCardTypeKey, role: PromptRoleKey];

const planningPromptPairs = planningCardTypeValues.flatMap((cardType) => [
  [cardType, 'planner'] as const,
  [cardType, 'reviewer'] as const,
]);
const terminalPromptPairs = terminalCardTypeValues.map((cardType) => [cardType, 'executor'] as const);

export const activePromptPairs = [
  ...planningPromptPairs,
  ...terminalPromptPairs,
  ['analyst', 'analyst'] as const,
] as const satisfies readonly PromptSlot[];

export const cardStatusValues = ['backlog', 'running', 'blocked', 'changed', 'stopped', 'done', 'failed', 'cancelled'] as const;
export type CardStatus = typeof cardStatusValues[number];


export const cardActionValues = ['card.start', 'card.create', 'card.cancel', 'card.delete', 'card.reorder_child'] as const;
export type CardAction = typeof cardActionValues[number];
export type { ActionableErrorEnvelope } from './actionable-error.js';

export const urgencyValues = ['low', 'normal', 'high', 'critical'] as const;
export type Urgency = typeof urgencyValues[number];
export type CreatedBy = 'analyst' | 'planner';
export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';
export type ControlActionSurface = 'web-chat' | 'rest' | 'cli' | 'runtime' | 'web-ui';

import type { CardLifecycleState } from './lifecycle.js';

export interface CardNotification {
  id: string;
  content: string;
  created_at: string;
  source?: string;
}

export interface CardRecord {
  id: string; type: CardType; title: string;
  children: string[];
  subtype: null; tags: string[]; priority: number; urgency: Urgency; created_by: CreatedBy;
  created_at: string; updated_at: string; version_seq: number; assigned_to: null; depends_on: string[]; related: string[];
  lifecycle: CardLifecycleState; metrics: null;
  estimate: null; started_at: null;
  duration_ms: null; status_text: string | null; status_text_updated_at: string | null;
  status_text_author_session_id: null; latest_self_report: null; metadata: null;
  pending_notifications: CardNotification[];
}
export interface CardOperatorSummary {
  blocked: boolean;
  hasError: boolean;
  error: string | null;
  completedAt: string | null;
  stale: boolean;
}
export interface CardView { card: CardRecord; logical_path: string | null; status: CardStatus; parent: string | null; operator_summary: CardOperatorSummary; }
export type CardHistoryKind = 'update' | 'notification_enqueue' | 'notification_remove' | 'status' | 'terminal' | 'child_link' | 'reorder' | 'delete';
export interface CardHistoryEntryBase { entry_id: string; card_id: string; version_seq: number; snapshot: CardRecord; changed_at: string; change_reason: string | null; changed_fields: string[]; change_summary: string; }
export type RuntimeCardHistoryEntry = CardHistoryEntryBase & { kind: Exclude<CardHistoryKind, 'update' | 'delete'>; changed_by_actor: 'runtime'; changed_by_surface: 'runtime' };
export type UpdateCardHistoryEntry = CardHistoryEntryBase & { kind: 'update'; changed_by_actor: 'planner'; changed_by_surface: 'runtime' };
export type DeleteCardHistoryEntry = CardHistoryEntryBase & { kind: 'delete'; changed_by_actor: 'analyst'; changed_by_surface: 'runtime' };
export type CardHistoryEntry = RuntimeCardHistoryEntry | UpdateCardHistoryEntry | DeleteCardHistoryEntry;
export type CardHistoryHeader = CardHistoryEntry extends infer Entry ? Entry extends CardHistoryEntry ? Omit<Entry, 'snapshot'> : never : never;
export interface ControlActionAuditEntry { id: string; actor: NoteAuthor; surface: ControlActionSurface; action: string; target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null; target_id: string | null; params_summary: string; safety_class?: 'read_only' | 'low' | 'high' | 'destructive' | 'deployment'; outcome: 'ok' | 'error' | 'denied'; outcome_summary: string; error?: string; created_at: string; }
export interface ProjectConfig { id: 'project'; name: string; context: string; goals_summary: string; constraints: string[]; planner_enabled: boolean; created_at: string; updated_at: string; }
export const analystIssueSeverityValues = ['info', 'warning', 'blocker'] as const;
export interface AnalystIssue { summary: string; severity?: typeof analystIssueSeverityValues[number]; evidence_path?: string; }
export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed';
export interface ProcessRecord { id: string; card_id: string | null; owner_id: string; command: string; command_hash: string; cwd: string; cwd_canonical: string; status: ProcessStatus; pid?: number | null; started_at: string; started_at_monotonic: number; completed_at?: string | null; exit_code?: number | null; signal?: string | null; terminal_reason?: 'exit' | 'signal' | 'spawn_error' | null; required_for_card_completion: boolean; output_dir: string; stdout_path: string; stderr_path: string; agent_session_id?: string | null; goal_id?: string | null; launch_reason?: string | null; owner_kind: 'agent' | 'operator' | 'runtime'; background_policy?: 'foreground' | null; failure_classification?: 'spawn_error' | null; }
export const agentRoleValues = ['analyst', 'planner', 'executor', 'reviewer'] as const;
export const agentInvocationRoleValues = ['planner', 'executor', 'reviewer'] as const;
export const operationalAgentRoleValues = agentRoleValues;
export type AgentRole = typeof agentRoleValues[number];
export type AgentInvocationRole = typeof agentInvocationRoleValues[number];
export type OperationalAgentRole = typeof operationalAgentRoleValues[number];
export type SessionStatus = 'active' | 'waiting' | 'inactive';
export interface AgentSession { id: string; role: AgentRole; goal_card_id?: string | null; card_id?: string | null; status: SessionStatus; started_at: string; model?: string; }
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind = 'text' | 'activity' | 'tool_call' | 'tool_result' | 'model_issue' | 'model_repair' | 'context_compaction' | 'model_recovered' | 'system_prompt' | 'provider_private';
export interface EntityLink { entity_type: 'card' | 'process' | 'artifact' | 'attachment'; entity_id: string; label?: string; }
export interface OpenAIResponsesProviderProjection { kind: 'openai_responses'; source_input_id: string; private_message_id: string; projection_kind: 'assistant_message' | 'assistant_tool_call'; }
export interface AgentMessage { id: string; session_id: ConversationSessionId; role: MessageRole; kind: MessageKind; content: string; round_id: string; message_index: number; block_index: number; tool?: string; tool_call_id?: string; timestamp: string; links?: EntityLink[]; model_spec?: string; requested_model_spec?: string; provider_projection?: OpenAIResponsesProviderProjection; }
export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'pausing' | 'paused' | 'closing' | 'error';
export interface RuntimeState { status: RuntimeStatus; project_id: 'project'; pid: number; started_at: string; current_card_id: string; updated_at: string; }
export interface DoctorCheck { name: string; passed: boolean; details?: string; }
export interface DoctorIssue { severity: 'error' | 'warning'; message: string; }
export interface DoctorResponse { status: 'ok' | 'issues_found'; checks: DoctorCheck[]; issues: DoctorIssue[]; }
export const skillTargetRoleValues = ['executor', 'reviewer', 'analyst'] as const;
export type SkillTargetRole = typeof skillTargetRoleValues[number];
export interface SkillIndexEntry { name: string; file: string; target_agents: SkillTargetRole[]; }


export { eventKindValues, runtimeEventKindValues, agentEventKindValues, type EventKind } from './event-catalog.js';
export type RuntimeEventKind = import('./event-catalog.js').EventKind;
export type AgentEventKind = import('./event-catalog.js').EventKind;
export type {
  BaseEvent,
  ErrorEvent,
  EventPayloadByKind,
  LoggedEvent,
  LoggedEventByKind,
  McpToolInvocationEvent,
  RuntimeActionableErrorEvent,
  RuntimeDiagnosticEvent,
} from './event-catalog.js';
