#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOSSIERS = [
  { name: 'audit-findings', defaultDir: 'audit-findings' },
  { name: 'ui-findings', defaultDir: 'ui-findings' },
];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    auditDir: null,
    uiDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg === '--audit-dir') {
      options.auditDir = argv[++index];
    } else if (arg === '--ui-dir') {
      options.uiDir = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-finding-dossiers.js [options]\n\nOptions:\n  --root <path>       Repository root (default: cwd)\n  --audit-dir <path>  audit-findings dossier path (default: <root>/audit-findings)\n  --ui-dir <path>     ui-findings dossier path (default: <root>/ui-findings)\n`);
}

function resolveDossierDirs(options) {
  const root = path.resolve(options.root ?? process.cwd());
  return [
    {
      name: 'audit-findings',
      dir: path.resolve(root, options.auditDir ?? DOSSIERS[0].defaultDir),
    },
    {
      name: 'ui-findings',
      dir: path.resolve(root, options.uiDir ?? DOSSIERS[1].defaultDir),
    },
  ];
}

function findingIdFromFilename(filename) {
  const match = filename.match(/^(FIND-\d+|UI-\d+)\b/);
  return match?.[1] ?? path.basename(filename, '.md');
}

function lineNumberForIndex(content, index) {
  return content.slice(0, index).split('\n').length;
}

function remediationLog(readmeContent) {
  const match = readmeContent.match(/^##\s+Remediation log\s*$/m);
  if (!match || match.index === undefined) {
    return null;
  }

  const start = match.index + match[0].length;
  const remaining = readmeContent.slice(start);
  const nextHeading = remaining.search(/^##\s+/m);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function checkDossier({ name, dir }) {
  const errors = [];
  const findingsDir = path.join(dir, 'findings');
  const readmePath = path.join(dir, 'README.md');

  if (!existsSync(dir)) {
    errors.push({ kind: 'missing-dossier', file: dir, message: `${name} dossier directory does not exist: ${dir}` });
    return { name, dir, checkedFiles: 0, fixedFindingIds: [], errors };
  }

  if (!existsSync(findingsDir)) {
    errors.push({ kind: 'missing-findings-dir', file: findingsDir, message: `${name} findings directory does not exist: ${findingsDir}` });
    return { name, dir, checkedFiles: 0, fixedFindingIds: [], errors };
  }

  if (!existsSync(readmePath)) {
    errors.push({ kind: 'missing-readme', file: readmePath, message: `${name} README.md does not exist: ${readmePath}` });
  }

  const findingFiles = readdirSync(findingsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const fixedFindingIds = [];

  for (const filename of findingFiles) {
    const file = path.join(findingsDir, filename);
    const content = readFileSync(file, 'utf8');
    const id = findingIdFromFilename(filename);
    const canonicalMatches = Array.from(content.matchAll(/^Status:\s*(\w+)\s*$/gm));
    const statusLikeMatches = Array.from(content.matchAll(/^Status\s*[:\-].*$/gm));

    if (canonicalMatches.length !== 1) {
      errors.push({
        kind: canonicalMatches.length === 0 ? 'missing-status' : 'duplicate-status',
        file,
        message: `${id} must contain exactly one canonical Status line matching /^Status:\\s*\\w+$/m; found ${canonicalMatches.length}`,
      });
    }

    for (const match of statusLikeMatches) {
      if (!/^Status:\s*\w+\s*$/.test(match[0])) {
        errors.push({
          kind: 'non-canonical-status',
          file,
          line: lineNumberForIndex(content, match.index ?? 0),
          message: `${id} has a non-canonical Status-like line: ${match[0]}`,
        });
      }
    }

    if (canonicalMatches.length === 1) {
      const status = canonicalMatches[0][1].toLowerCase();
      if (status === 'fixed') {
        fixedFindingIds.push(id);
        if (!/^##\s+Resolution\s*$/m.test(content)) {
          errors.push({
            kind: 'missing-resolution',
            file,
            message: `${id} is fixed but does not contain a ## Resolution section`,
          });
        }
      }
    }
  }

  if (existsSync(readmePath)) {
    const readmeContent = readFileSync(readmePath, 'utf8');
    const log = remediationLog(readmeContent);
    if (fixedFindingIds.length > 0 && log === null) {
      errors.push({
        kind: 'missing-remediation-log',
        file: readmePath,
        message: `${name} README.md is missing a ## Remediation log section for fixed findings`,
      });
    } else if (log !== null) {
      for (const id of fixedFindingIds) {
        const idPattern = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (!idPattern.test(log)) {
          errors.push({
            kind: 'missing-remediation-log-entry',
            file: readmePath,
            message: `${name} README.md remediation log does not mention fixed finding ${id}`,
          });
        }
      }
    }
  }

  return { name, dir, checkedFiles: findingFiles.length, fixedFindingIds, errors };
}

export function checkFindingDossiers(options = {}) {
  const dossierResults = resolveDossierDirs(options).map(checkDossier);
  const errors = dossierResults.flatMap((result) => result.errors.map((error) => ({ dossier: result.name, ...error })));
  return {
    ok: errors.length === 0,
    dossierResults,
    errors,
    checkedFiles: dossierResults.reduce((sum, result) => sum + result.checkedFiles, 0),
    fixedFindingIds: dossierResults.flatMap((result) => result.fixedFindingIds),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkFindingDossiers(options);

  if (!result.ok) {
    console.error('✗ finding dossier consistency check failed');
    for (const error of result.errors) {
      const line = error.line ? `:${error.line}` : '';
      console.error(`  - [${error.dossier}/${error.kind}] ${error.file}${line}: ${error.message}`);
    }
    process.exit(1);
  }

  const summaries = result.dossierResults
    .map((dossier) => `${dossier.name}: ${dossier.checkedFiles} finding file(s), ${dossier.fixedFindingIds.length} fixed`)
    .join('; ');
  console.log(`✓ finding dossier consistency check passed — ${summaries}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  main();
}
