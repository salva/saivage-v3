import { z } from 'zod';
import type { ArtifactRef } from '../schemas/types.js';
import type { AgentMessage } from '../schemas/types.js';

export interface PlannerCardCreate {
  type: string;
  title: string;
  description: string;
  status: string;
  depends_on: string[];
  priority: number;
  tags?: string[];
  id?: string;
}

export interface PlannerCardUpdate {
  id: string;
  status?: string;
  title?: string;
  description?: string;
  acceptance?: string;
}

export type PlannerStatus = 'continue' | 'done' | 'blocked';

export interface PlannerResult {
  status: PlannerStatus;
  blocked_reason?: string;
  created_cards: PlannerCardCreate[];
  updated_cards: PlannerCardUpdate[];
  summary?: string;
}

export interface ExecutorArtifactDef {
  type: ArtifactRef['type'];
  description: string;
  retain: boolean;
  sourceFile?: string;
  path?: string;
}

export interface ExecutorAttachmentDef {
  mime: string;
  title: string;
  description?: string;
  sourceFile?: string;
  path?: string;
}

export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  error?: string;
  result?: Record<string, unknown>;
  artifacts: ExecutorArtifactDef[];
  attachments: ExecutorAttachmentDef[];
  summary?: string;
  status_text: string;
}

export interface ExecutorFallbackContext {
  cardId: string;
  sessionMessages: AgentMessage[];
}

export interface ReviewerIssue { summary: string; severity: 'info' | 'warning' | 'blocker'; evidence_card_id?: string; recommendation?: string; }
export interface ReviewerResult {
  assessment: {
    result: 'pass' | 'needs_corrections';
    summary: string;
    achieved: string[];
    issues: ReviewerIssue[];
    evidence_card_ids: string[];
  };
}

export class ResultParseError extends Error {
  public readonly partial: unknown;
  public readonly issues: string[];

  constructor(message: string, partial: unknown, issues: string[] = []) {
    super(message);
    this.name = 'ResultParseError';
    this.partial = partial;
    this.issues = issues;
  }
}

const plannerCardCreateSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: z.string(),
  depends_on: z.array(z.string()),
  priority: z.number().int(),
  tags: z.array(z.string()).optional(),
  id: z.string().optional(),
});

const plannerCardUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptance: z.string().optional(),
});

const rawPlannerResultSchema = z.object({
  status: z.enum(['continue', 'done', 'blocked']),
  blocked_reason: z.string().nullable().optional(),
  created_cards: z.array(plannerCardCreateSchema).optional().default([]),
  updated_cards: z.array(plannerCardUpdateSchema).optional().default([]),
  summary: z.string().optional(),
}).strict();

