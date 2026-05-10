import { z } from 'zod';

// ── Card Types ────────────────────────────────────────────────

export const cardTypeSchema = z.enum([
  'project',
  'goal',
  'plan',
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
]);

export const cardStatusSchema = z.enum([
  'drafting',
  'backlog',
  'active',
  'running',
  'blocked',
  'done',
  'failed',
  'cancelled',
]);

export const urgencySchema = z.enum(['low', 'normal', 'high', 'critical']);

export const createdBySchema = z.enum(['user', 'analyst', 'planner']);

export const artifactRefSchema = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(['model', 'data', 'config', 'log', 'report', 'other']),
  description: z.string(),
  retain: z.boolean(),
  created_at: z.string().datetime(),
});

export const attachmentRefSchema = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  path: z.string().min(1),
  mime: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  created_at: z.string().datetime(),
});

export const cardRecordSchema = z.object({
  id: z.string().min(1),
  type: cardTypeSchema,
  parent: z.string().nullable(),
  depth: z.number().int().min(0),
  title: z.string().min(1),
  description: z.string(),
  status: cardStatusSchema,
  subtype: z.string().nullable().optional(),
  tags: z.array(z.string()),
  priority: z.number().int(),
  urgency: urgencySchema,
  created_by: createdBySchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  assigned_to: z.string().nullable().optional(),
  depends_on: z.array(z.string()),
  blocks: z.array(z.string()),
  related: z.array(z.string()),
  acceptance: z.string(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).nullable().optional(),
  artifacts: z.array(artifactRefSchema),
  attachments: z.array(attachmentRefSchema),
  estimate: z.string().nullable().optional(),
  started_at: z.string().datetime().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
  duration_ms: z.number().int().nonnegative().nullable().optional(),
  error: z.string().nullable().optional(),
  retries: z.number().int().nonnegative(),
});

// ── Project Configuration ────────────────────────────────────

export const projectConfigSchema = z.object({
  id: z.literal('project'),
  name: z.string().min(1),
  context: z.string(),
  goals_summary: z.string(),
  constraints: z.array(z.string()),
  max_goal_depth: z.number().int().positive(),
  planner_enabled: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// ── Plan Diary ───────────────────────────────────────────────

export const diaryKindSchema = z.enum([
  'planner_invocation',
  'planner_decision',
  'card_mutation',
  'review_assessment',
  'failure_handling',
]);

// Forward reference for ReviewAssessment — defined below, used lazily
export const reviewAssessmentSchema: z.ZodType<import('./types.js').ReviewAssessment> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    goal_card_id: z.string().min(1),
    plan_card_id: z.string().min(1),
    reviewer_session_id: z.string().min(1),
    result: z.enum(['pass', 'fail']),
    summary: z.string(),
    achieved: z.array(z.string()),
    missing: z.array(z.string()),
    evidence_card_ids: z.array(z.string()),
    created_at: z.string().datetime(),
  }),
);

export const diaryEntrySchema = z.object({
  id: z.string().min(1),
  plan_card_id: z.string().min(1),
  invocation_id: z.string().min(1),
  kind: diaryKindSchema,
  timestamp: z.string().datetime(),
  input_summary: z.string().optional(),
  decision: z.string().optional(),
  rationale: z.string().optional(),
  created_cards: z.array(z.string()).optional(),
  updated_cards: z.array(z.string()).optional(),
  reviewed_cards: z.array(z.string()).optional(),
  assessment: reviewAssessmentSchema.optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// ── Notes ────────────────────────────────────────────────────

export const noteAuthorSchema = z.enum([
  'user',
  'analyst',
  'planner',
  'executor',
  'reviewer',
  'runtime',
]);

export const noteKindSchema = z.enum([
  'comment',
  'progress',
  'directive',
  'escalation',
]);

export const noteRecordSchema = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  author: noteAuthorSchema,
  timestamp: z.string().datetime(),
  content: z.string(),
  kind: noteKindSchema,
  handled: z.boolean(),
  handled_at: z.string().datetime().nullable().optional(),
});

// ── Process ──────────────────────────────────────────────────

export const processStatusSchema = z.enum([
  'running',
  'exited',
  'failed',
  'killed',
]);

export const processRecordSchema = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  status: processStatusSchema,
  pid: z.number().int().nullable().optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable().optional(),
  exit_code: z.number().int().nullable().optional(),
  required_for_card_completion: z.boolean(),
  output_dir: z.string().min(1),
  stdout_path: z.string().min(1),
  stderr_path: z.string().min(1),
  combined_log_path: z.string().min(1),
});

// ── Agent Session & Messages ─────────────────────────────────

export const agentRoleSchema = z.enum([
  'analyst',
  'planner',
  'executor',
  'reviewer',
  'content_supervisor',
]);

export const sessionStatusSchema = z.enum(['active', 'done', 'failed']);

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  role: agentRoleSchema,
  goal_card_id: z.string().nullable().optional(),
  card_id: z.string().nullable().optional(),
  status: sessionStatusSchema,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable().optional(),
  model: z.string().optional(),
});

export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

export const messageKindSchema = z.enum([
  'text',
  'activity',
  'tool_call',
  'tool_result',
  'tool_error',
  'model_issue',
  'model_repair',
  'model_recovered',
]);

export const entityLinkSchema = z.object({
  entity_type: z.enum(['card', 'process', 'artifact', 'attachment', 'quarantine']),
  entity_id: z.string().min(1),
  label: z.string().optional(),
});

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: messageRoleSchema,
  kind: messageKindSchema,
  content: z.string(),
  tool: z.string().optional(),
  timestamp: z.string().datetime(),
  links: z.array(entityLinkSchema).optional(),
});

// ── Runtime State ────────────────────────────────────────────

export const runtimeStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'error',
]);

export const runtimeStateSchema = z.object({
  status: runtimeStatusSchema,
  project_id: z.literal('project'),
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
  current_card_id: z.string().nullable().optional(),
  current_agent_session_id: z.string().nullable().optional(),
  paused: z.boolean(),
  paused_at: z.string().datetime().nullable().optional(),
  queue: z.array(z.string()),
  running_processes: z.array(z.string()),
  updated_at: z.string().datetime(),
});

// ── Content Supervision ──────────────────────────────────────

export const sourceKindSchema = z.enum([
  'command_output',
  'file',
  'download',
  'web',
  'api',
  'tool',
]);

export const reviewStatusSchema = z.enum(['passed', 'blocked', 'sanitized']);

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);

export const contentReviewSchema = z.object({
  id: z.string().min(1),
  source_kind: sourceKindSchema,
  source_ref: z.string().min(1),
  status: reviewStatusSchema,
  summary: z.string(),
  risk: riskLevelSchema,
  quarantine_id: z.string().nullable().optional(),
  created_at: z.string().datetime(),
});

export const quarantineItemSchema = z.object({
  id: z.string().min(1),
  review_id: z.string().min(1),
  source_ref: z.string().min(1),
  stored_path: z.string().min(1),
  reason: z.string(),
  created_at: z.string().datetime(),
});
