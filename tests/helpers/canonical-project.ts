import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CardStore as ProductionCardStore, CardStoreRepository } from '../../src/cards/card-store.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { classifyPersistenceOpenMode, createProjectPersistenceAuthority, type ProjectPersistenceAuthority } from '../../src/persistence/project-persistence-authority.js';
import { acquireRuntimeLifecycleLock, bindRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';
import type { EventBus } from '../../src/events/index.js';
import type { ReadModelChanges } from '../../src/application/read-model-changes.js';
import { createResolvedConfigAuthority, type ResolvedConfigAuthority } from '../../src/config/index.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../../src/persistence/project-identity-store.js';

interface TestProjectComposition {
  authority: ProjectPersistenceAuthority;
  lock: RuntimeLifecycleLockHandle;
  repository: CardStoreRepository;
  mutationAuthority: import('../../src/application/mutation-authority.js').CompositionMutationAuthority;
}

const projects = new Map<string, TestProjectComposition>();

function composition(projectRoot: string): TestProjectComposition {
  const existing = projects.get(projectRoot);
  if (existing) return existing;
  const projectJson = join(projectRoot, '.saivage', 'project.json');
  const lock = acquireRuntimeLifecycleLock({ projectRoot, mode: existsSync(projectJson) ? 'bound' : 'init' });
  const { lane, authority: mutationAuthority } = createMutationLane();
  if (!existsSync(projectJson)) {
    const project = new ProjectIdentityStore(projectRoot, lane, mutationAuthority).create(projectRoot.split('/').at(-1) || 'saivage-project');
    bindRuntimeLifecycleLock(lock, projectIdentityDigest(project));
  }
  const mode = classifyPersistenceOpenMode(projectRoot, mutationAuthority, newProjectRootInput(projectRoot));
  const authority = createProjectPersistenceAuthority({ projectRoot, lane, compositionAuthority: mutationAuthority, mode });
  const repository = new CardStoreRepository({ projectRoot, reader: authority.reader, writer: authority.writer });
  const created = { authority, lock, repository, mutationAuthority };
  projects.set(projectRoot, created);
  return created;
}

export function initProjectTree(projectRoot: string): { projectRoot: string } {
  mkdirSync(projectRoot, { recursive: true });
  const alreadyOpen = projects.has(projectRoot);
  const opened = composition(projectRoot);
  for (const relative of ['skills', 'config/prompts', 'agents/conversations', 'instructions', 'work/cards', 'work/processes', 'work/tmp/stash']) mkdirSync(join(projectRoot, '.saivage', relative), { recursive: true });
  const skills = join(projectRoot, '.saivage', 'skills', 'index.json');
  if (!existsSync(skills)) { mkdirSync(dirname(skills), { recursive: true }); writeFileSync(skills, '[]\n'); }
  if (!alreadyOpen) { releaseRuntimeLifecycleLock(opened.lock); projects.delete(projectRoot); }
  return { projectRoot };
}

export function testConfigAuthority(projectRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): ResolvedConfigAuthority {
  return createResolvedConfigAuthority({ path: join(projectRoot, '.saivage', 'saivage.yaml'), source: { kind: 'default' }, interpolationEnvironment: env });
}

export class CardStore extends ProductionCardStore {
  constructor(projectRoot: string, eventBus?: EventBus, readModelChanges?: ReadModelChanges) {
    const opened = composition(projectRoot);
    if (eventBus || readModelChanges) {
      opened.repository = new CardStoreRepository({ projectRoot, reader: opened.authority.reader, writer: opened.authority.writer, eventBus, readModelChanges });
    }
    super(opened.repository, () => opened.mutationAuthority);
  }
}

export function testProjectAuthority(projectRoot: string): ProjectPersistenceAuthority {
  return composition(projectRoot).authority;
}

export function testCardRepository(projectRoot: string): CardStoreRepository {
  return composition(projectRoot).repository;
}

export function testCompositionAuthority(projectRoot: string): import('../../src/application/mutation-authority.js').CompositionMutationAuthority {
  return composition(projectRoot).mutationAuthority;
}

export function closeTestProject(projectRoot: string): void {
  const opened = projects.get(projectRoot);
  if (!opened) return;
  releaseRuntimeLifecycleLock(opened.lock);
  projects.delete(projectRoot);
}
