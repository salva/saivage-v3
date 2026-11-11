import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { skillToolBinders } from '../../src/tools/skill-provider.js';

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
  it('loads the manually provisioned recovery procedure while preserving custom entries and role filtering', async () => temporaryProject(async (root, skillsDir) => {
    const procedure = readFileSync(new URL('../../docs/runbook/analyst-recovery.md', import.meta.url), 'utf8');
    const custom = '# Project recovery notes\n\nContact the project requirement owner.\n';
    const existing = [
      { name: 'project-notes', file: 'project.md', target_agents: ['analyst'] },
      { name: 'delivery-checks', file: 'delivery.md', target_agents: ['executor'] },
    ];
    writeFileSync(join(skillsDir, 'project.md'), custom, 'utf8');
    writeFileSync(join(skillsDir, 'delivery.md'), '# Delivery checks\n', 'utf8');
    writeFileSync(join(skillsDir, 'analyst-runtime-recovery.md'), procedure, 'utf8');
    writeFileSync(join(skillsDir, 'index.json'), JSON.stringify([
      ...existing,
      { name: 'analyst-runtime-recovery', file: 'analyst-runtime-recovery.md', target_agents: ['analyst'] },
    ]), 'utf8');
    const analyst = buildInvocationSurfaceFixture('analyst', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'analyst' })]);
    const executor = buildInvocationSurfaceFixture('executor', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTestTool(analyst, 'skill', {})).toEqual({
      success: true,
      data: { skills: [{ name: 'project-notes' }, { name: 'analyst-runtime-recovery' }] },
    });
    expect(await invokeTestTool(analyst, 'skill', { name: 'analyst-runtime-recovery' })).toEqual({
      success: true,
      data: { skill_name: 'analyst-runtime-recovery', skill_content: procedure },
    });
    expect(await invokeTestTool(analyst, 'skill', { name: 'project-notes' })).toEqual({
      success: true,
      data: { skill_name: 'project-notes', skill_content: custom },
    });
    expect(await invokeTestTool(executor, 'skill', {})).toEqual({
      success: true,
      data: { skills: [{ name: 'delivery-checks' }] },
    });
    expect(await invokeTestTool(executor, 'skill', { name: 'analyst-runtime-recovery' })).toEqual({
      success: false,
      error: "Skill 'analyst-runtime-recovery' is unavailable for agent 'executor'.",
    });
  }));

  it('leaves an unprovisioned Analyst catalog empty and recovery unavailable', async () => temporaryProject(async (root) => {
    const analyst = buildInvocationSurfaceFixture('analyst', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'analyst' })]);
    expect(await invokeTestTool(analyst, 'skill', {})).toEqual({ success: true, data: { skills: [] } });
    expect(await invokeTestTool(analyst, 'skill', { name: 'analyst-runtime-recovery' })).toEqual({
      success: false,
      error: "Skill 'analyst-runtime-recovery' is unavailable for agent 'analyst'.",
    });
  }));

  it('returns only ordered role-filtered name projections', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTestTool(surface, 'skill', {})).toEqual({
      success: true,
      data: { skills: [{ name: 'shared' }, { name: 'executor-skill' }, { name: 'broken' }] },
    });
  }));

  it('returns the exact named skill projection without delimiters or metadata', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTestTool(surface, 'skill', { name: 'executor-skill' })).toEqual({
      success: true,
      data: { skill_name: 'executor-skill', skill_content: '# Executor Skill\n' },
    });
  }));

  it('returns generic model-visible errors for missing, cross-role, and file-read failures', async () => temporaryProject(async (root, skillsDir) => {
    writeCatalog(skillsDir);
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('skill', skillToolBinders, { projectRoot: root, agentName: 'executor' })]);

    expect(await invokeTestTool(surface, 'skill', { name: 'missing' })).toEqual({
      success: false,
      error: "Skill 'missing' is unavailable for agent 'executor'.",
    });
    expect(await invokeTestTool(surface, 'skill', { name: 'reviewer-skill' })).toEqual({
      success: false,
      error: "Skill 'reviewer-skill' is unavailable for agent 'executor'.",
    });
    expect(await invokeTestTool(surface, 'skill', { name: 'broken' })).toEqual({
      success: false,
      error: expect.stringMatching(/Failed to read skill 'broken' file at .*missing\.md: ENOENT/),
    });
  }));
});
