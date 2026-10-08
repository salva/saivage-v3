import { afterEach, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LlmToolInvocationContext } from '../../src/runtime/runtime-api.js';
import type { normalizeWorkspaceImage as Normalize } from '../../src/tools/image-decode.js';
import type { CardService } from '../../src/cards/store-api.js';
import { conversationImageFile } from '../../src/persistence/layout.js';

// Exercise the retained asynchronous conversion seam, not a production test port.
const normalize = jest.fn<typeof Normalize>();
jest.unstable_mockModule('../../src/tools/image-decode.js', () => ({ normalizeWorkspaceImage: normalize }));
const { workspaceToolBinders, globalWorkspaceObservationToolBinders } = await import('../../src/tools/workspace-provider.js');
const { WorkspaceToolInputError } = await import('../../src/tools/project-file-tools.js');
const roots: string[] = [];
afterEach(() => {
  normalize.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['agent:executor:project', 'agent:analyst:global'] as const)(
  'retains exact %s cancellation reason after pending normalization succeeds or fails recognizably',
  async (sessionId) => {
    for (const failure of [false, true]) {
      const root = mkdtempSync('/home/salva/g/ml/tmp/view-image-cancellation-');
      roots.push(root);
      writeFileSync(join(root, 'screen.png'), 'decoder-owned input');
      let resolve!: (value: Awaited<ReturnType<typeof Normalize>>) => void;
      let reject!: (reason: unknown) => void;
      let entered!: () => void;
      const started = new Promise<void>((done) => { entered = done; });
      normalize.mockImplementationOnce(() => new Promise((done, fail) => {
        resolve = done; reject = fail; entered();
      }));
      const binders = sessionId === 'agent:analyst:global' ? globalWorkspaceObservationToolBinders : workspaceToolBinders;
      const tool = binders.find((binder) => binder.name === 'view_image')!.bind({ projectRoot: root, agentName: 'executor', store: {} as CardService });
      const controller = new AbortController();
      const reason = new Error('exact invocation cancellation');
      const operation = tool.executor({ path: 'screen.png' }, controller.signal, { sessionId } as unknown as LlmToolInvocationContext);
      await started;
      controller.abort(reason);
      if (failure) reject(new WorkspaceToolInputError('recognized decoder failure'));
      else resolve({ bytes: Buffer.from('must not be published'), data: {
        source_path: 'screen.png', source_dimensions: { width: 1, height: 1 },
        oriented_dimensions: { width: 1, height: 1 }, sent_dimensions: { width: 1, height: 1 },
        orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600,
      } });
      await expect(operation).rejects.toBe(reason);
      expect(existsSync(dirname(conversationImageFile(root, sessionId, '11111111-1111-4111-8111-111111111111')))).toBe(false);
    }
  },
);