const executorArtifactDefSchema = z.object({
  type: z.enum(['model', 'data', 'config', 'log', 'report', 'other']),
  description: z.string(),
  retain: z.boolean(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

const executorAttachmentDefSchema = z.object({
  mime: z.string(),
  title: z.string(),
  description: z.string().optional(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

const rawExecutorResultSchema = z.object({
  card_id: z.string().optional(),
  status: z.enum(['done', 'failed']),
  status_text: z.string().min(1),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(executorArtifactDefSchema).optional().default([]),
  attachments: z.array(executorAttachmentDefSchema).optional().default([]),
  summary: z.string().optional(),
});

const rawReviewerResultSchema = z.object({
  assessment: z.object({
    result: z.enum(['pass', 'needs_corrections', 'fail']),
    summary: z.string(),
    achieved: z.array(z.string()).optional().default([]),
    issues: z.array(z.object({ summary: z.string(), severity: z.enum(['info', 'warning', 'blocker']), evidence_card_id: z.string().optional(), recommendation: z.string().optional() })).optional().default([]),
    evidence_card_ids: z.array(z.string()).optional().default([]),
    missing: z.array(z.string()).optional().default([]),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectWorkspaceToolEvidence(messages: AgentMessage[]): {
  generatedFiles: string[];
  verifiedCommands: Array<{ command?: string; id?: string; status?: string; exitCode?: number | null; timedOut?: boolean }>;
  toolErrors: string[];
  toolActivityCount: number;
} {
  const generatedFiles = new Set<string>();
  const verifiedCommands: Array<{ command?: string; id?: string; status?: string; exitCode?: number | null; timedOut?: boolean }> = [];
  const toolErrors: string[] = [];
  let toolActivityCount = 0;

  for (const message of messages) {
    if (!message.tool) continue;

    if (message.kind === 'tool_result') {
      toolActivityCount++;
      const parsed = parseJsonObject(message.content);
      if (message.tool === 'write_project_file' && parsed && typeof parsed.path === 'string') {
        generatedFiles.add(parsed.path);
      }
      if (message.tool === 'run_project_command' && parsed) {
        verifiedCommands.push({
          command: typeof parsed.command === 'string' ? parsed.command : undefined,
          id: typeof parsed.id === 'string' ? parsed.id : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          exitCode: typeof parsed.exitCode === 'number' || parsed.exitCode === null ? parsed.exitCode as number | null : undefined,
          timedOut: typeof parsed.timedOut === 'boolean' ? parsed.timedOut : undefined,
        });
      }
    }

    if (message.kind === 'tool_error') {
      toolErrors.push(`${message.tool}: ${message.content}`);
    }
  }

  return {
    generatedFiles: [...generatedFiles],
    verifiedCommands,
    toolErrors,
    toolActivityCount,
  };
}

function extractPartialExecutorResult(raw: string): Partial<ExecutorResult> {
  try {
    const obj = extractJson(raw);
    if (!isRecord(obj)) return {};

    const artifacts = Array.isArray(obj.artifacts)
      ? obj.artifacts.map((item) => executorArtifactDefSchema.safeParse(item)).filter((result) => result.success).map((result) => result.data)
      : [];
    const attachments = Array.isArray(obj.attachments)
      ? obj.attachments.map((item) => executorAttachmentDefSchema.safeParse(item)).filter((result) => result.success).map((result) => result.data)
      : [];

    return {
      card_id: typeof obj.card_id === 'string' ? obj.card_id : undefined,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      result: isRecord(obj.result) ? obj.result : undefined,
      artifacts,
      attachments,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      status_text: typeof obj.status_text === 'string' ? obj.status_text : undefined,
    };
  } catch {
    return {};
  }
}

export function buildExecutorFallbackResult(raw: string, context: ExecutorFallbackContext): ExecutorResult | null {
  const evidence = collectWorkspaceToolEvidence(context.sessionMessages);
  const partial = extractPartialExecutorResult(raw);
  const artifactPaths = new Set((partial.artifacts ?? []).map((artifact) => artifact.sourceFile ?? artifact.path).filter((path): path is string => Boolean(path)));
  for (const file of evidence.generatedFiles) artifactPaths.add(file);

  const generatedFileArtifacts: ExecutorArtifactDef[] = evidence.generatedFiles
    .filter((file) => !(partial.artifacts ?? []).some((artifact) => artifact.sourceFile === file || artifact.path === file))
    .map((file) => ({ type: 'other', description: `Generated file: ${file}`, retain: true, sourceFile: file, path: file }));

  const hadEvidence = evidence.toolActivityCount > 0 || evidence.generatedFiles.length > 0 || evidence.verifiedCommands.length > 0 || (partial.artifacts?.length ?? 0) > 0 || (partial.attachments?.length ?? 0) > 0;
  if (!hadEvidence) return null;

  const verification = evidence.verifiedCommands.map((command, index) => ({
    command: command.command ?? `tool-call-${index + 1}`,
    process_id: command.id ?? null,
    status: command.status ?? null,
    exit_code: command.exitCode ?? null,
    timed_out: command.timedOut ?? null,
  }));

  const parseFailure = {
    message: 'Executor final response was malformed or missing required status; preserved tool evidence via fallback result.',
    raw_response: raw,
  };
  const toolErrors = evidence.toolErrors;
  const error = partial.error ?? toolErrors[0] ?? parseFailure.message;

  return {
    card_id: partial.card_id ?? context.cardId,
    status: 'failed',
    status_text: partial.status_text ?? parseFailure.message,
    error,
    summary: partial.summary ?? parseFailure.message,
    artifacts: [...(partial.artifacts ?? []), ...generatedFileArtifacts],
    attachments: partial.attachments ?? [],
    result: {
      ...(partial.result ?? {}),
      generated_files: evidence.generatedFiles,
      verification_commands: verification,
      artifact_paths: [...artifactPaths],
      tool_errors: toolErrors,
      parse_failure: parseFailure,
    },
  };
}

export function extractJson(raw: string): unknown {
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch {}
  }
  try {
    return JSON.parse(raw.trim());
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch {}
    }
  }
  throw new ResultParseError('Could not extract valid JSON from response', raw, ['No valid JSON object found in response text.']);
}

export function parsePlannerResult(raw: string): PlannerResult {
  let obj: unknown;
  try { obj = extractJson(raw); } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(`Failed to extract JSON from planner response: ${err instanceof Error ? err.message : String(err)}`, raw);
  }
  const parsed = rawPlannerResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ResultParseError(`Planner result validation failed:\n${issues.join('\n')}`, obj, issues);
  }
  return { status: parsed.data.status, blocked_reason: parsed.data.blocked_reason ?? undefined, created_cards: parsed.data.created_cards, updated_cards: parsed.data.updated_cards, summary: parsed.data.summary };
}

export function parseExecutorResult(raw: string): ExecutorResult {
  let obj: unknown;
  try { obj = extractJson(raw); } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(`Failed to extract JSON from executor response: ${err instanceof Error ? err.message : String(err)}`, raw);
  }
  const parsed = rawExecutorResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ResultParseError(`Executor result validation failed:\n${issues.join('\n')}`, obj, issues);
  }
  return {
    card_id: parsed.data.card_id ?? '',
    status: parsed.data.status,
    status_text: parsed.data.status_text,
    error: parsed.data.error,
    result: parsed.data.result,
    artifacts: parsed.data.artifacts,
    attachments: parsed.data.attachments,
    summary: parsed.data.summary,
  };
}

export function parseReviewerResult(raw: string): ReviewerResult {
  let obj: unknown;
  try { obj = extractJson(raw); } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(`Failed to extract JSON from reviewer response: ${err instanceof Error ? err.message : String(err)}`, raw);
  }
  const parsed = rawReviewerResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ResultParseError(`Reviewer result validation failed:\n${issues.join('\n')}`, obj, issues);
  }
  const issues = parsed.data.assessment.issues.length > 0
    ? parsed.data.assessment.issues
    : parsed.data.assessment.missing.map((summary) => ({ summary, severity: 'blocker' as const }));
  return {
    assessment: {
      result: parsed.data.assessment.result === 'fail' ? 'needs_corrections' : parsed.data.assessment.result,
      summary: parsed.data.assessment.summary,
      achieved: parsed.data.assessment.achieved,
      issues,
      evidence_card_ids: parsed.data.assessment.evidence_card_ids,
    },
  };
}

export function isRecoverableParseError(err: unknown): boolean {
  return err instanceof ResultParseError;
}
