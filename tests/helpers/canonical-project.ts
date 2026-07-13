import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CardStore as ProductionCardStore } from '../../src/cards/card-store.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { openProjectPersistenceAuthority, type ProjectPersistenceAuthority } from '../../src/persistence/project-persistence-authority.js';
import { observeCanonicalProjectRoot } from '../../src/persistence/canonical-root-observation.js';
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
  let normal = false; try { observeCanonicalProjectRoot(join(projectRoot, '.saivage', 'cards')); normal = true; } catch { /* bootstrap below */ }
  const authority = openProjectPersistenceAuthority({ projectRoot, lifecycleLock: lock, mode: normal ? { kind: 'normal' } : { kind: 'bootstrap', root: newProjectRootInput(projectRoot) } });
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

  override create(input: Parameters<ProductionCardStore['create']>[0]): ReturnType<ProductionCardStore['create']> {
    return super.create({ ...input, brief: input.brief.trim() ? input.brief : '# Goal\n\nTest card.\n\n# Instructions\n\nExecute the test.\n\n# Acceptance Criteria\n\n- Complete the test.\n' });
  }
}

export function testProjectAuthority(projectRoot: string): ProjectPersistenceAuthority {
  return composition(projectRoot).authority;
}

function store(projectRoot: string): CardStore { return new CardStore(projectRoot); }
function scratchPath(projectRoot: string, cardId: string, filename: string, version: number): string {
  return join(projectRoot, '.saivage', 'work', 'test-record-bodies', cardId, `${filename}.${version}`);
}
export function openRecordSlot(projectRoot: string, input: { cardId: string; filename: string }): any {
  const record = store(projectRoot).openRecord(input.cardId, input.filename); const absolutePath = scratchPath(projectRoot, input.cardId, input.filename, record.version);
  mkdirSync(dirname(absolutePath), { recursive: true }); if (!existsSync(absolutePath)) writeFileSync(absolutePath, record.artifact.content);
  return { ...record, absolutePath, relativePath: record.recordUrl };
}
export function closeOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string; writer?: any; cardVersionSeq?: number }): any {
  const cardStore = store(projectRoot); const open = cardStore.readRecord(input.cardId, input.filename, 'open'); const path = scratchPath(projectRoot, input.cardId, input.filename, open.version);
  if (existsSync(path)) cardStore.editRecord(input.cardId, input.filename, open.version, readFileSync(path, 'utf8'));
  const writer = input.writer ?? (input.filename === 'review.md' ? 'reviewer' : 'planner');
  return cardStore.closeRecord(input.cardId, input.filename, open.version, writer, input.cardVersionSeq ?? cardStore.read(input.cardId)!.version_seq);
}
export function discardOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string; reason: string }): any {
  const cardStore = store(projectRoot); try { const open = cardStore.readRecord(input.cardId, input.filename, 'open'); return cardStore.discardRecord(input.cardId, input.filename, open.version, input.reason); } catch { return null; }
}
export function readRecordSlotIndex(projectRoot: string, cardId: string, slot: 'brief' | 'status' | 'review'): any {
  const scanned = testProjectAuthority(projectRoot).generation.cards.get(cardId)?.records[slot];
  if (!scanned) return { slot, latest: null, open: null, versions: {} };
  return { slot, latest: scanned.latest?.version ?? null, open: scanned.open?.version ?? null, versions: Object.fromEntries(scanned.artifacts.map((artifact) => [String(artifact.version), { ...artifact, status: artifact.state, cardVersionSeq: artifact.card_version_seq, size: Buffer.byteLength(artifact.content) }])) };
}
export function readClosedRecordSlotMetadata(projectRoot: string, input: { cardId: string; filename: string; version?: number }): any {
  const record = store(projectRoot).readRecord(input.cardId, input.filename, input.version ?? 'latest'); const artifact = record.artifact;
  return { ...record, url: record.recordUrl, writer: artifact.writer, committed_at: artifact.committed_at, size: Buffer.byteLength(artifact.content), format: artifact.format, schema: artifact.schema, cardVersionSeq: artifact.card_version_seq };
}
export function recordFileIsNonEmpty(path: string): boolean { return existsSync(path) && statSync(path).size > 0; }
export function recordSlotDir(projectRoot: string, cardId: string, slot: string): string { return join(projectRoot, '.saivage', 'work', 'test-record-bodies', cardId, slot); }
export function cardByIdPath(projectRoot: string, cardId: string): string { const version = testProjectAuthority(projectRoot).generation.cards.get(cardId)?.current.version ?? 1; return join(projectRoot, '.saivage', 'cards', cardId, 'card', 'versions', `${version}.json`); }
export function cardRecordVersionPath(projectRoot: string, cardId: string, version: number): string { return join(projectRoot, '.saivage', 'cards', cardId, 'card', 'versions', `${version}.json`); }
export function cardHistoryPath(projectRoot: string, cardId: string): string { return join(projectRoot, '.saivage', 'cards', cardId, 'card', 'index.json'); }
