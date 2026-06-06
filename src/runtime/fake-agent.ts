import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewAssessment, ArtifactRef, AgentMessage, HandoffSummary, AgentSession } from '../schemas/index.js';
import type { AgentExecutionPort, PlannerInvocationRequest, ExecutorInvocationRequest, ReviewerInvocationRequest, SessionReinvokeRequest, RuntimeActivationLedgerPort } from '../contracts/index.js';
import { completeSession, createSession, markSessionWaiting } from './session-persistence.js';
import type { SessionStamper } from './session-stamper.js';
import type { PlannerResult, ExecutorResult, ReviewerResult, PlannerStatus, ExecutorFallbackReason } from '../contracts/index.js';

export interface FakeArtifactDef {
  sourceFile: string;
  type: ArtifactRef['type'];
  description: string;
  retain: boolean;
}

export interface FakeAttachmentDef {
  sourceFile: string;
  mime: string;
  title: string;
  description?: string;
}

export interface FakeExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  status_text: string;
  error?: string;
  result?: Record<string, unknown>;
  artifacts?: FakeArtifactDef[];
  attachments?: FakeAttachmentDef[];
  fallback_with_evidence?: { reason: ExecutorFallbackReason } | null;
}

export interface FakePlannerResult {
  status: PlannerStatus;
  blocked_reason?: string;
  summary?: string;
}

export interface FakeReviewerResult { assessment: ReviewAssessment; }
export interface FakeAgentFixture { name: string; planner?: FakePlannerResult[]; executor?: Record<string, FakeExecutorResult>; reviewer?: FakeReviewerResult[]; }
export interface FakeAgentConfig { mapping: Record<string, string>; fixtureDir: string; saivageDir?: string; activationLedger?: RuntimeActivationLedgerPort; sessionStamper?: SessionStamper; }
interface FakeActiveSession { sessionId: string; role: 'planner' | 'executor' | 'reviewer'; goalId: string; cardId: string | null; lastAction: string; nextAction: string; contextSummary: string; }

function convertPlannerResult(raw: FakePlannerResult): PlannerResult {
  return { status: raw.status, blocked_reason: raw.blocked_reason, summary: raw.summary };
}
function convertExecutorResult(raw: FakeExecutorResult): ExecutorResult {
  return { card_id: raw.card_id, status: raw.status, status_text: raw.status_text, error: raw.error, result: raw.result, artifacts: (raw.artifacts ?? []).map((a) => ({ type: a.type, description: a.description, retain: a.retain, sourceFile: a.sourceFile })), attachments: (raw.attachments ?? []).map((a) => ({ mime: a.mime, title: a.title, description: a.description, sourceFile: a.sourceFile })), summary: undefined, fallback_with_evidence: raw.fallback_with_evidence ?? null };
}
function convertReviewerResult(raw: FakeReviewerResult): ReviewerResult {
  return { assessment: { result: raw.assessment.result, summary: raw.assessment.summary, achieved: raw.assessment.achieved, issues: raw.assessment.issues, evidence_card_ids: raw.assessment.evidence_card_ids } };
}

export class FakeAgentAdapter implements AgentExecutionPort {
  private config: FakeAgentConfig;
  private plannerCounters = new Map<string, number>();
  private reviewerCounters = new Map<string, number>();
  private activeSessions = new Map<string, FakeActiveSession>();
  private cancelledSessions = new Set<string>();
  private sessionCounter = 0;
  private sessionFixtures = new Map<string, { role: 'planner' | 'executor' | 'reviewer'; fixtureName: string; goalId: string; cardId: string | null }>();
  private lastSessionByRoleAndTarget = new Map<string, string>();

