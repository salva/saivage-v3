import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // Best-effort directory fsync; not all platforms permit opening a directory.
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // Best-effort cleanup.
    }
  }
}

export async function fsyncDirAsync(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch {
    // Best-effort directory fsync; not all platforms permit opening a directory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeFileAtomic(targetPath: string, data: string): void {
  const lastSep = targetPath.lastIndexOf('/');
  const dir = lastSep >= 0 ? targetPath.slice(0, lastSep) : '.';
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, targetPath);
}

export function writeFileSyncDurable(targetPath: string, data: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'w');
    writeFileSync(fd, data, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
    fsyncDir(dir);
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // Preserve the original write failure.
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}
