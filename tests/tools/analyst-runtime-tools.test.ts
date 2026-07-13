import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { list_processes_tool } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

describe('analyst runtime tools', () => {
  it('projects process logs as canonical work URLs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-runtime-'));
    try {
      const processRunner = createTestProcessRunner(projectRoot);
      const processScope = processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-agent', 'runtime_card');
      const process = processRunner.spawn({ command: 'echo hello', directScope: processScope, category: 'runtime_card', cardId: 'card-1', ownerId: 'agent-1', ownerKind: 'agent' });
      const result = await list_processes_tool({ projectRoot, processRunner, actor: 'analyst', surface: 'web' } as unknown as ToolContext, {});

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([expect.objectContaining({ card_id: 'card-1', owner_kind: 'agent', owner_id: 'agent-1', logs: { stdout: `work:///cards/card-1/processes/${process.id}/stdout.log`, stderr: `work:///cards/card-1/processes/${process.id}/stderr.log` } })]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
