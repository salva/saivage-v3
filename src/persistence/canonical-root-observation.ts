import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseCardIndex,
  parseCardVersionArtifact,
  parseCardVersionFilename,
  selectCurrentCardVersion,
  type CardIndexArtifact,
  type CardVersionArtifact,
} from './canonical-card-artifacts.js';

export type RootIndexDiagnostic =
  | { kind: 'absent' }
  | { kind: 'invalid'; message: string }
  | { kind: 'inconsistent'; index: CardIndexArtifact; reasons: readonly string[] }
  | { kind: 'consistent'; index: CardIndexArtifact };

type Immutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : { readonly [Key in keyof T]: Immutable<T[Key]> };

export interface ObservedProjectRoot {
  readonly selected: Immutable<CardVersionArtifact>;
  readonly artifacts: readonly Immutable<CardVersionArtifact>[];
  readonly indexDiagnostic: Immutable<RootIndexDiagnostic>;
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse JSON at '${path}': ${(error as Error).message}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function diagnoseIndex(indexPath: string, artifacts: readonly CardVersionArtifact[], selected: CardVersionArtifact): RootIndexDiagnostic {
  if (!existsSync(indexPath)) return { kind: 'absent' };
  let index: CardIndexArtifact;
  try {
    index = parseCardIndex(parseJson(indexPath), indexPath);
  } catch (error) {
    return { kind: 'invalid', message: (error as Error).message };
  }
  const reasons: string[] = [];
  if (index.card_id !== 'project') reasons.push(`card_id is '${index.card_id}'`);
  if (index.latest !== selected.version) reasons.push(`latest is ${index.latest}, expected ${selected.version}`);
  const artifactVersions = new Set(artifacts.map((artifact) => artifact.version));
  for (const version of Object.keys(index.versions).map(Number)) {
    if (!artifactVersions.has(version)) reasons.push(`version ${version} has no canonical artifact`);
  }
  for (const artifact of artifacts) {
    const entry = index.versions[String(artifact.version)];
    if (!entry) reasons.push(`canonical version ${artifact.version} is absent`);
    else if (entry.committed_at !== artifact.committed_at) reasons.push(`version ${artifact.version} committed_at differs`);
  }
  return reasons.length === 0 ? { kind: 'consistent', index } : { kind: 'inconsistent', index, reasons };
}

/** Strictly observes canonical project artifacts without creating, cleaning, or replacing anything. */
export function observeCanonicalProjectRoot(cardsPath: string): ObservedProjectRoot {
  const versionsPath = join(cardsPath, 'project', 'card', 'versions');
  let entries;
  try {
    entries = readdirSync(versionsPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot enumerate canonical project card versions at '${versionsPath}': ${(error as Error).message}`);
  }

  const artifacts = entries.map((entry) => {
    const path = join(versionsPath, entry.name);
    if (!entry.isFile()) throw new Error(`Canonical project card version entry is not a regular file: '${path}'.`);
    const version = parseCardVersionFilename(entry.name, path);
    return parseCardVersionArtifact(parseJson(path), path, { cardId: 'project', version });
  });
  const selected = selectCurrentCardVersion(artifacts, versionsPath);
  if (
    selected.card_id !== 'project' ||
    selected.card.id !== 'project' ||
    selected.card.parent !== null ||
    selected.card.depth !== 0 ||
    selected.card.position !== 0
  ) {
    throw new Error(`Selected canonical project card at '${join(versionsPath, `${selected.version}.json`)}' is not a root project card.`);
  }

  const indexPath = join(cardsPath, 'project', 'card', 'index.json');
  return deepFreeze({
    selected,
    artifacts: [...artifacts].sort((left, right) => left.version - right.version),
    indexDiagnostic: diagnoseIndex(indexPath, artifacts, selected),
  }) as ObservedProjectRoot;
}
