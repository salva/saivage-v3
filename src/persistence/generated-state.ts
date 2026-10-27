import { lstatSync, type Stats } from 'node:fs';

import type { CardRecord } from '../schemas/index.js';
import { readCard } from './card-files.js';
import { resetOwnedGeneratedRoots, saivageCardsRoot } from './layout.js';

function partialGeneratedState(path: string): Error {
  return new Error(
    `The canonical project card cannot be newly published because generated state exists at '${path}'. ` +
      'All of .saivage/cards, .saivage/agents, .saivage/logs, and .saivage/work must be absent for initial publication. ' +
      'Stop Saivage and choose a separately authorized reset or external recovery. Native Git reset also requires clean delivery and a fresh unused private namespace; existing refs are never adopted or removed.',
  );
}

function lstatExact(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readProjectCardOrAssertInitialPublicationAllowed(
  projectRoot: string,
): CardRecord | null {
  const cardsRoot = saivageCardsRoot(projectRoot);
  const cardsRootStat = lstatExact(cardsRoot);
  if (cardsRootStat !== null) {
    if (!cardsRootStat.isDirectory() || cardsRootStat.isSymbolicLink())
      throw partialGeneratedState(cardsRoot);
    const card = readCard(projectRoot, 'project');
    if (card === null) throw partialGeneratedState(cardsRoot);
    return card;
  }

  for (const path of resetOwnedGeneratedRoots(projectRoot)) {
    if (lstatExact(path) !== null) throw partialGeneratedState(path);
  }
  return null;
}
