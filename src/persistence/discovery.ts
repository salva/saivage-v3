import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

/**
 * Walk upward from startDir looking for .saivage/saivage.yaml.
 * Returns the directory containing .saivage/ (project root), or null if not found.
 * Stops at filesystem root.
 */
export function findProjectRoot(startDir?: string): string | null {
  let current = resolve(startDir ?? process.cwd());

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const markerPath = join(current, '.saivage', 'saivage.yaml');
    if (existsSync(markerPath)) return current;

    const parent = dirname(current);
    // Stop at filesystem root: when dirname returns the same directory
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
