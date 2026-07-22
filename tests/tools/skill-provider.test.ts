import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createSkillProvider } from '../../src/tools/skill-provider.js';

function temporaryProject(test: (root: string, skillsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'saivage-skill-provider-'));
  const skillsDir = join(root, '.saivage', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return test(root, skillsDir).finally(() => rmSync(root, { recursive: true, force: true }));
}

function writeCatalog(skillsDir: string): void {
  writeFileSync(join(skillsDir, 'index.json'), JSON.stringify([
    { name: 'shared', file: 'shared.md', target_agents: ['executor', 'reviewer'] },
    { name: 'reviewer-skill', file: 'reviewer.md', target_agents: ['reviewer'] },
    { name: 'executor-skill', file: 'executor.md', target_agents: ['executor'] },
    { name: 'broken', file: 'missing.md', target_agents: ['executor'] },
  ]), 'utf8');
  writeFileSync(join(skillsDir, 'shared.md'), 'shared', 'utf8');
  writeFileSync(join(skillsDir, 'reviewer.md'), 'review', 'utf8');
  writeFileSync(join(skillsDir, 'executor.md'), '# Executor Skill\n', 'utf8');
}

describe('SkillProvider', () => {
  it('returns only ordered role-filtered name projections', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurface('executor', [createSkillProvider({ projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTool(surface, 'skill', {})).toEqual({
      success: true,
      data: { skills: [{ name: 'shared' }, { name: 'executor-skill' }, { name: 'broken' }] },
    });
  }));

  it('returns the exact named skill projection without delimiters or metadata', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurface('executor', [createSkillProvider({ projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTool(surface, 'skill', { name: 'executor-skill' })).toEqual({
      success: true,
      data: { skill_name: 'executor-skill', skill_content: '# Executor Skill\n' },
    });
  }));

  it('returns generic model-visible errors for missing, cross-role, and file-read failures', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurface('executor', [createSkillProvider({ projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTool(surface, 'skill', { name: 'missing' })).toEqual({
      success: false,
      error: "Skill 'missing' is unavailable for agent 'executor'.",
    });
    expect(await invokeTool(surface, 'skill', { name: 'reviewer-skill' })).toEqual({
      success: false,
      error: "Skill 'reviewer-skill' is unavailable for agent 'executor'.",
    });
    expect(await invokeTool(surface, 'skill', { name: 'broken' })).toEqual({
      success: false,
      error: expect.stringMatching(/Failed to read skill 'broken' file at .*missing\.md: ENOENT/),
    });
  }));
});
