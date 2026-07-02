// @vitest-environment node
import { describe, expect, it } from 'vitest';
import '../utils/tool-presenters';
import { registeredToolNamesForTest } from '../utils/tool-presenters/registry';

const REMOVED_TOOL_NAMES = [
  'report_goal_done',
  'report_goal_failed',
  'report_goal_blocked',
  'mark_goal_needs_corrections',
  'abort_goal',
  'abort_goal_subtree',
  'restart_goal',
  'restart_card_or_subtree',
  'load_skill',
];

const REQUIRED_CURRENT_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'run_command',
  'wait_process',
  'kill_process',
  'create_card',
  'delete_card',
  'cancel_card',
  'reorder_child',
  'emit_result',
  'skill',
  'mcp_tool_call',
];

describe('tool presenter registry coverage', () => {
  it('does not register superseded tools and keeps current common tools covered', () => {
    const names = registeredToolNamesForTest();
    for (const removed of REMOVED_TOOL_NAMES) expect(names).not.toContain(removed);
    for (const required of REQUIRED_CURRENT_TOOL_NAMES) expect(names).toContain(required);
  });
});
