import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CardStore as ProductionCardStore } from '../../src/cards/card-store.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { classifyPersistenceOpenMode, openProjectPersistenceAuthority, type ProjectPersistenceAuthority } from '../../src/persistence/project-persistence-authority.js';
import { acquireLock, releaseLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';
import type { EventBus } from '../../src/events/index.js';
import type { ReadModelChanges } from '../../src/application/read-model-changes.js';

interface TestProjectComposition {
  authority: ProjectPersistenceAuthority;
  lock: RuntimeLifecycleLockHandle;
}

const projects = new Map<string, TestProjectComposition>();

function composition(projectRoot: string): TestProjectComposition {
  const existing = projects.get(projectRoot);
  if (existing?.authority.state === 'open') return existing;
  projects.delete(projectRoot);
  const lock = acquireLock(projectRoot);
  const mode = classifyPersistenceOpenMode(projectRoot, lock, newProjectRootInput(projectRoot));
  const authority = openProjectPersistenceAuthority({ projectRoot, lifecycleLock: lock, mode });
  const created = { authority, lock };
  projects.set(projectRoot, created);
  return created;
}

export function initProjectTree(projectRoot: string): { projectRoot: string } {
  const alreadyOpen = projects.get(projectRoot)?.authority.state === 'open';
  const opened = composition(projectRoot);
  for (const relative of ['skills', 'config/prompts', 'agents/conversations', 'instructions', 'work/cards', 'work/processes', 'work/tmp/stash']) mkdirSync(join(projectRoot, '.saivage', relative), { recursive: true });
  const projectJson = join(projectRoot, '.saivage', 'project.json');
  if (!existsSync(projectJson)) { const stamp = new Date().toISOString(); writeFileSync(projectJson, `${JSON.stringify({ id: 'project', name: projectRoot.split('/').at(-1) || 'saivage-project', context: '', goals_summary: '', constraints: [], planner_enabled: true, created_at: stamp, updated_at: stamp }, null, 2)}\n`); }
  const config = join(projectRoot, '.saivage', 'saivage.yaml');
  if (!existsSync(config)) writeFileSync(config, 'server:\n  host: "0.0.0.0"\n  port: 8080\nruntime: {}\n');
  const skills = join(projectRoot, '.saivage', 'skills', 'index.json');
  if (!existsSync(skills)) { mkdirSync(dirname(skills), { recursive: true }); writeFileSync(skills, '[]\n'); }
  if (!alreadyOpen) { opened.authority.close(); releaseLock(opened.lock); projects.delete(projectRoot); }
  return { projectRoot };
}

export class CardStore extends ProductionCardStore {
  constructor(projectRoot: string, eventBus?: EventBus, readModelChanges?: ReadModelChanges) {
    const { authority } = composition(projectRoot);
    super({ projectRoot, reader: authority.reader, writer: authority.writer, eventBus, readModelChanges });
  }
}

export function testProjectAuthority(projectRoot: string): ProjectPersistenceAuthority {
  return composition(projectRoot).authority;
}

export function closeTestProject(projectRoot: string): void {
  const opened = projects.get(projectRoot);
  if (!opened) return;
  opened.authority.close();
  releaseLock(opened.lock);
  projects.delete(projectRoot);
}
