import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { newProjectRootInput } from '../../src/boot/app.js';
import { CardService as ProductionCardService } from '../../src/cards/card-service.js';
import { createResolvedConfigAuthority, type ResolvedConfigAuthority } from '../../src/config/index.js';
import { NO_FRESHNESS_EFFECTS, type FreshnessEffects } from '../../src/application/freshness-effects.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { createAnalystMutationServices, type AnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { publishInitialProjectCard } from '../../src/persistence/card-files.js';
import { createProjectIdentity, readProjectIdentity } from '../../src/persistence/project-identity.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';

export function initProjectTree(projectRoot: string): { projectRoot: string } {
  mkdirSync(projectRoot, { recursive: true });
  if (readProjectIdentity(projectRoot) === null) createProjectIdentity(projectRoot, projectRoot.split('/').at(-1) || 'saivage-project');
  if (!existsSync(join(projectRoot, '.saivage', 'cards', 'project', 'card.jsonl'))) {
    mkdirSync(join(projectRoot, '.saivage', 'cards'), { recursive: true });
    const root = newProjectRootInput(projectRoot);
    publishInitialProjectCard(projectRoot, root);
  }
  for (const relative of ['skills', 'config/prompts', 'agents/conversations', 'instructions', 'work/cards', 'work/processes', 'work/tmp/stash']) mkdirSync(join(projectRoot, '.saivage', relative), { recursive: true });
  const skills = join(projectRoot, '.saivage', 'skills', 'index.json');
  if (!existsSync(skills)) { mkdirSync(dirname(skills), { recursive: true }); writeFileSync(skills, '[]\n'); }
  return { projectRoot };
}

export function testConfigAuthority(projectRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): ResolvedConfigAuthority {
  return createResolvedConfigAuthority({ path: join(projectRoot, '.saivage', 'saivage.yaml'), source: { kind: 'default' }, interpolationEnvironment: env });
}

export class CardService extends ProductionCardService {
  constructor(projectRoot: string, freshness: Pick<FreshnessEffects, 'cardProjectionChanged' | 'runtimeChanged'> = NO_FRESHNESS_EFFECTS, io?: GrowingFileIo) {
    super(projectRoot, freshness, io);
  }
}

export function testInterventionReadiness(): RuntimeInterventionBinding {
  const readiness = new RuntimeInterventionBinding();
  readiness.markStoppedReady();
  return readiness;
}

export function testAnalystMutationServices(projectRoot: string, store: ProductionCardService = new CardService(projectRoot), notifyCard?: (...args: any[]) => any): AnalystMutationServices {
  return createAnalystMutationServices({
    projectRoot,
    store,
    configAuthority: testConfigAuthority(projectRoot),
    notifyCard,
    cancelCard: async (cardId, reason) => {
      const card = store.read(cardId);
      if (!card) throw new Error(`Card '${cardId}' not found.`);
      store.setStatus(cardId, 'cancelled');
      return { card_id: cardId, status: 'cancelled', cancelled_card_ids: [cardId], reason };
    },
  });
}

export function closeTestProject(_projectRoot: string): void {}
