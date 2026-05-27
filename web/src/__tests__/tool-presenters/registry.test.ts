import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { registeredCallToolNamesForTest, registeredResultToolNamesForTest, registeredToolNamesForTest } from '../../utils/tool-presenters/registry';
import { callEnvelope } from './_helpers';

describe('tool presenter registry', () => {
  it('loads the default registration and resolves known tool names', () => {
    expect(() => presentToolCall(callEnvelope('unknown_tool'))).not.toThrow();
    expect(registeredToolNamesForTest()).toContain('read_project_file');
    expect(registeredCallToolNamesForTest()).toContain('run_project_command');
    expect(registeredResultToolNamesForTest()).toContain('read_file');
  });
});
