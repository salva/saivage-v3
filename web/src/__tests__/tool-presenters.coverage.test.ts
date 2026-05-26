import { describe, expect, it } from 'vitest';
import '../utils/tool-presenters';
import { registeredToolNamesForTest } from '../utils/tool-presenters/registry';

const EXPECTED_TOOL_NAMES = [
  'abort_goal','activate_card','add_note','cancel_card','create_card','delete_card','diff_card','edit_card','get_card','get_card_history_entry','get_card_output','get_note','get_plan_diary','get_status','get_tree','kill_process','list_agent_sessions','list_card_history','list_cards','list_directory','list_notes','list_processes_tool','list_project_files','load_skill','mark_goal_needs_corrections','mark_note_handled','mcp_tool_call','move_card','pause_runtime','read_agent_session','read_control_actions','read_file','read_project_file','read_runtime_errors','read_runtime_events','report_goal_blocked','report_goal_done','report_goal_failed','restart_card','restart_goal','resume_runtime','run_project_command','run_shell_command','start_and_wait','wait_for_process','write_project_file',
].sort();

describe('tool presenter registry coverage', () => {
  it('registers exactly the expected current tools', () => {
    expect(registeredToolNamesForTest()).toEqual(EXPECTED_TOOL_NAMES);
  });
});
