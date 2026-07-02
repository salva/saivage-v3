import { describe, it, expect } from '@jest/globals';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
  systemPromptBuilder,
} from '../../src/agents/system-prompt.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import { createReviewerContract } from '../../src/contracts/reviewer-contract.js';

const plannerContract = createPlannerContract();
const executorContract = createExecutorContract();
const reviewerContract = createReviewerContract();

describe('System Prompt Builder', () => {
  describe('buildPlannerPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains planner role and tool-mutation guidance', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('Planner');
      expect(prompt).toContain('Use tools for all card mutations');
      expect(prompt).toContain('only reports `status`, and `summary`');
      expect(prompt).not.toContain('created_cards');
      expect(prompt).not.toContain('updated_cards');
    });

    it('includes stage-3 activation and recurrence instructions', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('activate_card');
      expect(prompt).toContain('Planners recur on the same goal');
      expect(prompt).toContain('Executors are one-shot per activation');
    });

    it('includes terminal summary and reviewer_interrupted recovery guidance', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('summary');
      expect(prompt).toContain("resume_reason: 'service_restart'");
      expect(prompt).toContain('re-issue `emit_result`');
    });

    it('marks prior-cycle delegation APIs as obsolete instead of making them available planner actions', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('obsolete tools');
      expect(prompt).toContain('Do **not** use or mention obsolete tools');
      expect(prompt).toContain('activate_card');
      expect(prompt).toContain('emit_result');
    });

    it('mentions named tool errors', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('subtree_not_ready');
      expect(prompt).toContain('invalid_evidence');
      expect(prompt).toContain('terminal_card_requires_restart');
      expect(prompt).toContain('card_already_running');
    });

    it('describes the planner contract terminal tools', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('Terminal Tools (Contract)');
      expect(prompt).toContain('emit_result');
      expect(prompt).not.toContain('emit_planner_deferred');
    });

    it('is accessible via systemPromptBuilder namespace', () => {
      const prompt = systemPromptBuilder.buildPlannerPrompt(plannerContract);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe('buildExecutorPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildExecutorPrompt(executorContract);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains required summary guidance', () => {
      const prompt = buildExecutorPrompt(executorContract);
      expect(prompt).toContain('Executor');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('one-shot');
    });

    it('describes project, record, status, and process scoping', () => {
      const prompt = buildExecutorPrompt(executorContract);
      expect(prompt).toContain('project files');
      expect(prompt).toContain('record://status.md');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('.saivage-work');
      expect(prompt).not.toContain('never a project source');
    });

    it('describes the executor contract terminal tool', () => {
      const prompt = buildExecutorPrompt(executorContract);
      expect(prompt).toContain('Terminal Tools (Contract)');
      expect(prompt).toContain('emit_result');
    });

    it('supports type-specific guidance', () => {
      expect(buildExecutorPrompt(executorContract, 'code').toLowerCase()).toContain('source code');
      expect(buildExecutorPrompt(executorContract, 'test').toLowerCase()).toContain('test');
      expect(buildExecutorPrompt(executorContract, 'doc').toLowerCase()).toContain('documentation');
    });
  });

  describe('buildReviewerPrompt', () => {
    it('returns the canonical reviewer terminal guidance without legacy fail/missing fields', () => {
      const prompt = buildReviewerPrompt(reviewerContract);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain('Reviewer');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('rework');
      expect(prompt).not.toContain(" or 'fail'");
      expect(prompt).not.toContain('"missing"');
    });

    it('preserves Cite evidence constraint', () => {
      const prompt = buildReviewerPrompt(reviewerContract);
      expect(prompt).toContain('Cite evidence');
    });

    it('describes the reviewer contract terminal tool', () => {
      const prompt = buildReviewerPrompt(reviewerContract);
      expect(prompt).toContain('Terminal Tools (Contract)');
      expect(prompt).toContain('emit_result');
    });
  });

  describe('Planner Prompt Depth Context', () => {
    it('includes current depth and max depth when both provided', () => {
      const prompt = buildPlannerPrompt(plannerContract, undefined, 3, 5);
      expect(prompt).toContain('Goal Depth Context');
      expect(prompt).toContain('Current goal depth: 3');
      expect(prompt).toContain('Maximum allowed depth: 5');
    });

    it('omits depth context when incomplete', () => {
      expect(buildPlannerPrompt(plannerContract)).not.toContain('Goal Depth Context');
      expect(buildPlannerPrompt(plannerContract, undefined, 3)).not.toContain('Goal Depth Context');
      expect(buildPlannerPrompt(plannerContract, undefined, undefined, 5)).not.toContain('Goal Depth Context');
    });
  });
});

describe('planner system prompt', () => {
  it('describes cancel_card as destructive recovery-only guidance', () => {
    const prompt = buildPlannerPrompt(createPlannerContract());
    expect(prompt).toContain('Use cancellation only for cleanup/recovery');
    expect(prompt).toContain('Do not cancel the next actionable backlog child');
    expect(prompt).toContain('is not a scheduling primitive');
    expect(prompt).toContain('after any cancellation, either activate a replacement child or emit a terminal goal report');
  });
});
