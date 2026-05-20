/**
 * AuthProfileStore owns persistence state transitions for .saivage/auth-profiles.json.
 *
 * The store deliberately refuses ordinary save/delete operations when the existing
 * credential store is corrupt, invalid, or unreadable. Refusal diagnostics are
 * metadata-only: never include raw file content or token-bearing fields.
 */

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export interface AuthProfile {
  type: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProfilesFile {
  version: number;
  profiles: Record<string, AuthProfile>;
}

export const AUTH_FILE_REL = '.saivage/auth-profiles.json';
export const AUTH_PROFILE_FILE_MODE = 0o600;

const rawProfileSchema = z.object({
  type: z.string().optional(),
  provider: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  access: z.string().optional(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
});

const rawAuthProfilesSchema = z.object({
  version: z.number().default(1),
  profiles: z.record(z.string(), rawProfileSchema),
});

type ReadStateBase = {
  path: string;
};

export type AuthProfileReadState =
  | (ReadStateBase & { state: 'absent' })
  | (ReadStateBase & { state: 'loaded'; file: AuthProfilesFile })
  | (ReadStateBase & {
      state: 'corrupt_json';
      causeMessage: string;
      error: Error;
    })
  | (ReadStateBase & {
      state: 'invalid_schema';
      causeMessage: string;
      error: Error;
    })
  | (ReadStateBase & { state: 'io_error'; causeMessage: string; error: Error });

export type AuthProfileRefusalState = Exclude<
  AuthProfileReadState['state'],
  'absent' | 'loaded'
>;

export interface AuthProfileRecoveryDetails {
  state: AuthProfileRefusalState;
  path: string;
  action: 'refused';
  causeMessage: string;
}

export interface AtomicWriteOptions {
  simulateFailureAt?: 'open' | 'write' | 'fsync' | 'rename' | 'chmod';
}

export interface AuthProfileStoreOptions {
  atomicWriteOptions?: AtomicWriteOptions;
  tempNameFactory?: () => string;
}

export class AuthProfileRecoveryRequiredError extends Error {
  readonly name = 'AuthProfileRecoveryRequiredError';
  readonly details: AuthProfileRecoveryDetails;

  constructor(details: AuthProfileRecoveryDetails) {
    super(
      `Auth profile store ${details.state} at ${details.path}; ordinary write refused. ` +
        `Action required: repair or move aside the auth profile store before retrying. ` +
        `Cause: ${details.causeMessage}`,
    );
    this.details = details;
  }
}

export class AuthProfilePersistenceError extends Error {
  readonly name = 'AuthProfilePersistenceError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

function normalizeProfile(
  raw: z.infer<typeof rawProfileSchema>,
  name: string,
): AuthProfile {
  const accessToken = raw.accessToken ?? raw.access;
  if (!accessToken) {
    throw new Error(
      `OAuth profile '${name}' is missing required credential.`,
    );
  }

  return {
    type: raw.type ?? 'oauth',
    provider: raw.provider,
    accessToken,
    refreshToken: raw.refreshToken ?? raw.refresh,
    expiresAt: raw.expiresAt ?? raw.expires,
  };
}

function normalizeProfiles(
  raw: z.infer<typeof rawAuthProfilesSchema>,
): AuthProfilesFile {
  const profiles: Record<string, AuthProfile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    profiles[name] = normalizeProfile(rawProfile, name);
  }
  return { version: raw.version, profiles };
}

export function serializeAuthProfiles(file: AuthProfilesFile): string {
  const obj = {
    version: file.version,
    profiles: {} as Record<string, Record<string, unknown>>,
  };
  for (const [name, profile] of Object.entries(file.profiles)) {
    const entry: Record<string, unknown> = {
      type: profile.type,
      provider: profile.provider,
      accessToken: profile.accessToken,
    };
    if (profile.refreshToken !== undefined) {
      entry['refreshToken'] = profile.refreshToken;
    }
    if (profile.expiresAt !== undefined) {
      entry['expiresAt'] = profile.expiresAt;
    }
    obj.profiles[name] = entry;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

export function authProfilePath(projectRoot: string): string {
  return join(projectRoot, AUTH_FILE_REL);
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
}

function tempSuffix(): string {
  return `${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`;
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms/filesystems do not allow directory fsync; best effort only.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAuthProfilesAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions & { tempNameFactory?: () => string } = {},
): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });

  const tempName = `.auth-profiles.json.${options.tempNameFactory?.() ?? tempSuffix()}.tmp`;
  const tempPath = join(parent, tempName);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let shouldCleanup = true;

  try {
    if (options.simulateFailureAt === 'open') throw new Error('simulated open failure');
    handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, AUTH_PROFILE_FILE_MODE);
    if (options.simulateFailureAt === 'write') throw new Error('simulated write failure');
    await handle.writeFile(content, 'utf-8');
    if (options.simulateFailureAt === 'fsync') throw new Error('simulated fsync failure');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tempPath, AUTH_PROFILE_FILE_MODE);
    if (options.simulateFailureAt === 'rename') throw new Error('simulated rename failure');
    await rename(tempPath, filePath);
    shouldCleanup = false;
    if (options.simulateFailureAt === 'chmod') throw new Error('simulated chmod failure');
    await chmod(filePath, AUTH_PROFILE_FILE_MODE);
    await fsyncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (shouldCleanup) {
      await unlink(tempPath).catch(() => undefined);
    }
    throw new AuthProfilePersistenceError(
      `Failed to persist auth profiles atomically at ${filePath}: ${safeMessage(error)}`,
      { cause: error },
    );
  }
}

