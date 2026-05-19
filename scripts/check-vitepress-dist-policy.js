#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIST = 'docs/.vitepress/dist';

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function statusEntries(pathspec) {
  return runGit(['status', '--porcelain', '--', pathspec])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function main() {
  const root = runGit(['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);

  const gitignorePath = path.join(root, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const ignoredByPolicy = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === `/${DIST}/` || line === `${DIST}/` || line === DIST);

  const tracked = runGit(['ls-files', DIST])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const dirty = statusEntries(DIST);
  const gitignoreDirty = statusEntries('.gitignore').length > 0;
  const migrationPending = ignoredByPolicy && gitignoreDirty && tracked.length > 0;

  const errors = [];
  if (!ignoredByPolicy) {
    errors.push(`.gitignore must explicitly ignore ${DIST}/ because VitePress output is generated.`);
  }
  if (tracked.length > 0 && !migrationPending) {
    errors.push(`${DIST}/ must not contain tracked files (${tracked.length} tracked file(s) found).`);
  }
  if (dirty.length > 0 && !migrationPending) {
    errors.push(`${DIST}/ must not leave git-visible dirty entries after docs build (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'} found).`);
  }

  if (errors.length > 0) {
    console.error('✗ VitePress dist artifact policy check failed');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    if (tracked.length > 0) {
      console.error('  Tracked examples:');
      for (const file of tracked.slice(0, 10)) {
        console.error(`    ${file}`);
      }
    }
    if (dirty.length > 0) {
      console.error('  Dirty examples:');
      for (const entry of dirty.slice(0, 10)) {
        console.error(`    ${entry}`);
      }
    }
    process.exit(1);
  }

  if (migrationPending) {
    console.log(`✓ VitePress dist artifact policy migration pending: ${DIST}/ is now ignored and tracked generated files will be removed by this commit`);
  } else {
    console.log(`✓ VitePress dist artifact policy enforced: ${DIST}/ is ignored generated output with no tracked or dirty entries`);
  }
}

main();
