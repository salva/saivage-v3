import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { projectConfigSchema, type ProjectConfig } from '../schemas/index.js';
import type { CompositionMutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';
import { durablyReplaceFile } from './durable-file-replacement.js';

const projectIdentitySchema = projectConfigSchema.strict();

export function parseProjectIdentity(raw: unknown, path: string): ProjectConfig {
  const parsed = projectIdentitySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Project identity is invalid at '${path}': ${parsed.error.issues[0]?.message ?? 'schema mismatch'}.`);
  return parsed.data;
}

export function readProjectIdentity(projectRoot: string): ProjectConfig | null {
  const path = join(projectRoot, '.saivage', 'project.json');
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Project identity is unreadable at '${path}': ${(error as Error).message}.`);
  }
  return parseProjectIdentity(raw, path);
}

export function projectIdentityDigest(project: Pick<ProjectConfig, 'id' | 'created_at'>): string {
  return createHash('sha256').update(JSON.stringify({ id: project.id, created_at: project.created_at })).digest('hex');
}

export class ProjectIdentityStore {
  readonly #path: string;

  constructor(
    projectRoot: string,
    private readonly lane: MutationLane,
    private readonly compositionAuthority: CompositionMutationAuthority,
  ) {
    this.#path = join(projectRoot, '.saivage', 'project.json');
  }

  read(): ProjectConfig | null {
    return readProjectIdentity(dirname(dirname(this.#path)));
  }

  create(name: string): ProjectConfig {
    const result = this.lane.apply(this.compositionAuthority, 'create project identity', () => {
      if (existsSync(this.#path)) throw new Error(`Project identity already exists at '${this.#path}'.`);
      const stamp = new Date().toISOString();
      const project = parseProjectIdentity({
        id: 'project',
        name,
        context: '',
        goals_summary: '',
        constraints: [],
        planner_enabled: true,
        created_at: stamp,
        updated_at: stamp,
      }, this.#path);
      mkdirSync(dirname(this.#path), { recursive: true });
      durablyReplaceFile(this.#path, Buffer.from(`${JSON.stringify(project, null, 2)}\n`));
      return project;
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
    return result.value;
  }
}
