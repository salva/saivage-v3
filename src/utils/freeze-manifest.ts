import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { freezeManifestSchema } from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';
import type { FreezeManifest } from '../schemas/types.js';

const MANIFEST_FILE = 'freeze-manifest.json';

function manifestPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', MANIFEST_FILE);
}

/**
 * Persist a FreezeManifest to .saivage/runtime/freeze-manifest.json.
 *
 * Validates the manifest against the Zod schema before writing.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param manifest   - The FreezeManifest object to persist.
 * @returns The validated FreezeManifest that was written.
 */
export function saveFreezeManifest(projectRoot: string, manifest: FreezeManifest): FreezeManifest {
  const parsed = freezeManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`FreezeManifest validation failed: ${parsed.error.message}`);
  }
  writeFileAtomic(manifestPath(projectRoot), JSON.stringify(parsed.data, null, 2) + '\n');
  return parsed.data;
}

/**
 * Read and validate a freeze manifest from .saivage/runtime/freeze-manifest.json.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns The validated FreezeManifest, or null if no manifest file exists.
 * @throws If the file exists but fails Zod validation.
 */
export function readFreezeManifest(projectRoot: string): FreezeManifest | null {
  const mp = manifestPath(projectRoot);
  if (!existsSync(mp)) {
    return null;
  }
  const raw = readFileSync(mp, 'utf-8');
  const obj = JSON.parse(raw);
  const parsed = freezeManifestSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(`FreezeManifest validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Delete the freeze manifest from disk.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
export function clearFreezeManifest(projectRoot: string): void {
  const mp = manifestPath(projectRoot);
  if (existsSync(mp)) {
    unlinkSync(mp);
  }
}

/**
 * Check whether a freeze manifest exists on disk.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns true if the manifest file exists.
 */
export function freezeManifestExists(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}
