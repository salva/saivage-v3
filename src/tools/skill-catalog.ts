import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { skillIndexSchema, type SkillIndexEntry, type SkillTargetRole } from '../schemas/index.js';

export interface SkillCatalogItem {
  readonly name: string;
}

export interface SkillCatalogContent {
  readonly name: string;
  readonly content: string;
}

export class SkillCatalog {
  private readonly skillsPath: string;
  private readonly indexPath: string;

  constructor(projectRoot: string) {
    this.skillsPath = resolve(projectRoot, '.saivage', 'skills');
    this.indexPath = join(this.skillsPath, 'index.json');
  }

  list(role: SkillTargetRole): SkillCatalogItem[] {
    return this.loadIndex()
      .filter((entry) => entry.target_agents.includes(role))
      .map((entry) => ({ name: entry.name }));
  }

  read(role: SkillTargetRole, name: string): SkillCatalogContent {
    const entry = this.loadIndex().find((candidate) => candidate.name === name && candidate.target_agents.includes(role));
    if (!entry) throw new Error(`Skill '${name}' is unavailable for role '${role}'.`);

    const filePath = resolve(this.skillsPath, entry.file);
    const relativePath = relative(this.skillsPath, filePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || resolve(this.skillsPath, relativePath) !== filePath) {
      throw new Error(`Skill '${name}' file escapes the skills directory: ${entry.file}`);
    }

    try {
      return { name: entry.name, content: readFileSync(filePath, 'utf8') };
    } catch (error) {
      throw new Error(`Failed to read skill '${name}' file at ${filePath}: ${errorMessage(error)}`, { cause: error });
    }
  }

  private loadIndex(): SkillIndexEntry[] {
    let text: string;
    try {
      text = readFileSync(this.indexPath, 'utf8');
    } catch (error) {
      if (isEnoent(error)) return [];
      throw new Error(`Failed to read skill index at ${this.indexPath}: ${errorMessage(error)}`, { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse skill index at ${this.indexPath}: ${errorMessage(error)}`, { cause: error });
    }

    const parsed = skillIndexSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid skill index at ${this.indexPath}: ${parsed.error.message}`, { cause: parsed.error });
    return parsed.data;
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error);
}
