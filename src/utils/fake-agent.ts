import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewAssessment, CardStatus, ArtifactRef, AgentMessage, HandoffSummary } from '../schemas/types.js';
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

interface FakeActiveSession {
  sessionId: string;
  role: 'planner' | 'executor' | 'reviewer';
  goalId: string;
  cardId: string | null;
  lastAction: string;
  nextAction: string;
  contextSummary: string;
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
  private activeSessions: Map<string, FakeActiveSession>;
  private cancelledSessions: Set<string>;
  private sessionCounter: number;

  constructor(config: FakeAgentConfig) {
    this.config = config;
    this.plannerCounters = new Map();
    this.reviewerCounters = new Map();
    this.activeSessions = new Map();
    this.cancelledSessions = new Set();
    this.sessionCounter = 0;
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

  private nextSessionId(role: 'planner' | 'executor' | 'reviewer'): string {
    this.sessionCounter += 1;
    return `fake-${role}-${this.sessionCounter}`;
  }

  private registerSession(
    role: 'planner' | 'executor' | 'reviewer',
    goalId: string,
    cardId: string | null,
    nextAction: string,
  ): string {
    const sessionId = this.nextSessionId(role);
    this.activeSessions.set(sessionId, {
      sessionId,
      role,
      goalId,
      cardId,
      lastAction: 'Session started',
      nextAction,
      contextSummary: `Goal: ${goalId}, Card: ${cardId ?? 'N/A'}`,
    });
    this.cancelledSessions.delete(sessionId);
    return sessionId;
  }

  private completeSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.cancelledSessions.delete(sessionId);
  }

  // ── Session Cancellation ───────────────────────────────────

  cancelSession(sessionId: string): boolean {
    if (!this.activeSessions.has(sessionId)) {
      return false;
    }
    this.cancelledSessions.add(sessionId);
    this.activeSessions.delete(sessionId);
    return true;
  }

  forceCancelSession(sessionId: string): boolean {
    const existed = this.activeSessions.has(sessionId);
    this.cancelledSessions.add(sessionId);
    this.activeSessions.delete(sessionId);
    return existed;
  }

  // ── Handoff Summary Stubs ─────────────────────────────────

  getHandoffSummary(sessionId: string): HandoffSummary | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    return {
      session_id: session.sessionId,
      role: session.role,
      last_action: session.lastAction,
      next_action: session.nextAction,
      context_summary: session.contextSummary,
    };
  }

  getActiveSessionHandoffs(): HandoffSummary[] {
    return Array.from(this.activeSessions.values()).map((session) => ({
      session_id: session.sessionId,
      role: session.role,
      last_action: session.lastAction,
      next_action: session.nextAction,
      context_summary: session.contextSummary,
    }));
  }

  // ── Planner ───────────────────────────────────────────────

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

    const sessionId = this.registerSession('planner', goalId, null, `Planning goal ${goalId}`);
    try {
      if (this.cancelledSessions.has(sessionId)) {
        throw new Error(`Fake planner session cancelled: ${sessionId}`);
      }
      const result = fixture.planner[count];
      this.plannerCounters.set(fixture.name, count + 1);
      return result;
    } finally {
      this.completeSession(sessionId);
    }
  }

  // ── Executor ──────────────────────────────────────────────

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

    const sessionId = this.registerSession('executor', goalId, cardId, `Executing card ${cardId}`);
    try {
      if (this.cancelledSessions.has(sessionId)) {
        throw new Error(`Fake executor session cancelled: ${sessionId}`);
      }
      const result = fixture.executor[cardId];
      if (!result) {
        throw new Error(
          `FakeAgent fixture '${fixture.name}' has no executor result for card '${cardId}'.`,
        );
      }
      return result;
    } finally {
      this.completeSession(sessionId);
    }
  }

  // ── Reviewer ──────────────────────────────────────────────

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

    const sessionId = this.registerSession('reviewer', goalId, null, `Reviewing goal ${goalId}`);
    try {
      if (this.cancelledSessions.has(sessionId)) {
        throw new Error(`Fake reviewer session cancelled: ${sessionId}`);
      }
      const result = fixture.reviewer[count];
      this.reviewerCounters.set(fixture.name, count + 1);
      return result;
    } finally {
      this.completeSession(sessionId);
    }
  }

  // ── AgentRuntime helpers (convert old types to new) ───────

  toPlannerResult(raw: FakePlannerResult): PlannerResult {
    return convertPlannerResult(raw);
  }

  toExecutorResult(raw: FakeExecutorResult): ExecutorResult {
    return convertExecutorResult(raw);
  }

  toReviewerResult(raw: FakeReviewerResult): ReviewerResult {
    return convertReviewerResult(raw);
  }

  // ── Reset ─────────────────────────────────────────────────

  reset(): void {
    this.plannerCounters.clear();
    this.reviewerCounters.clear();
    this.activeSessions.clear();
    this.cancelledSessions.clear();
    this.sessionCounter = 0;
  }

  getPlannerCount(goalId: string): number {
    const fixture = this.resolveFixture(goalId);
    return this.plannerCounters.get(fixture.name) ?? 0;
  }

  getReviewerCount(goalId: string): number {
    const fixture = this.resolveFixture(goalId);
    return this.reviewerCounters.get(fixture.name) ?? 0;
  }
}