export class AuthProfileStore {
  readonly filePath: string;
  private readonly options: AuthProfileStoreOptions;

  constructor(projectRoot: string, options: AuthProfileStoreOptions = {}) {
    this.filePath = authProfilePath(projectRoot);
    this.options = options;
  }

  async read(): Promise<AuthProfileReadState> {
    try {
      await stat(this.filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return { state: 'absent', path: this.filePath };
      }
      return {
        state: 'io_error',
        path: this.filePath,
        causeMessage: safeMessage(error),
        error: toError(error),
      };
    }

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
      await chmod(this.filePath, AUTH_PROFILE_FILE_MODE);
    } catch (error) {
      return {
        state: 'io_error',
        path: this.filePath,
        causeMessage: safeMessage(error),
        error: toError(error),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        state: 'corrupt_json',
        path: this.filePath,
        causeMessage: safeMessage(error),
        error: toError(error),
      };
    }

    const result = rawAuthProfilesSchema.safeParse(parsed);
    if (!result.success) {
      const message = validationMessage(result.error);
      return {
        state: 'invalid_schema',
        path: this.filePath,
        causeMessage: message,
        error: new Error(`Auth profiles validation failed:\n${message}`),
      };
    }

    try {
      return {
        state: 'loaded',
        path: this.filePath,
        file: normalizeProfiles(result.data),
      };
    } catch (error) {
      return {
        state: 'invalid_schema',
        path: this.filePath,
        causeMessage: safeMessage(error),
        error: toError(error),
      };
    }
  }

  async load(): Promise<AuthProfilesFile | null> {
    const state = await this.read();
    if (state.state === 'absent') return null;
    if (state.state === 'loaded') return state.file;
    throw this.errorForReadState(state);
  }

  async saveProfile(name: string, profile: AuthProfile): Promise<void> {
    const state = await this.read();
    const file = this.fileForWrite(state);
    file.profiles[name] = profile;
    await this.write(file);
  }

  async deleteProfile(name: string): Promise<void> {
    const state = await this.read();
    if (state.state === 'absent') return;
    const file = this.fileForWrite(state);
    if (!(name in file.profiles)) return;
    delete file.profiles[name];
    await this.write(file);
  }

  private async write(file: AuthProfilesFile): Promise<void> {
    await writeAuthProfilesAtomic(this.filePath, serializeAuthProfiles(file), {
      ...this.options.atomicWriteOptions,
      tempNameFactory: this.options.tempNameFactory,
    });
  }

  private fileForWrite(state: AuthProfileReadState): AuthProfilesFile {
    if (state.state === 'absent') return { version: 1, profiles: {} };
    if (state.state === 'loaded') return state.file;
    throw new AuthProfileRecoveryRequiredError({
      state: state.state,
      path: state.path,
      action: 'refused',
      causeMessage: state.causeMessage,
    });
  }

  private errorForReadState(state: Exclude<AuthProfileReadState, { state: 'absent' | 'loaded' }>): Error {
    if (state.state === 'corrupt_json') {
      return new Error(`Failed to parse auth-profiles.json: ${state.causeMessage}`);
    }
    if (state.state === 'invalid_schema') {
      return state.error;
    }
    return new Error(`Failed to read auth-profiles.json: ${state.causeMessage}`);
  }
}
