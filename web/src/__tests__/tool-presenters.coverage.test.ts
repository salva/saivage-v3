// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../../../src/tools/definitions';
import '../utils/tool-presenters';
import { registeredToolNamesForTest } from '../utils/tool-presenters/registry';

const EXPECTED_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name).sort();

describe('tool presenter registry coverage', () => {
  it('registers exactly the expected current tools', () => {
    expect(registeredToolNamesForTest()).toEqual(EXPECTED_TOOL_NAMES);
  });
});
