import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { projectConfigSchema } from '../schemas/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { isReadBlocked } from '../workspace/index.js';
import { observeCanonicalProjectRoot } from './canonical-root-observation.js';
import { appLogFile, runtimeStateFile, saivageCardsRoot, saivageLocksRoot, saivageLogsRoot, saivageStateRoot, saivageWorkRoot } from './layout.js';

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

function isValidProjectConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  try { return projectConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')) as unknown).success; } catch { return false; }
}

function validationHint(projectRoot: string): string {
  return `Legacy .saivage state is not supported. Move it aside or let Saivage discard it under ${join(projectRoot, '.saivage.discarded-<timestamp>')} and restart with empty state.`;
}

export function explainStateValidationRejection(projectRoot: string, stateKind: string, details: string): never {
  throw new Error(`${stateKind} validation failed: ${details}. ${validationHint(projectRoot)}`);
}

export function isInitialized(projectRoot: string): boolean {
  if (!isValidProjectConfig(join(projectRoot, '.saivage', 'project.json'))) return false;
  for (const dir of [saivageCardsRoot(projectRoot), saivageStateRoot(projectRoot), saivageLogsRoot(projectRoot), saivageLocksRoot(projectRoot), saivageWorkRoot(projectRoot)]) {
    try { if (!statSync(dir).isDirectory()) return false; } catch { return false; }
  }
  if (!existsSync(runtimeStateFile(projectRoot)) || !existsSync(appLogFile(projectRoot))) return false;
  try { observeCanonicalProjectRoot(saivageCardsRoot(projectRoot)); return true; } catch { return false; }
}
