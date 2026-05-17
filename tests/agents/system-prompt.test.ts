import { describe, it, expect } from '@jest/globals';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
  systemPromptBuilder,
} from '../../src/agents/system-prompt.js';

describe('System Prompt Builder', () => {
  describe('buildPlannerPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildPlannerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains planner role and created_cards schema', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('Planner');
      expect(prompt).toContain('created_cards');
    });

    it('includes stage-3 activation and recurrence instructions', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('activate_card');
      expect(prompt).toContain('Planners recur on the same goal');
      expect(prompt).toContain('Executors are one-shot per activation');
    });

    it('includes terminal status_text and reviewer_interrupted recovery guidance', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('status_text');
      expect(prompt).toContain("resume_reason: 'reviewer_interrupted'");
      expect(prompt).toContain('re-issue `report_goal_done`');
    });

    it('marks prior-cycle delegation APIs as obsolete instead of making them available planner actions', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('obsolete tools');
      expect(prompt).toContain('Do **not** use or mention obsolete tools');
      expect(prompt).toContain('activate_card');
      expect(prompt).toContain('report_goal_done');
    });

    it('mentions named tool errors', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('subtree_not_ready');
      expect(prompt).toContain('invalid_evidence');
      expect(prompt).toContain('terminal_card_requires_restart');
      expect(prompt).toContain('card_already_active');
    });

    it('is accessible via systemPromptBuilder namespace', () => {
      const prompt = systemPromptBuilder.buildPlannerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe('buildExecutorPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildExecutorPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains required status_text guidance', () => {
      const prompt = buildExecutorPrompt();
      expect(prompt).toContain('Executor');
      expect(prompt).toContain('status_text');
      expect(prompt).toContain('one-shot');
    });

    it('supports type-specific guidance', () => {
      expect(buildExecutorPrompt('code').toLowerCase()).toContain('source code');
      expect(buildExecutorPrompt('test').toLowerCase()).toContain('test');
      expect(buildExecutorPrompt('doc').toLowerCase()).toContain('documentation');
    });
  });

  describe('buildReviewerPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildReviewerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain('Reviewer');
      expect(prompt).toContain('assessment');
    });
  });

  describe('Planner Prompt Depth Context', () => {
    it('includes current depth and max depth when both provided', () => {
      const prompt = buildPlannerPrompt(undefined, 3, 5);
      expect(prompt).toContain('Goal Depth Context');
      expect(prompt).toContain('Current goal depth: 3');
      expect(prompt).toContain('Maximum allowed depth: 5');
    });

    it('omits depth context when incomplete', () => {
      expect(buildPlannerPrompt()).not.toContain('Goal Depth Context');
      expect(buildPlannerPrompt(undefined, 3)).not.toContain('Goal Depth Context');
      expect(buildPlannerPrompt(undefined, undefined, 5)).not.toContain('Goal Depth Context');
    });
  });
});
