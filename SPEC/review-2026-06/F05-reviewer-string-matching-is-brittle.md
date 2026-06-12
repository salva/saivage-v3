# F05: Reviewer response parsing is brittle string matching

## Summary

`GoalCardRunnerController.reviewPlannerResult()` (goal-card-runner.ts:281-283) parses reviewer LLM output using three brittle string checks: exact match `=== 'pass'`, prefix match `startsWith('needs_corrections:')`, and a catch-all failure. There is no structured tool call for reviewer responses; the entire reviewer verdict depends on raw LLM text output.

## Evidence

- `src/runtime/actors/goal-card-runner.ts:281-283`:
  ```typescript
  const content = reviewerOutput.result.content.trim();
  if (content === 'pass') return { kind: 'passed' };
  if (content.startsWith('needs_corrections:')) return { kind: 'needs_corrections', summary: content.slice('needs_corrections:'.length).trim() };
  ```
- This means any variation in reviewer output ('Pass', ' pass ', 'PASS', 'pass.') causes the goal to fail rather than pass.

## Category

Bad assumption / fragile design

## Severity

4 -- reviewer verdicts are a control-plane decision. Misinterpreting a passed review as a failure causes the goal to be marked failed, which is an irreversible state change in the card tree. The v2 reviewer had more robust structured parsing.

## Transversality

Local (goal-card-runner.ts) but affects all reviewer interactions