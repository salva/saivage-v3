import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as toolsIndex from '../../src/tools/index.js';
import { ToolRuntime, defineTool } from '../../src/tools/runtime.js';
import { AGENT_TOOL_DEFINITIONS } from '../../src/tools/definitions/index.js';
import { PlannerToolError, PlannerToolsService } from '../../src/tools/planner-tools.js';

describe('tools module ownership boundary', () => {
  it('uses explicit exports instead of broad wildcard package re-exports', () => {
    const source = readFileSync(join(process.cwd(), 'src/tools/index.ts'), 'utf8');
    expect(source).not.toMatch(/export\s+\*\s+from/);
  });

  it('exports only source-proven production tools package-root values', () => {
    expect(toolsIndex.ToolRuntime).toBe(ToolRuntime);
    expect(toolsIndex.AGENT_TOOL_DEFINITIONS).toBe(AGENT_TOOL_DEFINITIONS);
    expect(toolsIndex.PlannerToolError).toBe(PlannerToolError);
    expect(toolsIndex.PlannerToolsService).toBe(PlannerToolsService);
  });

  it('does not expose test-only or internal runtime helper values from the package root', () => {
    expect('defineTool' in toolsIndex).toBe(false);
    expect('REPORTABLE_OUTCOMES' in toolsIndex).toBe(false);
    expect(toolsIndex).not.toHaveProperty('defineTool', defineTool);
  });
});
