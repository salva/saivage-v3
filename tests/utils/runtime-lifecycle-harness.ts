import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { disposeProcessRuntimeScope, snapshotProcessRuntimeScope } from '../../src/runtime/process-runner.js';
import type { RuntimeDisposeReportEntry, RuntimeLifecycleSnapshot } from '../../src/runtime/lifecycle.js';

export interface RuntimeLifecycleHarness {
  root: string;
  snapshot(): RuntimeLifecycleSnapshot;
  dispose(): Promise<RuntimeDisposeReportEntry[]>;
  cleanup(): Promise<RuntimeDisposeReportEntry[]>;
}

export function createRuntimeLifecycleHarness(prefix = 'runtime-lifecycle-'): RuntimeLifecycleHarness {
  const root = mkdtempSync(join(tmpdir(), prefix));
  initProjectTree(root);
  let cleaned = false;
  return {
    root,
    snapshot: () => snapshotProcessRuntimeScope(root),
    dispose: () => disposeProcessRuntimeScope(root),
    cleanup: async () => {
      const report = cleaned ? [] : await disposeProcessRuntimeScope(root);
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
      return report;
    },
  };
}
