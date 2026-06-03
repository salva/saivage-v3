import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CardRecord } from '../schemas/index.js';
import type { RuntimeCardAction } from './state-machine.js';
import {
  cleanStalePreviews,
  cleanStaleStash,
  cleanStaleUploads,
} from './cleanup.js';

function saivageWorkDir(projectRoot: string): string {
  return join(projectRoot, '.saivage-work');
}

export async function performRuntimeCrashRecovery(input: {
  projectRoot: string;
  cards: CardRecord[];
  transitionCard: (cardId: string, event: RuntimeCardAction) => Promise<boolean>;
}): Promise<void> {
  for (const card of input.cards)
    if (card.status === 'active' || card.status === 'running') {
      await input.transitionCard(card.id, 'crash_recovery_drop_to_backlog');
    }
  const tmpRuntimeDir = join(input.projectRoot, '.saivage-work', 'tmp', 'runtime');
  if (existsSync(tmpRuntimeDir)) {
    try {
      const entries = readdirSync(tmpRuntimeDir);
      for (const entry of entries) {
        if (entry === 'runtime.lock') continue;
        if (entry.endsWith('.tmp') || entry.endsWith('.tmp.') || entry.includes('.tmp.')) {
          try {
            rmSync(join(tmpRuntimeDir, entry), { recursive: true, force: true });
          } catch {
            void 0;
          }
        }
      }
    } catch {
      void 0;
    }
  }
  try {
    cleanStaleStash(saivageWorkDir(input.projectRoot), 24 * 60 * 60 * 1000);
  } catch {
    void 0;
  }
  try {
    cleanStalePreviews(saivageWorkDir(input.projectRoot), 24 * 60 * 60 * 1000);
  } catch {
    void 0;
  }
  try {
    cleanStaleUploads(saivageWorkDir(input.projectRoot), 24 * 60 * 60 * 1000);
  } catch {
    void 0;
  }
}
