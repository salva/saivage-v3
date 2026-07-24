import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { runtimeProcessLockFile } from '../persistence/layout.js';
import { replaceFile } from '../persistence/replace-file.js';
import { parseProjectIdentity, projectIdentityDigest, readProjectIdentity } from '../persistence/project-identity.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';

export interface RuntimeControlEndpoint {
  readonly origin: string;
  readonly auth: 'disabled' | 'bearer';
}

interface RuntimeLockOwnerBase {
  readonly format_version: 1;
  readonly instance_id: string;
  readonly pid: number;
  readonly process_start_identity: string;
  readonly started_at: string;
  readonly canonical_root_hash: string;
}

export type RuntimeLockOwnerRecord = RuntimeLockOwnerBase & (
  | { readonly lock_state: 'bootstrap_unbound'; readonly project_identity: null; readonly control_endpoint: null }
  | { readonly lock_state: 'bound'; readonly project_identity: string; readonly control_endpoint: RuntimeControlEndpoint | null }
);

export type RuntimeLockBlocker =
  | { readonly kind: 'live'; readonly record: RuntimeLockOwnerRecord }
  | { readonly kind: 'dead'; readonly record: RuntimeLockOwnerRecord; readonly repairInstruction: string }
  | { readonly kind: 'indeterminate'; readonly repairInstruction: string; readonly detail: string }
  | { readonly kind: 'malformed'; readonly repairInstruction: string; readonly detail: string };

export type RuntimeLockStatus = { readonly kind: 'missing' } | RuntimeLockBlocker;

export interface RuntimeLockConfig {
  readonly lockFilePath?: string;
  readonly readProcessStartIdentity?: (pid: number) => string;
  readonly probeProcess?: (pid: number) => 'live' | 'dead' | 'indeterminate';
  readonly publicationIo?: RuntimeLockPublicationIo;
}
export interface RuntimeLockPublicationIo { open: typeof openSync; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync }
const runtimeLockPublicationIo: RuntimeLockPublicationIo = { open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync };

declare const runtimeLifecycleLockHandleBrand: unique symbol;
export interface RuntimeLifecycleLockHandle { readonly [runtimeLifecycleLockHandleBrand]: never }
export interface RuntimeProcessIdentity { readonly pid: number; readonly startedAt: string }

interface RuntimeLifecycleLockOwnership {
  active: boolean;
  readonly canonicalProjectRoot: string;
  readonly canonicalRootHash: string;
  readonly lockFilePath: string;
  record: RuntimeLockOwnerRecord;
}

const ownershipByHandle = new WeakMap<object, RuntimeLifecycleLockOwnership>();

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function lockPath(projectRoot: string, config?: RuntimeLockConfig): string {
  return config?.lockFilePath ?? runtimeProcessLockFile(projectRoot);
}

function canonicalRootHash(root: string): string {
  return createHash('sha256').update(root).digest('hex');
}

function readProcStartIdentity(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error(`Cannot parse process start identity for PID ${pid}.`);
  const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/u);
  const startTime = fieldsFromState[19];
  if (!startTime || !/^\d+$/u.test(startTime)) throw new Error(`Cannot parse process start identity for PID ${pid}.`);
  return startTime;
}

function defaultProbeProcess(pid: number): 'live' | 'dead' | 'indeterminate' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return 'dead';
    return 'indeterminate';
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function parseRuntimeLockOwnerRecord(value: unknown): RuntimeLockOwnerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('lock record must be an object');
  const record = value as Record<string, unknown>;
  const commonKeys = ['canonical_root_hash', 'format_version', 'instance_id', 'lock_state', 'pid', 'process_start_identity', 'project_identity', 'started_at', 'control_endpoint'];
  if (Object.keys(record).sort().join(',') !== commonKeys.sort().join(',')) throw new Error('lock record has unsupported fields');
  if (record.format_version !== 1) throw new Error('unsupported lock format version');
  if (typeof record.instance_id !== 'string' || record.instance_id.length === 0) throw new Error('invalid instance identity');
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) throw new Error('invalid PID');
  if (typeof record.process_start_identity !== 'string' || record.process_start_identity.length === 0) throw new Error('invalid process start identity');
  if (!isIsoTimestamp(record.started_at)) throw new Error('invalid started_at');
  if (typeof record.canonical_root_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.canonical_root_hash)) throw new Error('invalid canonical root hash');
  if (record.lock_state === 'bootstrap_unbound') {
    if (record.project_identity !== null || record.control_endpoint !== null) throw new Error('invalid bootstrap-unbound identity or endpoint');
    return record as unknown as RuntimeLockOwnerRecord;
  }
  if (record.lock_state !== 'bound' || typeof record.project_identity !== 'string' || !/^[a-f0-9]{64}$/u.test(record.project_identity)) throw new Error('invalid bound project identity');
  if (record.control_endpoint !== null) {
    if (typeof record.control_endpoint !== 'object' || Array.isArray(record.control_endpoint)) throw new Error('invalid control endpoint');
    const endpoint = record.control_endpoint as Record<string, unknown>;
    if (Object.keys(endpoint).sort().join(',') !== 'auth,origin' || typeof endpoint.origin !== 'string' || (endpoint.auth !== 'disabled' && endpoint.auth !== 'bearer')) throw new Error('invalid control endpoint');
    let url: URL;
    try { url = new URL(endpoint.origin); } catch { throw new Error('invalid control endpoint origin'); }
    if (url.origin !== endpoint.origin || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Error('invalid control endpoint origin');
  }
  return record as unknown as RuntimeLockOwnerRecord;
}

