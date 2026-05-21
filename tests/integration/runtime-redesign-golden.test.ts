import { describe, it } from '@jest/globals';

describe.skip('runtime redesign golden absence checks (Waves 2 through 5)', () => {
  it('Wave 2 removes this skip when active backend APIs no longer expose lets_dance or project-directive root kickoff', () => {
    // TODO(Wave 2): assert runtime/tool/server active behavior offers start_project/stop_project
    // only, and no project-directive file can start root execution.
  });

  it('Wave 2 removes this skip when status changes cannot auto-dispatch root or child work', () => {
    // TODO(Wave 2): assert changing card planner state/status-like metadata never enqueues,
    // resumes, or dispatches runtime work.
  });

  it('Wave 2 removes this skip when no status-derived ready queue remains in backend behavior', () => {
    // TODO(Wave 2): assert runtime summaries show command/run/activation records only, not
    // buildReadyQueue/executeReadyCards/status-scanned runnable work.
  });

  it('Wave 2 removes this skip when confirmed and preview_hash are not accepted as mutation gates', () => {
    // TODO(Wave 2): assert mutating tool/API calls either apply directly or return actionable
    // validation/precondition errors without confirmed/preview_hash retry rituals.
  });

  it('Wave 4 removes this skip when the web UI separates Runtime Console controls from Planning Tree metadata', () => {
    // TODO(Wave 4): assert runtime controls observe command/run/activation records while card
    // views expose planner metadata only and no pending-confirmation/status-ready affordances.
  });

  it('Wave 5 removes this skip when active docs and prompts contain no obsolete start-work rituals', () => {
    // TODO(Wave 5): assert docs/prompts source-search guardrails pass for active surfaces;
    // historical audit/research references may remain only when clearly classified as history.
  });
});
