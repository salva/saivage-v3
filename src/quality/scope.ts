import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { isReadBlocked, resolveContainedProjectPath } from '../workspace/index.js';

function privatePath(path: string): boolean {
  return (
    path.split('/').some((part) => ['.saivage', '.saivage-work', '.git'].includes(part)) ||
    isReadBlocked(path)
  );
}

/** Ordinary target-source traversal only. No canonical namespace inventory. */
export function selectQualityScope(args: {
  root: string;
  sourcePaths: readonly string[];
  exclusions: readonly string[];
  language: 'javascript' | 'typescript' | 'python';
  resolveReadablePath(path: string): string;
}) {
  const admit = (path: string): string => {
    if (privatePath(path)) throw new Error('Quality scope cannot select private/runtime paths.');
    const checked = resolveContainedProjectPath(args.root, path);
    if (
      !checked.safe ||
      !checked.relativePath ||
      privatePath(checked.relativePath) ||
      (checked.realTargetProjectRelativePath && privatePath(checked.realTargetProjectRelativePath))
    )
      throw new Error('Quality input is outside allowed project source.');
    return args.resolveReadablePath(path);
  };
  const excluded = args.exclusions.map((path) => {
    const absolute = admit(path);
    return { path, absolute: existsSync(absolute) ? realpathSync(absolute) : resolve(absolute) };
  });
  const files: string[] = [];
  const skipped: Array<{ path: string; reason: 'excluded' | 'unsupported' | 'unmatched' }> = [];
  const visited = new Set<string>();
  const extensions =
    args.language === 'python'
      ? ['.py', '.pyi']
      : args.language === 'typescript'
        ? ['.ts', '.tsx', '.mts', '.cts']
        : ['.js', '.jsx', '.mjs', '.cjs'];
  let visitedCount = 0;
  const visit = (path: string) => {
    if (++visitedCount > 10000) throw new Error('Quality source scope exceeds10000 entries.');
    const absolute = admit(path);
    if (!existsSync(absolute)) {
      skipped.push({ path, reason: 'unmatched' });
      return;
    }
    const actual = realpathSync(absolute);
    if (
      excluded.some((entry) => actual === entry.absolute || actual.startsWith(`${entry.absolute}/`))
    ) {
      skipped.push({ path, reason: 'excluded' });
      return;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const stat = statSync(actual);
    if (stat.isDirectory()) {
      const names = readdirSync(actual).sort();
      if (names.length === 0) skipped.push({ path, reason: 'unmatched' });
      for (const name of names) visit(join(path, name));
    } else if (stat.isFile() && extensions.includes(extname(path))) {
      files.push(actual);
      if (files.length > 2000) throw new Error('Quality source scope exceeds2000 files.');
    } else skipped.push({ path, reason: 'unsupported' });
  };
  for (const path of args.sourcePaths) visit(path);
  return {
    files: files.sort(),
    skipped,
    exclusions: args.exclusions,
    admit,
    display: (path: string) => relative(realpathSync(args.root), path),
  };
}