function readRecord(path: string): RuntimeLockOwnerRecord {
  return parseRuntimeLockOwnerRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function repairInstruction(canonicalProjectRoot: string, path: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return `Verify that no Saivage process owns ${quote(canonicalProjectRoot)}, then remove the abandoned lock manually with: rm -- ${quote(path)}; rerun the command.`;
}

export function readRuntimeLockStatus(projectRoot: string, config?: RuntimeLockConfig): RuntimeLockStatus {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const path = lockPath(canonicalProjectRoot, config);
  let bytes: string;
  try {
    bytes = readFileSync(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
    return { kind: 'indeterminate', detail: `cannot read lifecycle lock: ${(error as Error).message}`, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  }
  let record: RuntimeLockOwnerRecord;
  try {
    record = parseRuntimeLockOwnerRecord(JSON.parse(bytes) as unknown);
  } catch (error) {
    return { kind: 'malformed', detail: (error as Error).message, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  }
  if (record.canonical_root_hash !== canonicalRootHash(canonicalProjectRoot)) return { kind: 'malformed', detail: 'lifecycle lock belongs to a different project root', repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  if (record.lock_state === 'bound') {
    const identityPath = join(canonicalProjectRoot, '.saivage', 'project.json');
    let identityBytes: string;
    try { identityBytes = readFileSync(identityPath, 'utf8'); }
    catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'malformed', detail: 'bound lifecycle lock has no canonical project identity', repairInstruction: repairInstruction(canonicalProjectRoot, path) };
      return { kind: 'indeterminate', detail: `cannot verify project identity: ${(error as Error).message}`, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
    }
    let project;
    try { project = parseProjectIdentity(JSON.parse(identityBytes) as unknown, identityPath); }
    catch (error) { return { kind: 'malformed', detail: (error as Error).message, repairInstruction: repairInstruction(canonicalProjectRoot, path) }; }
    if (projectIdentityDigest(project) !== record.project_identity) return { kind: 'malformed', detail: 'lifecycle lock project identity does not match the canonical project identity', repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  }
  const probe = (config?.probeProcess ?? defaultProbeProcess)(record.pid);
  if (probe === 'dead') return { kind: 'dead', record, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  if (probe === 'indeterminate') return { kind: 'indeterminate', detail: `cannot prove ownership of PID ${record.pid}`, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
  let actualStart: string;
  try { actualStart = (config?.readProcessStartIdentity ?? readProcStartIdentity)(record.pid); } catch (error) { return { kind: 'indeterminate', detail: `cannot verify process start identity for PID ${record.pid}: ${(error as Error).message}`, repairInstruction: repairInstruction(canonicalProjectRoot, path) }; }
  if (actualStart === record.process_start_identity) return { kind: 'live', record };
  return { kind: 'dead', record, repairInstruction: repairInstruction(canonicalProjectRoot, path) };
}

export function isLocked(projectRoot: string, config?: RuntimeLockConfig): boolean {
  const status = readRuntimeLockStatus(projectRoot, config);
  if (status.kind === 'missing') return false;
  if (status.kind === 'live') return true;
  throw blockerError(status);
}

function blockerError(status: RuntimeLockBlocker): Error {
  if (status.kind === 'live') return new Error(`Runtime lock is held by live PID ${status.record.pid}; stop and verify the current owner before retrying.`);
  if (status.kind === 'dead') return new Error(`Runtime lock owner is positively dead. ${status.repairInstruction}`);
  if (status.kind === 'indeterminate') return new Error(`Runtime lock ownership is indeterminate (${status.detail}). ${status.repairInstruction}`);
  return new Error(`Runtime lock is malformed (${status.detail}). ${status.repairInstruction}`);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function acquireRuntimeLifecycleLock(input: {
  readonly projectRoot: string;
  readonly mode: 'init' | 'bound';
  readonly config?: RuntimeLockConfig;
}): RuntimeLifecycleLockHandle {
  const canonicalProjectRoot = realpathSync(input.projectRoot);
  const path = lockPath(canonicalProjectRoot, input.config);
  const project = readProjectIdentity(canonicalProjectRoot);
  if (input.mode === 'bound' && project === null) throw new Error(`Project identity is missing; run 'saivage init' first.`);
  const readStart = input.config?.readProcessStartIdentity ?? readProcStartIdentity;
  let processStartIdentity: string;
  try { processStartIdentity = readStart(process.pid); } catch (error) { throw new Error(`Cannot acquire runtime lock without the current process start identity: ${(error as Error).message}`); }
  mkdirSync(dirname(path), { recursive: true });
  const base = {
    format_version: 1 as const,
    instance_id: randomUUID(),
    pid: process.pid,
    process_start_identity: processStartIdentity,
    started_at: new Date().toISOString(),
    canonical_root_hash: canonicalRootHash(canonicalProjectRoot),
  };
  const record: RuntimeLockOwnerRecord = project === null
    ? { ...base, lock_state: 'bootstrap_unbound', project_identity: null, control_endpoint: null }
    : { ...base, lock_state: 'bound', project_identity: projectIdentityDigest(project), control_endpoint: null };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const io = input.config?.publicationIo ?? runtimeLockPublicationIo;
  let fd: number;
  try {
    fd = io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      const status = readRuntimeLockStatus(canonicalProjectRoot, input.config);
      if (status.kind === 'missing') throw new Error('Runtime lock disappeared after the single acquisition attempt; rerun the command.');
      throw blockerError(status);
    }
    throw error;
  }
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      let written: number;
      try { written = io.write(fd, bytes, offset, bytes.byteLength - offset); }
      catch (error) {
        if (offset === 0 && (error as NodeJS.ErrnoException & { bytesWritten?: number }).code === 'EINTR' && (error as { bytesWritten?: number }).bytesWritten === 0) continue;
        throw error;
      }
      if (written === 0) throw new Error('zero progress');
      offset += written;
    }
    io.fsync(fd);
    io.close(fd);
    const parentFd = io.open(dirname(path), constants.O_RDONLY);
    io.fsync(parentFd);
    io.close(parentFd);
  } catch { throw new PublicationOutcomeUnknownError(); }
  const handle = {} as RuntimeLifecycleLockHandle;
  ownershipByHandle.set(handle, { active: true, canonicalProjectRoot, canonicalRootHash: base.canonical_root_hash, lockFilePath: path, record });
  return handle;
}

function requireOwnership(handle: RuntimeLifecycleLockHandle): RuntimeLifecycleLockOwnership {
  const ownership = ownershipByHandle.get(handle);
  if (!ownership?.active) throw new Error('Runtime lifecycle lock handle is foreign or already released.');
  return ownership;
}

function assertRecordOwned(ownership: RuntimeLifecycleLockOwnership): void {
  let record: RuntimeLockOwnerRecord;
  try { record = readRecord(ownership.lockFilePath); } catch (error) { throw new Error(`Cannot verify runtime lock ownership before mutation: ${(error as Error).message}`); }
  if (JSON.stringify(record) !== JSON.stringify(ownership.record) || record.canonical_root_hash !== ownership.canonicalRootHash) {
    throw new Error('Runtime lock ownership changed; refusing to mutate the lock path.');
  }
}

function replaceOwnedRecord(ownership: RuntimeLifecycleLockOwnership, next: RuntimeLockOwnerRecord): void {
  assertRecordOwned(ownership);
  const validated = parseRuntimeLockOwnerRecord(next);
  replaceFile(ownership.lockFilePath, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`));
  ownership.record = validated;
}

export function bindRuntimeLifecycleLock(handle: RuntimeLifecycleLockHandle, projectIdentity: string): void {
  const ownership = requireOwnership(handle);
  if (ownership.record.lock_state !== 'bootstrap_unbound') throw new Error('Only a bootstrap-unbound owner may bind project identity.');
  if (!/^[a-f0-9]{64}$/u.test(projectIdentity)) throw new Error('Invalid project identity digest.');
  const project = readProjectIdentity(ownership.canonicalProjectRoot);
  if (project === null || projectIdentityDigest(project) !== projectIdentity) throw new Error('Project identity digest does not match the canonical project identity.');
  replaceOwnedRecord(ownership, { ...ownership.record, lock_state: 'bound', project_identity: projectIdentity, control_endpoint: null });
}

export function publishRuntimeControlEndpoint(handle: RuntimeLifecycleLockHandle, endpoint: RuntimeControlEndpoint): void {
  const ownership = requireOwnership(handle);
  if (ownership.record.lock_state !== 'bound' || ownership.record.control_endpoint !== null) throw new Error('Runtime endpoint publication requires an unpublished bound lock.');
  replaceOwnedRecord(ownership, { ...ownership.record, control_endpoint: endpoint });
}

export function releaseRuntimeLifecycleLock(handle: RuntimeLifecycleLockHandle): void {
  const ownership = requireOwnership(handle);
  assertRecordOwned(ownership);
  unlinkSync(ownership.lockFilePath);
  syncDirectory(dirname(ownership.lockFilePath));
  ownership.active = false;
}

export function runtimeProcessIdentity(handle: RuntimeLifecycleLockHandle): RuntimeProcessIdentity {
  const record = requireOwnership(handle).record;
  return { pid: record.pid, startedAt: record.started_at };
}
