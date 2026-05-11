import { describe, it, expect } from '@jest/globals';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
  systemPromptBuilder,
} from '../../src/agents/system-prompt.js';

// ── Test Suite ────────────────────────────────────────────────

describe('System Prompt Builder', () => {
  // ═══════════════════════════════════════════════════════════════
  // Planner Prompt
  // ═══════════════════════════════════════════════════════════════

  describe('buildPlannerPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildPlannerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains "Planner"', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('Planner');
    });

    it('contains "created_cards"', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('created_cards');
    });

    it('contains "declare_done"', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('declare_done');
    });

    it('mentions card types', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt).toContain('code');
      expect(prompt).toContain('test');
      expect(prompt).toContain('doc');
    });

    it('mentions behavioral guidelines', () => {
      const prompt = buildPlannerPrompt();
      expect(prompt.toLowerCase()).toContain('behavioral');
    });

    it('is accessible via systemPromptBuilder namespace', () => {
      const prompt = systemPromptBuilder.buildPlannerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Executor Prompt
  // ═══════════════════════════════════════════════════════════════

  describe('buildExecutorPrompt', () => {
    it('returns a non-empty string (no card type)', () => {
      const prompt = buildExecutorPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains "Executor"', () => {
      const prompt = buildExecutorPrompt();
      expect(prompt).toContain('Executor');
    });

    it('contains "status"', () => {
      const prompt = buildExecutorPrompt();
      expect(prompt).toContain('status');
    });

    it('returns a non-empty string with card type', () => {
      const prompt = buildExecutorPrompt('code');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('buildExecutorPrompt("code") mentions "code"', () => {
      const prompt = buildExecutorPrompt('code');
      expect(prompt.toLowerCase()).toContain('code');
    });

    it('buildExecutorPrompt("code") includes type-specific guidance', () => {
      const prompt = buildExecutorPrompt('code');
      // The type-specific guidance for code mentions "source code"
      expect(prompt.toLowerCase()).toContain('source code');
    });

    it('buildExecutorPrompt("test") mentions "test"', () => {
      const prompt = buildExecutorPrompt('test');
      expect(prompt.toLowerCase()).toContain('test');
    });

    it('buildExecutorPrompt("doc") mentions "documentation"', () => {
      const prompt = buildExecutorPrompt('doc');
      expect(prompt.toLowerCase()).toContain('documentation');
    });

    it('mentions behavioral guidelines', () => {
      const prompt = buildExecutorPrompt();
      expect(prompt.toLowerCase()).toContain('behavioral');
    });

    it('is accessible via systemPromptBuilder namespace', () => {
      const prompt = systemPromptBuilder.buildExecutorPrompt('code');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('handles unknown card types gracefully', () => {
      const prompt = buildExecutorPrompt('unknown_type');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      // Should still contain the basic executor prompt
      expect(prompt).toContain('Executor');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Reviewer Prompt
  // ═══════════════════════════════════════════════════════════════

  describe('buildReviewerPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildReviewerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains "Reviewer"', () => {
      const prompt = buildReviewerPrompt();
      expect(prompt).toContain('Reviewer');
    });

    it('contains "assessment"', () => {
      const prompt = buildReviewerPrompt();
      expect(prompt).toContain('assessment');
    });

    it('mentions pass/fail criteria', () => {
      const prompt = buildReviewerPrompt();
      expect(prompt).toContain('pass');
      expect(prompt).toContain('fail');
    });

    it('mentions acceptance criteria', () => {
      const prompt = buildReviewerPrompt();
      expect(prompt.toLowerCase()).toContain('acceptance');
    });

    it('mentions behavioral guidelines', () => {
      const prompt = buildReviewerPrompt();
      expect(prompt.toLowerCase()).toContain('behavioral');
    });

    it('is accessible via systemPromptBuilder namespace', () => {
      const prompt = systemPromptBuilder.buildReviewerPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Uniqueness
  // ═══════════════════════════════════════════════════════════════

  describe('prompts are distinct', () => {
    it('planner, executor, and reviewer prompts are different', () => {
      const plannerPrompt = buildPlannerPrompt();
      const executorPrompt = buildExecutorPrompt();
      const reviewerPrompt = buildReviewerPrompt();

      // Each prompt should be distinct from the others
      expect(plannerPrompt).not.toBe(executorPrompt);
      expect(plannerPrompt).not.toBe(reviewerPrompt);
      expect(executorPrompt).not.toBe(reviewerPrompt);

      // Each should contain its own role name
      expect(plannerPrompt).toContain('Planner');
      expect(executorPrompt).toContain('Executor');
      expect(reviewerPrompt).toContain('Reviewer');
    });
  });
});
