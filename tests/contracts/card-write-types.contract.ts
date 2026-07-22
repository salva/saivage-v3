import type { CardEditPatch, NewChildCardInput, SetStatusTarget } from '../../src/cards/card-api.js';
import type { CardService } from '../../src/cards/card-service.js';
import type { CardRecord } from '../../src/schemas/index.js';
const edit = { title: 'updated', tags: [], priority: 1, urgency: 'high', related: [] } satisfies CardEditPatch;
void edit;
// @ts-expect-error dependencies are immutable after creation
({ depends_on: [] } satisfies CardEditPatch);
// @ts-expect-error notifications have dedicated operations
({ pending_notifications: [] } satisfies CardEditPatch);
// @ts-expect-error lifecycle has dedicated operations
({ lifecycle: { status: 'running', result: null, error: null, completed_at: null } } satisfies CardEditPatch);
// @ts-expect-error children are structurally owned
({ children: [] } satisfies CardEditPatch);
// @ts-expect-error metadata is not planner-editable
({ metadata: null } satisfies CardEditPatch);
// @ts-expect-error terminal companions are lifecycle-owned
({ status_text: 'working' } satisfies CardEditPatch);

const creation = { type: 'code', parent: 'project', title: 'new', brief: 'new', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] } satisfies NewChildCardInput;
void creation;
// @ts-expect-error project creation is bootstrap-owned
({ ...creation, type: 'project' } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply lifecycle
({ ...creation, lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply metadata
({ ...creation, metadata: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply identity
({ ...creation, id: 'card-a' } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply children
({ ...creation, children: [] } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply timestamps
({ ...creation, created_at: '2026-07-20T00:00:00.000Z' } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply versions
({ ...creation, version_seq: 1 } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply subtype
({ ...creation, subtype: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply assignment
({ ...creation, assigned_to: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply metrics
({ ...creation, metrics: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply estimates
({ ...creation, estimate: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply timing
({ ...creation, started_at: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply duration
({ ...creation, duration_ms: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply terminal status text
({ ...creation, status_text: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply terminal status timestamps
({ ...creation, status_text_updated_at: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply status authors
({ ...creation, status_text_author_session_id: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply self reports
({ ...creation, latest_self_report: null } satisfies NewChildCardInput);
// @ts-expect-error creation callers cannot supply notifications
({ ...creation, pending_notifications: [] } satisfies NewChildCardInput);

const status = ['running', 'changed', 'cancelled'] satisfies SetStatusTarget[];
void status;
// @ts-expect-error blocked is activation-outcome-only
('blocked' satisfies SetStatusTarget);
// @ts-expect-error backlog is initial-publication-only
('backlog' satisfies SetStatusTarget);

const complete: CardRecord = { id: 'card-a', type: 'code', children: [], title: 'card', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] };
void complete;
// @ts-expect-error canonical fields cannot be omitted
const incomplete: CardRecord = { id: 'card-a', type: 'code', children: [], title: 'card', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, pending_notifications: [] };
void incomplete;
// @ts-expect-error user is not a card creator
const userCreator: CardRecord = { ...complete, created_by: 'user' };
void userCreator;
// @ts-expect-error running cannot retain a result
const broadRunning: CardRecord = { ...complete, lifecycle: { status: 'running', result: { kind: 'done', summary: 'old' }, error: null, completed_at: null } };
void broadRunning;
// @ts-expect-error running cannot retain an error
const runningError: CardRecord = { ...complete, lifecycle: { status: 'running', result: null, error: 'old', completed_at: null } };
// @ts-expect-error changed cannot retain a result
const changedResult: CardRecord = { ...complete, lifecycle: { status: 'changed', result: { kind: 'failed', summary: 'old' }, error: null, completed_at: null } };
// @ts-expect-error changed cannot retain an error
const changedError: CardRecord = { ...complete, lifecycle: { status: 'changed', result: null, error: 'old', completed_at: null } };
// @ts-expect-error cancelled cards have no completion timestamp
const completedCancellation: CardRecord = { ...complete, lifecycle: { status: 'cancelled', result: null, error: null, completed_at: '2026-07-20T00:00:00.000Z' } };
void runningError; void changedResult; void changedError; void completedCancellation;

// @ts-expect-error subtype is required literal null
const valuedSubtype: CardRecord = { ...complete, subtype: 'legacy' };
// @ts-expect-error assignment is required literal null
const valuedAssignment: CardRecord = { ...complete, assigned_to: 'planner:project' };
// @ts-expect-error metrics are required literal null
const valuedMetrics: CardRecord = { ...complete, metrics: {} };
// @ts-expect-error estimate is required literal null
const valuedEstimate: CardRecord = { ...complete, estimate: 1 };
// @ts-expect-error started_at is required literal null
const valuedStartedAt: CardRecord = { ...complete, started_at: '2026-07-20T00:00:00.000Z' };
// @ts-expect-error duration_ms is required literal null
const valuedDuration: CardRecord = { ...complete, duration_ms: 1 };
// @ts-expect-error status_text_author_session_id is required literal null
const valuedStatusAuthor: CardRecord = { ...complete, status_text_author_session_id: 'planner:project' };
// @ts-expect-error latest_self_report is required literal null
const valuedSelfReport: CardRecord = { ...complete, latest_self_report: { summary: 'old' } };
// @ts-expect-error metadata is required literal null
const valuedMetadata: CardRecord = { ...complete, metadata: {} };
void valuedSubtype; void valuedAssignment; void valuedMetrics; void valuedEstimate; void valuedStartedAt;
void valuedDuration; void valuedStatusAuthor; void valuedSelfReport; void valuedMetadata;

type TerminalOutcomeArguments = Parameters<CardService['commitActivationOutcome']>;
const terminalOutcomeArguments: TerminalOutcomeArguments = ['card-a', { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }, '2026-07-20T00:00:01.000Z'];
// @ts-expect-error terminal publication accepts an activation outcome, not caller-selected lifecycle and companions
const lifecycleShapedTerminalArguments: TerminalOutcomeArguments = ['card-a', { lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-20T00:00:01.000Z' }, status_text: 'done', status_text_updated_at: '2026-07-20T00:00:01.000Z' }, '2026-07-20T00:00:01.000Z'];
// @ts-expect-error the settlement timestamp is a required separate argument
const optionalCompanionTerminalArguments: TerminalOutcomeArguments = ['card-a', { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }];
void terminalOutcomeArguments; void lifecycleShapedTerminalArguments; void optionalCompanionTerminalArguments;
