import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectConfigSchema, type ProjectConfig } from '../schemas/index.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';

const projectIdentitySchema = projectConfigSchema.strict();

export function parseProjectIdentity(raw: unknown, path: string): ProjectConfig {
  const parsed = projectIdentitySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Project identity is invalid at '${path}': ${parsed.error.issues[0]?.message ?? 'schema mismatch'}.`);
  return parsed.data;
}

export function readProjectIdentity(projectRoot: string): ProjectConfig | null {
  const path = join(projectRoot, '.saivage', 'project.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Project identity is unreadable at '${path}': ${(error as Error).message}.`);
  }
  return parseProjectIdentity(raw, path);
}

export function projectIdentityDigest(project: Pick<ProjectConfig, 'id' | 'created_at'>): string {
  return createHash('sha256').update(JSON.stringify({ id: project.id, created_at: project.created_at })).digest('hex');
}

export function createProjectIdentity(projectRoot: string, name: string, publicationTemporaryId?: PublicationTemporaryIdFactory): ProjectConfig {
    const path = join(projectRoot, '.saivage', 'project.json');
    if (readProjectIdentity(projectRoot)) throw new Error(`Project identity already exists at '${path}'.`);
    const stamp = new Date().toISOString();
    const project = parseProjectIdentity({
      id: 'project', name, context: '', goals_summary: '', constraints: [], planner_enabled: true,
      created_at: stamp, updated_at: stamp,
    }, path);
    replaceFile(path, Buffer.from(`${JSON.stringify(project, null, 2)}\n`), publicationTemporaryId);
    return project;
}
