import { z } from 'zod';
import type { CardStatus, ArtifactRef, AttachmentRef } from '../schemas/types.js';

// ── Structured Result Types ───────────────────────────────────

// ── Planner Result ────────────────────────────────────────────

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
}

export interface PlannerResult {
  plan_card_id?: string;
  /** Cards to create as children */
  created_cards: PlannerCardCreate[];
  /** Cards to update */
  updated_cards: PlannerCardUpdate[];
  /** Whether the planner declares the goal done */
  declare_done: boolean;
  /** Summary of the planner's reasoning */
  summary?: string;
}

// ── Executor Result ───────────────────────────────────────────

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
  /** Summary of work done */
  summary?: string;
}

// ── Reviewer Result ───────────────────────────────────────────

export interface ReviewerResult {
  assessment: {
    result: 'pass' | 'fail';
    summary: string;
    achieved: string[];
    missing: string[];
    evidence_card_ids: string[];
  };
}

// ── Parse Errors ──────────────────────────────────────────────

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

// ── Zod Schemas for Validation ────────────────────────────────

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
});

const rawPlannerResultSchema = z.object({
  plan_card_id: z.string().optional(),
  created_cards: z.array(plannerCardCreateSchema).optional().default([]),
  updated_cards: z.array(plannerCardUpdateSchema).optional().default([]),
  declare_done: z.boolean().optional().default(false),
  summary: z.string().optional(),
});

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
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(executorArtifactDefSchema).optional().default([]),
  attachments: z.array(executorAttachmentDefSchema).optional().default([]),
  summary: z.string().optional(),
});

const rawReviewerResultSchema = z.object({
  assessment: z.object({
    result: z.enum(['pass', 'fail']),
    summary: z.string(),
    achieved: z.array(z.string()).optional().default([]),
    missing: z.array(z.string()).optional().default([]),
    evidence_card_ids: z.array(z.string()).optional().default([]),
  }),
});

// ── Parsers ───────────────────────────────────────────────────

/**
 * Extract and parse a JSON object from possibly markdown-wrapped text.
 * Looks for JSON objects in code blocks or as raw text.
 */
export function extractJson(raw: string): unknown {
  // Try to find JSON in ```json ... ``` blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue to other strategies
    }
  }

  // Try raw parse of the whole text
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Find first { ... } block in the text
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const jsonStr = raw.slice(firstBrace, lastBrace + 1);
        return JSON.parse(jsonStr);
      } catch {
        // Last resort
      }
    }
  }

  throw new ResultParseError(
    'Could not extract valid JSON from response',
    raw,
    ['No valid JSON object found in response text.'],
  );
}

/**
 * Parse and validate a planner result from raw LLM output.
 *
 * @param raw - Raw text output from the planner agent.
 * @returns A validated PlannerResult.
 * @throws ResultParseError if the output cannot be parsed or validated.
 */
export function parsePlannerResult(raw: string): PlannerResult {
  let obj: unknown;
  try {
    obj = extractJson(raw);
  } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(
      `Failed to extract JSON from planner response: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }

  const parsed = rawPlannerResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ResultParseError(
      `Planner result validation failed:\n${issues.join('\n')}`,
      obj,
      issues,
    );
  }

  return {
    plan_card_id: parsed.data.plan_card_id,
    created_cards: parsed.data.created_cards,
    updated_cards: parsed.data.updated_cards,
    declare_done: parsed.data.declare_done,
    summary: parsed.data.summary,
  };
}

/**
 * Parse and validate an executor result from raw LLM output.
 */
export function parseExecutorResult(raw: string): ExecutorResult {
  let obj: unknown;
  try {
    obj = extractJson(raw);
  } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(
      `Failed to extract JSON from executor response: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }

  const parsed = rawExecutorResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ResultParseError(
      `Executor result validation failed:\n${issues.join('\n')}`,
      obj,
      issues,
    );
  }

  return {
    card_id: parsed.data.card_id ?? '',
    status: parsed.data.status,
    error: parsed.data.error,
    result: parsed.data.result,
    artifacts: parsed.data.artifacts,
    attachments: parsed.data.attachments,
    summary: parsed.data.summary,
  };
}

/**
 * Parse and validate a reviewer result from raw LLM output.
 */
export function parseReviewerResult(raw: string): ReviewerResult {
  let obj: unknown;
  try {
    obj = extractJson(raw);
  } catch (err) {
    if (err instanceof ResultParseError) throw err;
    throw new ResultParseError(
      `Failed to extract JSON from reviewer response: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }

  const parsed = rawReviewerResultSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ResultParseError(
      `Reviewer result validation failed:\n${issues.join('\n')}`,
      obj,
      issues,
    );
  }

  return {
    assessment: {
      result: parsed.data.assessment.result,
      summary: parsed.data.assessment.summary,
      achieved: parsed.data.assessment.achieved,
      missing: parsed.data.assessment.missing,
      evidence_card_ids: parsed.data.assessment.evidence_card_ids,
    },
  };
}

/**
 * Check if an error from result parsing is recoverable
 * (i.e., we can retry the agent invocation).
 */
export function isRecoverableParseError(err: unknown): boolean {
  return err instanceof ResultParseError;
}