  constructor(config: FakeAgentConfig) { this.config = config; }
  setSaivageDir(saivageDir: string): void { this.config = { ...this.config, saivageDir }; }
  setActivationLedger(activationLedger: RuntimeActivationLedgerPort): void { this.config = { ...this.config, activationLedger }; }
  setSessionStamper(sessionStamper: SessionStamper): void { this.config = { ...this.config, sessionStamper }; }
  private loadFixture(name: string): FakeAgentFixture { const fixturePath = resolve(this.config.fixtureDir, `${name}.json`); if (!existsSync(fixturePath)) throw new Error(`FakeAgent fixture not found: ${fixturePath}`); return JSON.parse(readFileSync(fixturePath, 'utf-8')) as FakeAgentFixture; }
  private resolveFixture(id: string): FakeAgentFixture { const name = this.config.mapping[id] ?? this.config.mapping['*']; if (!name) throw new Error(`No FakeAgent fixture mapping for '${id}' and no '*' wildcard configured.`); return this.loadFixture(name); }
  private nextSessionId(role: string): string { this.sessionCounter += 1; return `fake-${role}-${this.sessionCounter}`; }
  private registerSession(role: 'planner' | 'executor' | 'reviewer', goalId: string, cardId: string | null, nextAction: string, fixtureName: string, requestedSessionId?: string): string { const sessionId = requestedSessionId ?? this.nextSessionId(role); this.activeSessions.set(sessionId, { sessionId, role, goalId, cardId, lastAction: 'Session started', nextAction, contextSummary: `Goal: ${goalId}, Card: ${cardId ?? 'N/A'}` }); this.cancelledSessions.delete(sessionId); this.sessionFixtures.set(sessionId, { role, fixtureName, goalId, cardId }); this.lastSessionByRoleAndTarget.set(`${role}:${goalId}:${cardId ?? '_'}`, sessionId); return sessionId; }
  private completeSession(sessionId: string): void { this.activeSessions.delete(sessionId); this.cancelledSessions.delete(sessionId); }
  private get sessionStamper(): SessionStamper { if (!this.config.sessionStamper) throw new Error('FakeAgentAdapter fixture persistence requires session stamper.'); return this.config.sessionStamper; }
  getLastSessionId(role: 'planner' | 'executor' | 'reviewer', goalId: string, cardId: string | null = null): string | null { return this.lastSessionByRoleAndTarget.get(`${role}:${goalId}:${cardId ?? '_'}`) ?? null; }
  getSessionRecord(sessionId: string): AgentSession | null { const session = this.sessionFixtures.get(sessionId); if (!session) return null; return { id: sessionId, role: session.role, goal_card_id: session.goalId, card_id: session.cardId, status: 'active', started_at: new Date().toISOString() }; }
  cancelSession(sessionId: string): boolean { if (!this.activeSessions.has(sessionId)) return false; this.cancelledSessions.add(sessionId); this.activeSessions.delete(sessionId); return true; }
  forceCancelSession(sessionId: string): boolean { const existed = this.activeSessions.has(sessionId); this.cancelledSessions.add(sessionId); this.activeSessions.delete(sessionId); return existed; }
  getHandoffSummary(sessionId: string): HandoffSummary | null { const session = this.activeSessions.get(sessionId); if (!session) return null; return { session_id: session.sessionId, role: session.role, last_action: session.lastAction, next_action: session.nextAction, context_summary: session.contextSummary }; }
  getActiveSessionHandoffs(): HandoffSummary[] { return Array.from(this.activeSessions.values()).map((session) => ({ session_id: session.sessionId, role: session.role, last_action: session.lastAction, next_action: session.nextAction, context_summary: session.contextSummary })); }
  invokePlanner(request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[]): PlannerResult;
  invokePlanner(requestOrGoalId: PlannerInvocationRequest | string): PlannerResult { return this.invokePlannerForGoal(typeof requestOrGoalId === 'string' ? requestOrGoalId : requestOrGoalId.goalId); }
  private invokePlannerForGoal(goalId: string): PlannerResult {
    const fixture = this.resolveFixture(goalId);
    if (!fixture.planner || fixture.planner.length === 0) throw new Error(`FakeAgent fixture '${fixture.name}' has no planner results.`);
    const count = this.plannerCounters.get(fixture.name) ?? 0;
    if (count >= fixture.planner.length) throw new Error(`FakeAgent fixture '${fixture.name}' exhausted planner results (called ${count + 1} times, only ${fixture.planner.length} available).`);
    const sessionId = this.registerSession('planner', goalId, goalId, `Planning goal ${goalId}`, fixture.name);
    let persistedSessionId: string | null = null;
    let converted: PlannerResult | null = null;
    try {
      if (this.config.saivageDir) {
        persistedSessionId = createSession(this.config.saivageDir, 'planner', goalId, goalId).id;
        this.sessionStamper.openAssistantRound(persistedSessionId);
      }
      if (this.cancelledSessions.has(sessionId)) throw new Error(`Fake planner session cancelled: ${sessionId}`);
      const result = fixture.planner[count];
      this.plannerCounters.set(fixture.name, count + 1);
      converted = convertPlannerResult(result);
      return converted;
    } finally {
      if (this.config.saivageDir && persistedSessionId) {
        this.sessionStamper.closeRound(persistedSessionId);
        if (converted?.status === 'continue') markSessionWaiting(this.config.saivageDir, persistedSessionId);
        else if (converted?.status === 'blocked') completeSession(this.config.saivageDir, persistedSessionId, 'blocked');
        else completeSession(this.config.saivageDir, persistedSessionId, 'done');
      }
      this.completeSession(sessionId);
    }
  }

