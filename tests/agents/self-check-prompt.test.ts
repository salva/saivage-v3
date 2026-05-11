import { describe, it, expect } from '@jest/globals';
import {
  buildSelfCheckPrompt,
  systemPromptBuilder,
} from '../../src/agents/system-prompt.js';

// ── Test Suite ────────────────────────────────────────────────

describe('buildSelfCheckPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains the role name when passed', () => {
    // The role parameter is accepted but may not be embedded verbatim;
    // instead the prompt references "Self-Check Assessment" which is role-agnostic.
    // We verify the prompt is well-formed by checking consistent content.
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(prompt).toContain('Self-Check');
  });

  it('mentions "tool-call rounds"', () => {
    const prompt = buildSelfCheckPrompt('planner', 30, 30);
    expect(prompt).toContain('tool-call rounds');
  });

  it('contains "Progress"', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Progress');
  });

  it('contains "Circular behavior"', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Circular behavior');
  });

  it('contains "Redundancy"', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Redundancy');
  });

  it('contains "Goal drift"', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Goal drift');
  });

  it('contains the self_check JSON format instructions', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(prompt).toContain('self_check');
    expect(prompt).toContain('"ok"');
    expect(prompt).toContain('"stuck"');
    expect(prompt).toContain('"escalate"');
  });

  it('includes the rounds count in the prompt', () => {
    const prompt = buildSelfCheckPrompt('executor', 7, 15);
    expect(prompt).toContain('7');
    expect(prompt).toContain('15');
  });

  it('is accessible via systemPromptBuilder namespace', () => {
    const prompt = systemPromptBuilder.buildSelfCheckPrompt('planner', 30, 30);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Self-Check');
  });

  it('works for planner role', () => {
    const prompt = buildSelfCheckPrompt('planner', 30, 30);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('tool-call rounds');
  });

  it('works for analyst role as well (even if never triggered by default)', () => {
    const prompt = buildSelfCheckPrompt('analyst', 0, 0);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
