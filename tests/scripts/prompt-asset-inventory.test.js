import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANAGER_SPAWNABLE_PROMPT_ROLES,
  PROMPT_INVENTORY_NOTES,
  REQUIRED_PROMPT_FILES,
  RUNTIME_PROMPT_ROLES,
} from '../../scripts/prompt-asset-inventory.js';

const repoRoot = process.cwd();
const promptSourceDir = join(repoRoot, 'src', 'prompts');

describe('prompt asset inventory', () => {
  it('keeps every Manager-spawnable worker role backed by a source prompt asset', () => {
    expect(MANAGER_SPAWNABLE_PROMPT_ROLES).toEqual([
      'coder',
      'critic',
      'data-agent',
      'designer',
      'inspector',
      'researcher',
      'reviewer',
    ]);

    const sourceFiles = readdirSync(promptSourceDir).filter((entry) => entry.endsWith('.md')).sort();
    expect(sourceFiles).toEqual(REQUIRED_PROMPT_FILES);

    for (const role of MANAGER_SPAWNABLE_PROMPT_ROLES) {
      const promptPath = join(promptSourceDir, `${role}.md`);
      expect(existsSync(promptPath)).toBe(true);
      expect(readFileSync(promptPath, 'utf8')).toContain('Prompt Asset');
    }
  });

  it('documents prompt inventory roles that intentionally do not require deployable assets', () => {
    expect(RUNTIME_PROMPT_ROLES).toEqual(['executor', 'planner']);
    expect(PROMPT_INVENTORY_NOTES).toEqual(expect.objectContaining({
      analyst: expect.stringContaining('do not use a deployable dist/prompts asset'),
      chat: expect.stringContaining('not a Manager-spawnable worker role'),
      librarian: expect.stringContaining('not currently dispatched by Manager'),
      manager: expect.stringContaining('does not spawn itself'),
    }));
  });
});
