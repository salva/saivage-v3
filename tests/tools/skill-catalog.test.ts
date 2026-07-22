import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillCatalog } from '../../src/tools/skill-catalog.js';

function temporaryProject(test: (root: string, skillsDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'saivage-skill-catalog-'));
  const skillsDir = join(root, '.saivage', 'skills');
  try {
    test(root, skillsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeIndex(skillsDir: string, entries: unknown): void {
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'index.json'), JSON.stringify(entries), 'utf8');
}

describe('SkillCatalog', () => {
  it('lists names in index order for the requested role', () => temporaryProject((root, skillsDir) => {
    writeIndex(skillsDir, [
      { name: 'shared', file: 'shared.md', target_agents: ['reviewer', 'executor'] },
      { name: 'review-only', file: 'review.md', target_agents: ['reviewer'] },
      { name: 'second', file: 'nested/second.md', target_agents: ['executor'] },
    ]);

    expect(new SkillCatalog(root).list('executor')).toEqual([{ name: 'shared' }, { name: 'second' }]);
  }));

  it('reads exact file text only for a targeted role', () => temporaryProject((root, skillsDir) => {
    writeIndex(skillsDir, [{ name: 'review', file: 'nested/review.md', target_agents: ['reviewer'] }]);
    mkdirSync(join(skillsDir, 'nested'));
    writeFileSync(join(skillsDir, 'nested', 'review.md'), '# Review\n\nExact text.\n', 'utf8');
    const catalog = new SkillCatalog(root);

    expect(catalog.read('reviewer', 'review')).toEqual({ name: 'review', content: '# Review\n\nExact text.\n' });
    expect(() => catalog.read('executor', 'review')).toThrow("Skill 'review' is unavailable for agent 'executor'.");
  }));

  it('accepts an empty index', () => temporaryProject((root, skillsDir) => {
    writeIndex(skillsDir, []);
    expect(new SkillCatalog(root).list('analyst')).toEqual([]);
  }));

  it('does not cache an absent index', () => temporaryProject((root, skillsDir) => {
    const catalog = new SkillCatalog(root);
    expect(catalog.list('executor')).toEqual([]);

    writeIndex(skillsDir, [{ name: 'later', file: 'later.md', target_agents: ['executor'] }]);
    expect(catalog.list('executor')).toEqual([{ name: 'later' }]);
  }));

  it('treats an absent index as unavailable for reads and reports a missing selected file', () => temporaryProject((root, skillsDir) => {
    const catalog = new SkillCatalog(root);
    expect(() => catalog.read('analyst', 'missing')).toThrow("Skill 'missing' is unavailable for agent 'analyst'.");

    writeIndex(skillsDir, [{ name: 'present', file: 'missing.md', target_agents: ['analyst'] }]);
    expect(() => catalog.read('analyst', 'present')).toThrow(/Failed to read skill 'present' file at .*missing\.md: ENOENT/);
  }));

  it('reports invalid JSON and rejects old fields strictly', () => temporaryProject((root, skillsDir) => {
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'index.json'), '{broken', 'utf8');
    const catalog = new SkillCatalog(root);
    expect(() => catalog.list('executor')).toThrow(/Failed to parse skill index at .*index\.json/);

    writeIndex(skillsDir, [{
      name: 'old',
      file: 'old.md',
      target_agents: ['executor'],
      triggers: [{ type: 'keyword', pattern: 'old' }],
      updated_at: '2026-01-01T00:00:00.000Z',
    }]);
    expect(() => catalog.list('executor')).toThrow(/Invalid skill index at[\s\S]*Unrecognized key/);
  }));

  it.each([
    ['empty name', [{ name: '', file: 'one.md', target_agents: ['executor'] }]],
    ['duplicate name', [
      { name: 'same', file: 'one.md', target_agents: ['executor'] },
      { name: 'same', file: 'two.md', target_agents: ['reviewer'] },
    ]],
    ['empty target roles', [{ name: 'one', file: 'one.md', target_agents: [] }]],
    ['duplicate target role', [{ name: 'one', file: 'one.md', target_agents: ['executor', 'executor'] }]],
    ['absolute file', [{ name: 'one', file: '/outside.md', target_agents: ['executor'] }]],
    ['Windows absolute file', [{ name: 'one', file: 'C:/outside.md', target_agents: ['executor'] }]],
    ['parent file segment', [{ name: 'one', file: '../outside.md', target_agents: ['executor'] }]],
    ['dot file segment', [{ name: 'one', file: 'nested/./one.md', target_agents: ['executor'] }]],
    ['empty file segment', [{ name: 'one', file: 'nested//one.md', target_agents: ['executor'] }]],
    ['trailing empty file segment', [{ name: 'one', file: 'nested/', target_agents: ['executor'] }]],
    ['backslash separator', [{ name: 'one', file: 'nested\\one.md', target_agents: ['executor'] }]],
  ])('rejects %s', (_label, entries) => temporaryProject((root, skillsDir) => {
    writeIndex(skillsDir, entries);
    expect(() => new SkillCatalog(root).list('executor')).toThrow(/Invalid skill index at .*index\.json/);
  }));
});
