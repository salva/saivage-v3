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

export const cardStatusValues = ['backlog', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled'] as const;
export type CardStatus = typeof cardStatusValues[number];


export const cardActionValues = ['card.start', 'card.create', 'card.cancel', 'card.delete', 'card.restart', 'card.reorder_child'] as const;
export type CardAction = typeof cardActionValues[number];
export type RuntimeDispatchOwnership =
  | { kind: 'direct'; source: 'project_root' | 'operator' | 'startup_repair' }
  | { kind: 'activation'; parent_card_id: string; parent_tool_call: { session_id: string; source_input_id: string; tool_call_id: string } };
export interface ActionableErrorEnvelope { code: string; message: string; acceptedValues?: string[]; currentState?: Record<string, unknown>; nextAction: string; docsRef?: string; runId?: string | null; sessionId?: string | null; cardId?: string | null; parentCardId?: string | null; childCardId?: string | null; }

export const urgencyValues = ['low', 'normal', 'high', 'critical'] as const;
export type Urgency = typeof urgencyValues[number];
export type CreatedBy = 'user' | 'analyst' | 'planner';
export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';
export type ControlActionSurface = 'web-chat' | 'telegram' | 'rest' | 'cli' | 'runtime' | 'web-ui';

export interface CardMetadata { [key: string]: unknown; }
import type { CardLifecycleState } from './lifecycle.js';

export interface CardNotification {
  id: string;
  content: string;
  created_at: string;
  source?: string;
}

export interface CardRecord {
  id: string; type: CardType; parent: string | null; depth: number; position: number; title: string; status: CardStatus;
  subtype?: string | null; tags: string[]; priority: number; urgency: Urgency; created_by: CreatedBy;
  created_at: string; updated_at: string; version_seq: number; assigned_to?: string | null; depends_on: string[]; related: string[];
  lifecycle: CardLifecycleState; metrics?: Record<string, number | string | boolean | null> | null;
  estimate?: string | null; started_at?: string | null;
  duration_ms?: number | null; status_text?: string | null; status_text_updated_at?: string | null;
  status_text_author_session_id?: string | null; latest_self_report?: Record<string, unknown> | null; metadata?: CardMetadata | null; allowedActions?: CardAction[];
  pending_notifications: CardNotification[];
}
export interface CardOperatorSummary {
  lifecycleStatus: CardStatus;
  terminal: boolean;
  blocked: boolean;
  hasError: boolean;
  error: string | null;
  completedAt: string | null;
  stale: boolean;
  actionCount: number;
}
export interface CardView extends CardRecord { display_path: string | null; operator_summary: CardOperatorSummary; }
export interface CardRefView { id: string; display_path: string | null; title: string | null; missing?: boolean; }
export type CardHistoryKind = 'update' | 'status' | 'mutate' | 'depends' | 'delete' | 'archive';
export interface CardHistoryEntry { entry_id: string; kind: CardHistoryKind; card_id: string; version_seq: number; snapshot: CardRecord; changed_at: string; changed_by_actor: NoteAuthor; changed_by_surface: ControlActionSurface; change_reason: string | null; changed_fields: string[]; change_summary: string; }
export type CardHistoryHeader = Omit<CardHistoryEntry, 'snapshot'>;
export interface ControlActionAuditEntry { id: string; actor: NoteAuthor; surface: ControlActionSurface; action: string; target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null; target_id: string | null; params_summary: string; safety_class?: 'read_only' | 'low' | 'high' | 'destructive' | 'deployment'; outcome: 'ok' | 'error' | 'denied'; outcome_summary: string; error?: string; created_at: string; }
export interface ProjectConfig { id: 'project'; name: string; context: string; goals_summary: string; constraints: string[]; planner_enabled: boolean; created_at: string; updated_at: string; }
export const analystIssueSeverityValues = ['info', 'warning', 'blocker'] as const;
export interface AnalystIssue { summary: string; severity?: typeof analystIssueSeverityValues[number]; evidence_path?: string; }
export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed';
export interface ProcessRecord { id: string; card_id: string | null; owner_id: string; command: string; command_hash: string; cwd: string; cwd_canonical: string; status: ProcessStatus; pid?: number | null; started_at: string; started_at_monotonic: number; completed_at?: string | null; exit_code?: number | null; signal?: string | null; terminal_reason?: 'exit' | 'signal' | 'spawn_error' | null; required_for_card_completion: boolean; output_dir: string; stdout_path: string; stderr_path: string; agent_session_id?: string | null; goal_id?: string | null; launch_reason?: string | null; owner_kind: 'agent' | 'operator' | 'runtime'; background_policy?: 'foreground' | null; failure_classification?: 'spawn_error' | null; }
export const agentRoleValues = ['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor'] as const;
export const agentInvocationRoleValues = ['planner', 'executor', 'reviewer'] as const;
export const operationalAgentRoleValues = ['planner', 'executor', 'reviewer', 'analyst'] as const;
export type AgentRole = typeof agentRoleValues[number];
export type AgentInvocationRole = typeof agentInvocationRoleValues[number];
export type OperationalAgentRole = typeof operationalAgentRoleValues[number];
export type SessionStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';
export interface AgentSession { id: string; role: AgentRole; goal_card_id?: string | null; card_id?: string | null; status: SessionStatus; started_at: string; completed_at?: string | null; model?: string; }
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind = 'text' | 'activity' | 'tool_call' | 'tool_result' | 'tool_error' | 'model_issue' | 'model_repair' | 'context_compaction' | 'model_recovered' | 'system_prompt' | 'provider_private';
export interface EntityLink { entity_type: 'card' | 'process' | 'artifact' | 'attachment'; entity_id: string; label?: string; }
export interface OpenAIResponsesProviderProjection { kind: 'openai_responses'; source_input_id: string; private_message_id: string; projection_kind: 'assistant_message' | 'assistant_tool_call'; }
export interface AgentMessage { id: string; session_id: string; role: MessageRole; kind: MessageKind; content: string; round_id: string; message_index: number; block_index: number; tool?: string; tool_call_id?: string; timestamp: string; links?: EntityLink[]; model_spec?: string; requested_model_spec?: string; provider_projection?: OpenAIResponsesProviderProjection; }
export interface ToolErrorAgentMessage extends AgentMessage { kind: 'tool_error'; role: 'tool' | 'system'; tool: string; tool_call_id: string; }
export type ActivationCompletionOutcome = 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
export interface ActivationCompletionEnvelopeV1 { kind: 'activate_card_completion'; version: 1; child_card_id: string; outcome: ActivationCompletionOutcome; summary: string; result?: Record<string, unknown> | null; evidence_card_ids?: string[]; error?: string | null; completed_by_session_id?: string | null; success: boolean; cardId: string; failure_kind?: string; }
export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'pausing' | 'paused' | 'closing' | 'error';
export type RuntimeRunStatus = RuntimeStatus | 'stopped' | 'cancelled';
export type ActiveCardRunRuntimeStatus = 'starting' | 'running' | 'pausing' | 'paused' | 'closing';
export type ActiveCardRunPhase = 'planner' | 'executor' | 'reviewer';
export interface ActiveCardRun { card_id: string; card_type: CardType; ownership: RuntimeDispatchOwnership; runtime_status: ActiveCardRunRuntimeStatus; phase: ActiveCardRunPhase; caller_session_id: string | null; caller_tool_call_id: string | null; planner_session_id?: string | null; executor_session_id?: string | null; reviewer_session_id?: string | null; started_at: string; last_turn_at: string; }
export interface ProjectRunCompletedPayload { project_card_id: string; result: 'done' | 'failed' | 'blocked'; summary: string; failure_kind?: string; blocked_reason?: string; }
export interface HandoffSummary { session_id: string; role: AgentRole; last_action: string; next_action: string; context_summary: string; }
export interface RuntimeState { status: RuntimeStatus; project_id: 'project'; pid: number; started_at: string; active_card_run: ActiveCardRun | null; updated_at: string; last_tick_at?: string | null; }
export type SourceKind = 'command_output' | 'file' | 'download' | 'web' | 'api' | 'tool';
export type ReviewStatus = 'passed' | 'blocked' | 'sanitized';
export type RiskLevel = 'low' | 'medium' | 'high';
export interface ContentReview { id: string; source_kind: SourceKind; source_ref: string; status: ReviewStatus; summary: string; risk: RiskLevel; created_at: string; }
export interface DoctorCheck { name: string; passed: boolean; details?: string; }
export interface DoctorIssue { severity: 'error' | 'warning'; message: string; }
export interface DoctorResponse { status: 'ok' | 'issues_found'; checks: DoctorCheck[]; issues: DoctorIssue[]; }
export interface SupervisionStats { total: number; blocked: number; passed: number; sanitized: number; byRisk: Record<string, number>; bySourceKind: Record<string, number>; }
export interface SupervisionResponse { reviews: ContentReview[]; stats: SupervisionStats; }
export type TriggerType = 'keyword' | 'tool' | 'path' | 'tag';
export interface SkillTrigger { type: TriggerType; pattern: string; }
export interface SkillIndexEntry { name: string; file: string; target_agents: AgentRole[]; triggers: SkillTrigger[]; updated_at: string; }


import type { EventKind } from './event-catalog.js';
export { eventKindValues, runtimeEventKindValues, agentEventKindValues, type EventKind } from './event-catalog.js';
export type RuntimeEventKind = EventKind;
export type AgentEventKind = EventKind;
export interface BaseEvent { id: string; kind: EventKind; timestamp: string; session_id?: string; goal_id?: string; card_id?: string; }
export interface RuntimeDiagnosticEvent extends BaseEvent { kind: 'runtime_diagnostic'; goal_id?: string; card_id?: string; phase?: string; error_message: string; error_name?: string; metadata?: Record<string, unknown>; }
export interface RuntimeActionableErrorEvent extends BaseEvent { kind: 'runtime_actionable_error'; actionable_error: ActionableErrorEnvelope; }
export interface SubscriberErrorEvent extends BaseEvent { kind: 'subscriber_error'; subscription_id: string; source_kind: string; error_message: string; error_name?: string; timed_out?: boolean; }
export interface CardHistoryAppendedEvent extends BaseEvent { kind: 'card_history_appended'; entry_id: string; entry_kind: CardHistoryKind; card_id: string; version_seq: number; changed_fields: string[]; changed_at: string; }
export interface NotificationAddedEvent extends Omit<BaseEvent, 'session_id'> { kind: 'notification_added'; session_id: string | null; notification_kind: string; }
export interface ControlActionRecordedEvent extends BaseEvent { kind: 'control_action_recorded'; id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; created_at: string; actor?: string; surface?: string; }
export interface AnalystToolInvokedEvent extends BaseEvent { kind: 'analyst_tool_invoked'; sessionId: string; tool: string; success: boolean; summary: string; classified_as?: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; }
export interface McpToolInvocationEvent extends BaseEvent { kind: 'mcp_tool_invocation'; server: string; tool: string; success: boolean; duration_ms: number; error?: string; }
export type LoggedEvent = RuntimeDiagnosticEvent | RuntimeActionableErrorEvent | SubscriberErrorEvent | CardHistoryAppendedEvent | NotificationAddedEvent | ControlActionRecordedEvent | AnalystToolInvokedEvent | McpToolInvocationEvent;

export type LoggedEventByKind = { [K in EventKind]: Extract<LoggedEvent, { kind: K }> };
export type EventPayloadByKind = { [K in EventKind]: Omit<LoggedEventByKind[K], keyof BaseEvent | 'kind'> };