  invokeExecutor(request: ExecutorInvocationRequest): ExecutorResult;
  invokeExecutor(cardId: string, goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[]): ExecutorResult;
  invokeExecutor(requestOrCardId: ExecutorInvocationRequest | string, goalId?: string): ExecutorResult { return typeof requestOrCardId === 'string' ? this.invokeExecutorForCard(requestOrCardId, goalId ?? '') : this.invokeExecutorForCard(requestOrCardId.cardId, requestOrCardId.goalId); }
  private invokeExecutorForCard(cardId: string, goalId: string): ExecutorResult { const fixture = this.resolveFixture(goalId); if (!fixture.executor) throw new Error(`FakeAgent fixture '${fixture.name}' has no executor results.`); const sessionId = this.registerSession('executor', goalId, cardId, `Executing card ${cardId}`, fixture.name); try { if (this.cancelledSessions.has(sessionId)) throw new Error(`Fake executor session cancelled: ${sessionId}`); const result = fixture.executor[cardId]; if (!result) throw new Error(`FakeAgent fixture '${fixture.name}' has no executor result for card '${cardId}'.`); return convertExecutorResult(result); } finally { this.completeSession(sessionId); } }
  invokeReviewer(request: ReviewerInvocationRequest): ReviewerResult;
  invokeReviewer(goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[], options?: { assessmentId?: string; reviewerSessionId?: string }): ReviewerResult;
  invokeReviewer(requestOrGoalId: ReviewerInvocationRequest | string, _systemPrompt?: string, _contextMessages?: AgentMessage[], options: { assessmentId?: string; reviewerSessionId?: string } = {}): ReviewerResult { return typeof requestOrGoalId === 'string' ? this.invokeReviewerForGoal(requestOrGoalId, options.reviewerSessionId) : this.invokeReviewerForGoal(requestOrGoalId.goalId, requestOrGoalId.reviewerSessionId); }
  private invokeReviewerForGoal(goalId: string, reviewerSessionId?: string): ReviewerResult { const fixture = this.resolveFixture(goalId); if (!fixture.reviewer || fixture.reviewer.length === 0) throw new Error(`FakeAgent fixture '${fixture.name}' has no reviewer results.`); const count = this.reviewerCounters.get(fixture.name) ?? 0; if (count >= fixture.reviewer.length) throw new Error(`FakeAgent fixture '${fixture.name}' exhausted reviewer results (called ${count + 1} times, only ${fixture.reviewer.length} available).`); const sessionId = this.registerSession('reviewer', goalId, null, `Reviewing goal ${goalId}`, fixture.name, reviewerSessionId); try { if (this.cancelledSessions.has(sessionId)) throw new Error(`Fake reviewer session cancelled: ${sessionId}`); const result = fixture.reviewer[count]; this.reviewerCounters.set(fixture.name, count + 1); return convertReviewerResult(result); } finally { this.completeSession(sessionId); } }
  reinvokeSession(request: SessionReinvokeRequest): ExecutorResult | ReviewerResult;
  reinvokeSession(sessionId: string): ExecutorResult | ReviewerResult;
  reinvokeSession(requestOrSessionId: SessionReinvokeRequest | string): ExecutorResult | ReviewerResult { const sessionId = typeof requestOrSessionId === 'string' ? requestOrSessionId : requestOrSessionId.sessionId; const session = this.sessionFixtures.get(sessionId); if (!session) throw new Error(`Unknown fake session '${sessionId}'.`); if (session.role === 'executor') return this.invokeExecutorForCard(session.cardId ?? '', session.goalId); if (session.role === 'reviewer') return this.invokeReviewerForGoal(session.goalId, sessionId); throw new Error(`Session '${sessionId}' is not reinvokable.`); }
  toPlannerResult(raw: FakePlannerResult): PlannerResult { return convertPlannerResult(raw); }
  toExecutorResult(raw: FakeExecutorResult): ExecutorResult { return convertExecutorResult(raw); }
  toReviewerResult(raw: FakeReviewerResult): ReviewerResult { return convertReviewerResult(raw); }
  reset(): void { this.plannerCounters.clear(); this.reviewerCounters.clear(); this.activeSessions.clear(); this.cancelledSessions.clear(); this.sessionCounter = 0; this.sessionFixtures.clear(); this.lastSessionByRoleAndTarget.clear(); }
  getPlannerCount(goalId: string): number { const fixture = this.resolveFixture(goalId); return this.plannerCounters.get(fixture.name) ?? 0; }
  getReviewerCount(goalId: string): number { const fixture = this.resolveFixture(goalId); return this.reviewerCounters.get(fixture.name) ?? 0; }
}
