import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CardStore as ProductionCardStore, CardStoreRepository } from '../../src/cards/card-store.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { classifyPersistenceOpenMode, createProjectStoreRepository, type ProjectStoreRepository } from '../../src/persistence/project-store-repository.js';
import { acquireRuntimeLifecycleLock, bindRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';
import type { EventBus } from '../../src/events/index.js';
import type { ReadModelChanges } from '../../src/application/read-model-changes.js';
import { createResolvedConfigAuthority, type ResolvedConfigAuthority } from '../../src/config/index.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../../src/persistence/project-identity-store.js';
import { AuthProfileRepository } from '../../src/auth/auth-profile-store.js';

interface TestProjectComposition {
  authority: ProjectStoreRepository;
  lock: RuntimeLifecycleLockHandle;
  repository: CardStoreRepository;
  persistenceHealth: ApplicationPersistenceHealth;
}

const projects = new Map<string, TestProjectComposition>();

function composition(projectRoot: string): TestProjectComposition {
  const existing = projects.get(projectRoot);
  if (existing) return existing;
  const projectJson = join(projectRoot, '.saivage', 'project.json');
  const lock = acquireRuntimeLifecycleLock({ projectRoot, mode: existsSync(projectJson) ? 'bound' : 'init' });
  const persistenceHealth = new ApplicationPersistenceHealth();
  if (!existsSync(projectJson)) {
    const project = new ProjectIdentityStore(projectRoot, persistenceHealth).create(projectRoot.split('/').at(-1) || 'saivage-project');
    bindRuntimeLifecycleLock(lock, projectIdentityDigest(project));
  }
  const mode = classifyPersistenceOpenMode(projectRoot, newProjectRootInput(projectRoot));
  const authority = createProjectStoreRepository({ projectRoot, persistenceHealth, mode });
  const repository = new CardStoreRepository({ projectRoot, reader: authority.reader, writer: authority.writer });
  const created = { authority, lock, repository, persistenceHealth };
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
  return createResolvedConfigAuthority({ path: join(projectRoot, '.saivage', 'saivage.yaml'), source: { kind: 'default' }, interpolationEnvironment: env, health: composition(projectRoot).persistenceHealth });
}

export class CardStore extends ProductionCardStore {
  constructor(projectRoot: string, eventBus?: EventBus, readModelChanges?: ReadModelChanges) {
    const opened = composition(projectRoot);
    if (eventBus || readModelChanges) {
      opened.repository = new CardStoreRepository({ projectRoot, reader: opened.authority.reader, writer: opened.authority.writer, eventBus, readModelChanges });
    }
    super(opened.repository);
  }
}

export function testProjectAuthority(projectRoot: string): ProjectStoreRepository {
  return composition(projectRoot).authority;
}

export function testCardRepository(projectRoot: string): CardStoreRepository {
  return composition(projectRoot).repository;
}

export function testPersistenceHealth(projectRoot: string): ApplicationPersistenceHealth {
  return composition(projectRoot).persistenceHealth;
}

export function testInterventionReadiness(): RuntimeInterventionBinding {
  const readiness = new RuntimeInterventionBinding();
  readiness.markStoppedReady();
  return readiness;
}

export function testAuthProfiles(projectRoot: string): AuthProfileRepository {
  const opened = composition(projectRoot);
  const repository = new AuthProfileRepository(projectRoot, opened.persistenceHealth);
  repository.restabilize();
  return repository;
}

export function closeTestProject(projectRoot: string): void {
  const opened = projects.get(projectRoot);
  if (!opened) return;
  releaseRuntimeLifecycleLock(opened.lock);
  projects.delete(projectRoot);
}
