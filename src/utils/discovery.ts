import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

/**
 * Walk upward from startDir looking for .saivage/saivage.json.
 * Returns the directory containing .saivage/ (project root), or null if not found.
 * Stops at filesystem root.
 */
export function findProjectRoot(startDir?: string): string | null {
  let current = resolve(startDir ?? process.cwd());

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const markerPath = join(current, '.saivage', 'saivage.json');
    try {
      accessSync(markerPath, constants.R_OK);
      return current;
    } catch {
      // marker not found at this level, go up
    }

    const parent = dirname(current);
    // Stop at filesystem root: when dirname returns the same directory
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Find the project root and load saivage.json from it.
 * Returns the parsed JSON content, or null if no project found.
 * Throws if saivage.json exists but has invalid JSON syntax.
 */
export function loadProjectConfig(
  startDir?: string,
): Record<string, unknown> | null {
  const root = findProjectRoot(startDir);
  if (root === null) {
    return null;
  }

  const configPath = join(root, '.saivage', 'saivage.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Convenience: find project root and return the path to .saivage/ dir.
 * Returns null if no project found.
 */
export function findSaivageDir(startDir?: string): string | null {
  const root = findProjectRoot(startDir);
  if (root === null) {
    return null;
  }
  return join(root, '.saivage');
}
