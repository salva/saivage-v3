import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { redactTextForOutbound } from '../redaction/index.js';
import { isReadBlocked } from '../workspace/index.js';
import { parseCardVersionArtifact } from './canonical-card-artifacts.js';
import { saivageCardsRoot } from './layout.js';
import { readProjectIdentity } from './project-identity.js';

export function readProjectFileAtomic(projectRoot: string, relativePath: string, opts?: { redactSecrets?: boolean }): string {
  const cleanPath = relativePath.replace(/^\.\//, '');
  if (isAbsolute(cleanPath)) throw new Error(`Failed to read "${cleanPath}": absolute paths are not allowed.`);
  const root = resolve(projectRoot);
  const absPath = resolve(root, cleanPath);
  const projectRelativePath = relative(root, absPath);
  if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath)) throw new Error(`Failed to read "${cleanPath}": path escapes the project root.`);
  if (isReadBlocked(projectRelativePath)) throw new Error(`Access to "${projectRelativePath}" is blocked for security reasons. This file contains sensitive authentication data and cannot be read by agents.`);
  let content: string;
  try { content = readFileSync(absPath, 'utf-8'); } catch (error) { throw new Error(`Failed to read "${cleanPath}": ${(error as Error).message}`); }
  if (opts?.redactSecrets && projectRelativePath === '.saivage/saivage.yaml') content = redactTextForOutbound(content, 'operator.api', { source: 'file-tree.read-project-file' });
  return content;
}

function validationHint(projectRoot: string): string {
  return `Legacy .saivage state is not supported. Move it aside or let Saivage discard it under ${join(projectRoot, '.saivage.discarded-<timestamp>')} and restart with empty state.`;
}

export function explainStateValidationRejection(projectRoot: string, stateKind: string, details: string): never {
  throw new Error(`${stateKind} validation failed: ${details}. ${validationHint(projectRoot)}`);
}

export function isInitialized(projectRoot: string): boolean {
  try { if (readProjectIdentity(projectRoot) === null) return false; } catch { return false; }
  for (const dir of [saivageCardsRoot(projectRoot)]) {
    try { if (!statSync(dir).isDirectory()) return false; } catch { return false; }
  }
  const rootPath = join(saivageCardsRoot(projectRoot), 'project', 'card', 'versions', '1.json');
  try { parseCardVersionArtifact(JSON.parse(readFileSync(rootPath, 'utf8')), rootPath, { cardId: 'project', version: 1 }); return true; } catch { return false; }
}
