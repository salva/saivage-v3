import { describe, expect, it } from '@jest/globals';

import {
  PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS,
  REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS,
  TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS,
} from '../../../src/runtime/actors/actor-tool-definitions.js';

function names(definitions: Array<{ function: { name: string } }>): string[] {
  return definitions.map((definition) => definition.function.name);
}

describe('actor tool definitions', () => {
  it('advertises web tools to planner, executor, and reviewer actors', () => {
    expect(names(PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(['websearch', 'webfetch']));
    expect(names(TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(['websearch', 'webfetch']));
    expect(names(REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(['websearch', 'webfetch']));
  });

  it('advertises card history tools to planner, executor, and reviewer actors', () => {
    const historyTools = ['list_card_history', 'get_card_history_entry', 'diff_card'];
    expect(names(PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(historyTools));
    expect(names(TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(historyTools));
    expect(names(REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS)).toEqual(expect.arrayContaining(historyTools));
  });

  it('advertises skills to executor and reviewer actors only', () => {
    expect(names(PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS)).not.toContain('skill');
    expect(names(TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS)).toContain('skill');
    expect(names(REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS)).toContain('skill');
  });
});
