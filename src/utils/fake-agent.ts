import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewAssessment, CardStatus, ArtifactRef } from '../schemas/types.js';

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

// ── FakeAgentAdapter ──────────────────────────────────────────

export class FakeAgentAdapter {
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
      throw new Error(`No FakeAgent fixture mapping for '${id}' and no '*' wildcard configured.`);
    }
    return this.loadFixture(name);
  }

  // ── Planner ───────────────────────────────────────────────

  /**
   * Return a scripted planner result for the given goal/plan card.
   * Each call increments an invocation counter for the fixture, so
   * successive calls return different results from the fixture's
   * `planner[]` array.
   */
  invokePlanner(goalId: string): FakePlannerResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.planner || fixture.planner.length === 0) {
      throw new Error(`FakeAgent fixture '${fixture.name}' has no planner results.`);
    }
    const count = this.plannerCounters.get(fixture.name) ?? 0;
    if (count >= fixture.planner.length) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' exhausted planner results (called ${count + 1} times, only ${fixture.planner.length} available).`,
      );
    }
    const result = fixture.planner[count];
    this.plannerCounters.set(fixture.name, count + 1);
    return result;
  }

  // ── Executor ──────────────────────────────────────────────

  /**
   * Return a scripted executor result for the given card.
   * Looks up the card_id in the fixture's `executor` map.
   */
  invokeExecutor(cardId: string, goalId: string): FakeExecutorResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.executor) {
      throw new Error(`FakeAgent fixture '${fixture.name}' has no executor results.`);
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
   * Each call increments an invocation counter for the fixture.
   */
  invokeReviewer(goalId: string): FakeReviewerResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.reviewer || fixture.reviewer.length === 0) {
      throw new Error(`FakeAgent fixture '${fixture.name}' has no reviewer results.`);
    }
    const count = this.reviewerCounters.get(fixture.name) ?? 0;
    if (count >= fixture.reviewer.length) {
      throw new Error(
        `FakeAgent fixture '${fixture.name}' exhausted reviewer results (called ${count + 1} times, only ${fixture.reviewer.length} available).`,
      );
    }
    const result = fixture.reviewer[count];
    this.reviewerCounters.set(fixture.name, count + 1);
    return result;
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
