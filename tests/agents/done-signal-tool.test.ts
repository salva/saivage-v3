import { describe, it, expect } from '@jest/globals';
import { buildDoneSignalTools, isDoneSignalToolName } from '../../src/agents/done-signal-tool.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import { createReviewerContract } from '../../src/contracts/reviewer-contract.js';

const executor = createExecutorContract({ cardId: 'c1', goalId: 'g1' });
const planner = createPlannerContract({ goalId: 'g1', parentSessionId: 's1' });
const reviewer = createReviewerContract({ goalId: 'g1', assessmentId: 'a1' });

describe('done-signal-tool', () => {
  describe('buildDoneSignalTools', () => {
    it('returns one tool per executor terminal (single-terminal contract)', () => {
      const tools = buildDoneSignalTools(executor);
      expect(tools).toHaveLength(1);
      expect(tools[0].type).toBe('function');
      expect(tools[0].function.name).toBe('emit_executor_result');
      expect(tools[0].function.description).toMatch(/executor result envelope/);
      expect(tools[0].function.parameters).toEqual(expect.objectContaining({ type: 'object' }));
    });

    it('returns the planner result terminal', () => {
      const tools = buildDoneSignalTools(planner);
      expect(tools.map((t) => t.function.name)).toEqual(['emit_planner_result']);
    });

    it('returns one tool for the reviewer terminal', () => {
      const tools = buildDoneSignalTools(reviewer);
      expect(tools).toHaveLength(1);
      expect(tools[0].function.name).toBe('emit_reviewer_result');
    });

    it('produces tool definitions whose parameter schemas mirror the terminal Zod schema (object with properties)', () => {
      for (const tool of buildDoneSignalTools(executor)) {
        expect(tool.function.parameters).toEqual(expect.objectContaining({ type: 'object' }));
        expect((tool.function.parameters as { properties?: unknown }).properties).toBeDefined();
      }
      for (const tool of buildDoneSignalTools(planner)) {
        expect(tool.function.parameters).toEqual(expect.objectContaining({ type: 'object' }));
        expect((tool.function.parameters as { properties?: unknown }).properties).toBeDefined();
      }
      for (const tool of buildDoneSignalTools(reviewer)) {
        expect(tool.function.parameters).toEqual(expect.objectContaining({ type: 'object' }));
        expect((tool.function.parameters as { properties?: unknown }).properties).toBeDefined();
      }
    });
  });

  describe('isDoneSignalToolName', () => {
    it('returns true for the executor terminal name only', () => {
      expect(isDoneSignalToolName(executor, 'emit_executor_result')).toBe(true);
      expect(isDoneSignalToolName(executor, 'emit_planner_result')).toBe(false);
      expect(isDoneSignalToolName(executor, 'read_file')).toBe(false);
    });

    it('returns true for the planner result terminal only', () => {
      expect(isDoneSignalToolName(planner, 'emit_planner_result')).toBe(true);
      expect(isDoneSignalToolName(planner, 'emit_planner_deferred')).toBe(false);
      expect(isDoneSignalToolName(planner, 'emit_reviewer_result')).toBe(false);
    });

    it('returns true for the reviewer terminal name only', () => {
      expect(isDoneSignalToolName(reviewer, 'emit_reviewer_result')).toBe(true);
      expect(isDoneSignalToolName(reviewer, 'emit_executor_result')).toBe(false);
    });
  });
});
