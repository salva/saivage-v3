import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createSkillProvider } from '../../src/tools/skill-provider.js';

function writeSkill(root: string): void {
  const skillsDir = join(root, '.saivage', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'index.json'), JSON.stringify([
    { name: 'executor-skill', file: 'executor.md', target_agents: ['executor'], triggers: [{ type: 'keyword', pattern: 'exec' }], updated_at: '2026-01-01T00:00:00.000Z' },
    { name: 'reviewer-skill', file: 'reviewer.md', target_agents: ['reviewer'], triggers: [{ type: 'keyword', pattern: 'review' }], updated_at: '2026-01-01T00:00:00.000Z' },
  ], null, 2), 'utf8');
  writeFileSync(join(skillsDir, 'executor.md'), '# Executor Skill\n', 'utf8');
  writeFileSync(join(skillsDir, 'reviewer.md'), '# Reviewer Skill\n', 'utf8');
}

describe('SkillProvider', () => {
  it('lists skills scoped to the provider role', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-skill-provider-'));
    try {
      writeSkill(root);
      const surface = buildInvocationSurface('executor', [createSkillProvider({ projectRoot: root, agentRole: 'executor' })]);
      const result = await invokeTool(surface, 'skill', {});
      expect(result).toEqual({ success: true, data: { skills: [expect.objectContaining({ name: 'executor-skill' })] } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads skill content and returns lookup failures as model-visible errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-skill-provider-'));
    try {
      writeSkill(root);
      const surface = buildInvocationSurface('executor', [createSkillProvider({ projectRoot: root, agentRole: 'executor' })]);
      const loaded = await invokeTool(surface, 'skill', { name: 'executor-skill' });
      expect(loaded).toEqual(expect.objectContaining({ success: true }));
      if (loaded.success) expect(loaded.data).toEqual(expect.objectContaining({ skill_name: 'executor-skill', loaded: true }));

      const missing = await invokeTool(surface, 'skill', { name: 'missing' });
      expect(missing).toEqual({ success: false, error: "Skill 'missing' not found in index" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
