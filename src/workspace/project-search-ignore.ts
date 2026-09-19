import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_SEARCH_IGNORE_FILENAME = '.saivage-search-ignore';

export type ProjectSearchIgnore = ReadonlySet<string>;

function invalidPolicy(fail: (message: string) => Error, reason: string, line?: number): never {
  const location = line === undefined ? PROJECT_SEARCH_IGNORE_FILENAME : `${PROJECT_SEARCH_IGNORE_FILENAME} line ${line}`;
  throw fail(`Invalid ${location}: ${reason}`);
}

export function parseProjectSearchIgnore(bytes: Uint8Array, fail: (message: string) => Error): ProjectSearchIgnore {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalidPolicy(fail, 'file is not valid UTF-8.');
  }
  if (text.startsWith('\uFEFF')) invalidPolicy(fail, 'UTF-8 BOM is not allowed.', 1);

  const roots = new Set<string>();
  for (const [index, rawLine] of text.split('\n').entries()) {
    const entry = rawLine.trim();
    if (entry === '' || entry.startsWith('#')) continue;
    const segments = entry.split('/');
    const invalid = entry.startsWith('/')
      || entry.endsWith('/')
      || entry.startsWith('!')
      || entry.includes('\\')
      || entry.includes(':')
      || /[*?\[\]{}]/u.test(entry)
      || /\p{Cc}/u.test(entry)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..');
    if (invalid) invalidPolicy(fail, 'entry must be a literal project-relative directory path.', index + 1);
    roots.add(entry);
  }
  return roots;
}

export function loadProjectSearchIgnore(projectRoot: string, fail: (message: string) => Error): ProjectSearchIgnore {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(projectRoot, PROJECT_SEARCH_IGNORE_FILENAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw fail(`Cannot read ${PROJECT_SEARCH_IGNORE_FILENAME}.`);
  }
  return parseProjectSearchIgnore(bytes, fail);
}

export function isProjectDirectoryExcluded(policy: ProjectSearchIgnore, projectRelativePath: string): boolean {
  for (const root of policy) {
    if (projectRelativePath === root || projectRelativePath.startsWith(`${root}/`)) return true;
  }
  return false;
}
