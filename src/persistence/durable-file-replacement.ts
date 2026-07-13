import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { IndeterminatePublicationError } from './errors.js';

const TEMPORARY_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEMPORARY_NAME_PATTERN = new RegExp(`^\\.(.+)\\.saivage-write-${TEMPORARY_UUID_PATTERN}\\.tmp$`);
const CLEANUP_ERRORS_PROPERTY = 'cleanupErrors';

export type DurableFileReplacementOptions = {
  mode?: number;
};

export type DurableDirectoryPublicationOptions = {
  mode?: number;
};

function requireAbsolutePath(path: string, subject: string): void {
  const pathBasename = basename(path);
  if (!isAbsolute(path) || pathBasename.length === 0 || join(dirname(path), pathBasename) !== path) {
    throw new TypeError(`${subject} must be an absolute non-root path: ${path}`);
  }
}

function requireExistingDirectory(directoryPath: string): void {
  if (!statSync(directoryPath).isDirectory()) {
    throw new TypeError(`Containing path is not a directory: ${directoryPath}`);
  }
}

function syncDirectory(directoryPath: string): void {
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = openSync(directoryPath, 'r');
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }

  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) throw failure;
}

function attachCleanupErrors(primary: unknown, cleanupErrors: unknown[]): void {
  if (cleanupErrors.length === 0 || (typeof primary !== 'object' && typeof primary !== 'function') || primary === null) {
    return;
  }
  try {
    Object.defineProperty(primary, CLEANUP_ERRORS_PROPERTY, {
      configurable: true,
      enumerable: false,
      value: cleanupErrors,
    });
  } catch {
    // The primary failure remains authoritative when diagnostics cannot be attached.
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function temporaryNamePattern(targetBasename: string): RegExp {
  return new RegExp(`^\\.${escapeRegularExpression(targetBasename)}\\.saivage-write-${TEMPORARY_UUID_PATTERN}\\.tmp$`);
}

export function durableReplacementTemporaryTargetBasename(entryName: string): string | null {
  const match = TEMPORARY_NAME_PATTERN.exec(entryName);
  if (!match) return null;
  const targetBasename = match[1]!;
  try {
    validateTargetBasename(targetBasename);
  } catch {
    return null;
  }
  return targetBasename;
}

function validateTargetBasename(targetBasename: string): void {
  if (
    targetBasename.length === 0 ||
    basename(targetBasename) !== targetBasename ||
    targetBasename === '.' ||
    targetBasename === '..'
  ) {
    throw new TypeError(`Invalid target basename: ${targetBasename}`);
  }
}

/** Replace exactly one existing or new target using a same-directory synchronized rename. */
export function durablyReplaceFile(
  targetPath: string,
  bytes: Uint8Array,
  options: DurableFileReplacementOptions = {},
): void {
  requireAbsolutePath(targetPath, 'Target path');
  const directoryPath = dirname(targetPath);
  requireExistingDirectory(directoryPath);

  const temporaryPath = join(directoryPath, `.${basename(targetPath)}.saivage-write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let temporaryCreated = false;
  let renamed = false;

  try {
    fd = openSync(temporaryPath, 'wx', options.mode ?? 0o600);
    temporaryCreated = true;

    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error(`Write made no progress for ${temporaryPath}`);
      offset += written;
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, targetPath);
    renamed = true;
    temporaryCreated = false;
    syncDirectory(directoryPath);
  } catch (error) {
    if (renamed) {
      throw new IndeterminatePublicationError(targetPath, { cause: error });
    }

    const cleanupErrors: unknown[] = [];
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    attachCleanupErrors(error, cleanupErrors);
    throw error;
  }
}

/** Create one directory and synchronize its publication in its existing parent. */
export function publishDirectory(
  directoryPath: string,
  options: DurableDirectoryPublicationOptions = {},
): void {
  requireAbsolutePath(directoryPath, 'Directory path');
  const parentPath = dirname(directoryPath);
  requireExistingDirectory(parentPath);
  mkdirSync(directoryPath, { mode: options.mode ?? 0o700 });
  syncDirectory(parentPath);
}

/**
 * Remove only exact replacement temporaries belonging to the named targets.
 * Every candidate is validated before the first unlink.
 */
export function cleanupDurableReplacementTemporaries(
  directoryPath: string,
  ownedTargetBasenames: readonly string[],
): void {
  requireAbsolutePath(directoryPath, 'Directory path');
  requireExistingDirectory(directoryPath);
  const patterns = [...new Set(ownedTargetBasenames)].map((targetBasename) => {
    validateTargetBasename(targetBasename);
    return temporaryNamePattern(targetBasename);
  });

  const candidates = readdirSync(directoryPath)
    .filter((entry) => patterns.some((pattern) => pattern.test(entry)))
    .sort();

  for (const entry of candidates) {
    const path = join(directoryPath, entry);
    if (!lstatSync(path).isFile()) {
      throw new TypeError(`Durable replacement temporary is not a regular file: ${path}`);
    }
  }

  for (const entry of candidates) {
    unlinkSync(join(directoryPath, entry));
    syncDirectory(directoryPath);
  }
}
