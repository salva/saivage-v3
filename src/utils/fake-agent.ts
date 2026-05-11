import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewAssessment, CardStatus, ArtifactRef, AgentMessage } from '../schemas/types.js';
import type { AgentRuntime } from '../agents/agent-runtime.js';
import type {
  PlannerResult,
  ExecutorResult,
  ReviewerResult,
} from '../agents/result-parser.js';

// ── Fake Agent Result Types ──────────────────────────────────

/**
 * Metadata for registering an artifact from a fake executor.
 */
export interface FakeArtifactDef {
  /** Source file path to copy from (absolute or relative to project) */
  sourceFile: string;
  /** Artifact type */
  type: ArtifactRef['type'];
  /** Human-readable description */
  description: string;
  /** Whether to retain the artifact */
  retain: boolean;
}

/**
 * Metadata for registering an attachment from a fake executor.
 */
export interface FakeAttachmentDef {
  /** Source file path to copy from (absolute or relative to project) */
  sourceFile: string;
  /** MIME type */
  mime: string;
  /** Display title */
  title: string;
  /** Optional description */
  description?: string;
}

/**
 * A scripted result returned by a fake executor invocation.
 */
export interface FakeExecutorResult {
  /** ID of the card that was executed */
  card_id: string;
  /** The resulting status: 'done' or 'failed' */
  status: 'done' | 'failed';
  /** Optional error message for failed cards */
  error?: string;
  /** Optional result data */
  result?: Record<string, unknown>;
  /** Artifacts to register on the card after execution */
  artifacts?: FakeArtifactDef[];
  /** Attachments to register on the card after execution */
  attachments?: FakeAttachmentDef[];
}

// ── Remaining types unchanged ────────────────────────────────

/**
 * A scripted result returned by a fake planner invocation.
 * The planner can create cards, update cards, and declare the goal done.
 */
export interface FakePlannerResult {
  /** ID of the plan card this invocation was for */
  plan_card_id: string;
  /** Cards to create as children of this plan's parent */
  created_cards?: Array<{
    id?: string;
    type: string;
    title: string;
    description: string;
    status: CardStatus;
    depends_on: string[];
    priority: number;
    tags?: string[];
  }>;
  /** Cards to update (by ID) */
  updated_cards?: Array<{
    id: string;
    status?: CardStatus;
    title?: string;
    description?: string;
  }>;
  /** Whether the planner declares the goal done (triggers reviewer) */
  declare_done: boolean;
}

/**
 * A scripted result returned by a fake reviewer invocation.
 */
export interface FakeReviewerResult {
  /** The review assessment */
  assessment: ReviewAssessment;
}

// ── Fixture Types ────────────────────────────────────────────

export interface FakeAgentFixture {
  /** Unique fixture name */
  name: string;
  /** Scripted planner results keyed by invocation number (0-based) */
  planner?: FakePlannerResult[];
  /** Scripted executor results keyed by card_id */
  executor?: Record<string, FakeExecutorResult>;
  /** Scripted reviewer results keyed by invocation number (0-based) */
  reviewer?: FakeReviewerResult[];
}

// ── Configuration ────────────────────────────────────────────

export interface FakeAgentConfig {
  /**
   * Mapping from goal ID or card ID to the fixture name that should
   * be used. Also supports a '*' wildcard for default fixtures.
   */
  mapping: Record<string, string>;
  /** Path to the directory containing fixture JSON files */
  fixtureDir: string;
}

// ── Conversion helpers ───────────────────────────────────────

function convertPlannerResult(raw: FakePlannerResult): PlannerResult {
  return {
    plan_card_id: raw.plan_card_id,
    created_cards: (raw.created_cards ?? []).map((c) => ({
      ...c,
      status: c.status as string,
    })),
    updated_cards: (raw.updated_cards ?? []).map((u) => ({
      ...u,
      status: u.status as string | undefined,
    })),
    declare_done: raw.declare_done,
    summary: undefined,
  };
}

function convertExecutorResult(raw: FakeExecutorResult): ExecutorResult {
  return {
    card_id: raw.card_id,
    status: raw.status,
    error: raw.error,
    result: raw.result,
    artifacts: (raw.artifacts ?? []).map((a) => ({
      type: a.type,
      description: a.description,
      retain: a.retain,
      sourceFile: a.sourceFile,
    })),
    attachments: (raw.attachments ?? []).map((a) => ({
      mime: a.mime,
      title: a.title,
      description: a.description,
      sourceFile: a.sourceFile,
    })),
    summary: undefined,
  };
}

function convertReviewerResult(raw: FakeReviewerResult): ReviewerResult {
  return {
    assessment: {
      result: raw.assessment.result,
      summary: raw.assessment.summary,
      achieved: raw.assessment.achieved,
      missing: raw.assessment.missing,
      evidence_card_ids: raw.assessment.evidence_card_ids,
    },
  };
}

// ── FakeAgentAdapter ──────────────────────────────────────────

export class FakeAgentAdapter implements AgentRuntime {
  private config: FakeAgentConfig;
  /** Per-fixture invocation counters */
  private plannerCounters: Map<string, number>;
  private reviewerCounters: Map<string, number>;

  constructor(config: FakeAgentConfig) {
    this.config = config;
    this.plannerCounters = new Map();
    this.reviewerCounters = new Map();
  }

  // ── Fixture Loading ───────────────────────────────────────

  private loadFixture(name: string): FakeAgentFixture {
    const fixturePath = resolve(this.config.fixtureDir, `${name}.json`);
    if (!existsSync(fixturePath)) {
      throw new Error(`FakeAgent fixture not found: ${fixturePath}`);
    }
    const raw = readFileSync(fixturePath, 'utf-8');
    return JSON.parse(raw) as FakeAgentFixture;
  }

  private resolveFixture(id: string): FakeAgentFixture {
    // Look up by exact ID first, then fall back to '*' wildcard
    const name = this.config.mapping[id] ?? this.config.mapping['*'];
    if (!name) {
      throw new Error(
        `No FakeAgent fixture mapping for '${id}' and no '*' wildcard configured.`,
      );
    }
    return this.loadFixture(name);
  }

  // ── Planner ───────────────────────────────────────────────

  /**
   * Return a scripted planner result for the given goal/plan card.
   *
   * Overload 1 (backward compat): called with just goalId, returns FakePlannerResult.
   * Overload 2 (AgentRuntime): called with optional planCardId/systemPrompt/contextMessages,
   *   returns PlannerResult.
   *
   * TypeScript resolves to the first matching overload, so existing callers
   * with just `invokePlanner(goalId)` get FakePlannerResult.
   */
  invokePlanner(goalId: string): FakePlannerResult;
  invokePlanner(
    goalId: string,
    planCardId?: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): PlannerResult;
  invokePlanner(
    goalId: string,
    _planCardId?: string,
    _systemPrompt?: string,
    _contextMessages?: AgentMessage[],
  ): FakePlannerResult | PlannerResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.planner || fixture.planner.length === 0) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' has no planner results.`,
      );
    }
    const count = this.plannerCounters.get(fixture.name) ?? 0;
    if (count >= fixture.planner.length) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' exhausted planner results ` +
          `(called ${count + 1} times, only ${fixture.planner.length} available).`,
      );
    }
    const result = fixture.planner[count];
    this.plannerCounters.set(fixture.name, count + 1);
    return result;
  }

  // ── Executor ──────────────────────────────────────────────

  /**
   * Return a scripted executor result for the given card.
   *
   * Overload 1 (backward compat): called with (cardId, goalId), returns FakeExecutorResult.
   * Overload 2 (AgentRuntime): called with optional systemPrompt/contextMessages,
   *   returns ExecutorResult.
   */
  invokeExecutor(cardId: string, goalId: string): FakeExecutorResult;
  invokeExecutor(
    cardId: string,
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): ExecutorResult;
  invokeExecutor(
    cardId: string,
    goalId: string,
    _systemPrompt?: string,
    _contextMessages?: AgentMessage[],
  ): FakeExecutorResult | ExecutorResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.executor) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' has no executor results.`,
      );
    }
    const result = fixture.executor[cardId];
    if (!result) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' has no executor result for card '${cardId}'.`,
      );
    }
    return result;
  }

  // ── Reviewer ──────────────────────────────────────────────

  /**
   * Return a scripted reviewer assessment for the given goal.
   *
   * Overload 1 (backward compat): called with just goalId, returns FakeReviewerResult.
   * Overload 2 (AgentRuntime): called with optional planCardId/systemPrompt/contextMessages,
   *   returns ReviewerResult.
   */
  invokeReviewer(goalId: string): FakeReviewerResult;
  invokeReviewer(
    goalId: string,
    planCardId?: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): ReviewerResult;
  invokeReviewer(
    goalId: string,
    _planCardId?: string,
    _systemPrompt?: string,
    _contextMessages?: AgentMessage[],
  ): FakeReviewerResult | ReviewerResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.reviewer || fixture.reviewer.length === 0) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' has no reviewer results.`,
      );
    }
    const count = this.reviewerCounters.get(fixture.name) ?? 0;
    if (count >= fixture.reviewer.length) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' exhausted reviewer results ` +
          `(called ${count + 1} times, only ${fixture.reviewer.length} available).`,
      );
    }
    const result = fixture.reviewer[count];
    this.reviewerCounters.set(fixture.name, count + 1);
    return result;
  }

  // ── AgentRuntime helpers (convert old types to new) ───────

  /**
   * Convert a FakePlannerResult to a PlannerResult.
   * Used by callers that need the AgentRuntime-compatible type.
   */
  toPlannerResult(raw: FakePlannerResult): PlannerResult {
    return convertPlannerResult(raw);
  }

  /**
   * Convert a FakeExecutorResult to an ExecutorResult.
   * Used by callers that need the AgentRuntime-compatible type.
   */
  toExecutorResult(raw: FakeExecutorResult): ExecutorResult {
    return convertExecutorResult(raw);
  }

  /**
   * Convert a FakeReviewerResult to a ReviewerResult.
   * Used by callers that need the AgentRuntime-compatible type.
   */
  toReviewerResult(raw: FakeReviewerResult): ReviewerResult {
    return convertReviewerResult(raw);
  }

  // ── Reset ─────────────────────────────────────────────────

  /**
   * Reset all invocation counters (useful between tests).
   */
  reset(): void {
    this.plannerCounters.clear();
    this.reviewerCounters.clear();
  }

  /**
   * Get the current planner invocation count for a goal's fixture.
   */
  getPlannerCount(goalId: string): number {
    const fixture = this.resolveFixture(goalId);
    return this.plannerCounters.get(fixture.name) ?? 0;
  }

  /**
   * Get the current reviewer invocation count for a goal's fixture.
   */
  getReviewerCount(goalId: string): number {
    const fixture = this.resolveFixture(goalId);
    return this.reviewerCounters.get(fixture.name) ?? 0;
  }
}
