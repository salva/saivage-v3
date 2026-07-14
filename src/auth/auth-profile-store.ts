import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { IndeterminatePublicationError } from '../persistence/errors.js';

export interface AuthProfile {
  type: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProfilesFile { version: number; profiles: Record<string, AuthProfile> }
export interface AuthProfileProjection { profile: AuthProfile; revision: string }

export const AUTH_FILE_REL = '.saivage/auth-profiles.json';
export const AUTH_PROFILE_FILE_MODE = 0o600;

const rawProfileSchema = z.object({
  type: z.string(), provider: z.string(), accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number().optional(),
}).strict();
const rawAuthProfilesSchema = z.object({ version: z.number(), profiles: z.record(z.string(), rawProfileSchema) }).strict();

type ReadStateBase = { path: string };
export type AuthProfileReadState =
  | (ReadStateBase & { state: 'absent' })
  | (ReadStateBase & { state: 'loaded'; file: AuthProfilesFile })
  | (ReadStateBase & { state: 'corrupt_json' | 'invalid_schema' | 'io_error'; causeMessage: string; error: Error });

const SAFE_CORRUPT_JSON_MESSAGE = 'auth profile store contains malformed JSON; inspect the file manually before recovery';
const SAFE_INVALID_SCHEMA_MESSAGE = 'auth profile store does not match the expected profile schema; inspect the file manually before recovery';

export function authProfilePath(projectRoot: string): string { return join(projectRoot, AUTH_FILE_REL); }

export function serializeAuthProfiles(file: AuthProfilesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function authProfileRevision(profile: AuthProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

export class AuthProfileRepository {
  readonly filePath: string;

  constructor(projectRoot: string, private readonly health: ApplicationPersistenceHealth) { this.filePath = authProfilePath(projectRoot); }

  restabilize(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true });
    cleanupDurableReplacementTemporaries(parent, [basename(this.filePath)]);
    if (existsSync(this.filePath)) chmodSync(this.filePath, AUTH_PROFILE_FILE_MODE);
  }

  read(): AuthProfileReadState {
    if (!existsSync(this.filePath)) return { state: 'absent', path: this.filePath };
    let raw: string;
    try { raw = readFileSync(this.filePath, 'utf8'); }
    catch (error) { return { state: 'io_error', path: this.filePath, causeMessage: safeMessage(error), error: toError(error) }; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { return { state: 'corrupt_json', path: this.filePath, causeMessage: SAFE_CORRUPT_JSON_MESSAGE, error: new Error(SAFE_CORRUPT_JSON_MESSAGE, { cause: error }) }; }
    const result = rawAuthProfilesSchema.safeParse(parsed);
    if (!result.success) return { state: 'invalid_schema', path: this.filePath, causeMessage: SAFE_INVALID_SCHEMA_MESSAGE, error: new Error(SAFE_INVALID_SCHEMA_MESSAGE, { cause: result.error }) };
    return { state: 'loaded', path: this.filePath, file: result.data };
  }

  load(): AuthProfilesFile | null {
    const state = this.read();
    if (state.state === 'absent') return null;
    if (state.state === 'loaded') return state.file;
    throw this.errorForReadState(state);
  }

  profile(name: string): AuthProfileProjection | null {
    const profile = this.load()?.profiles[name];
    return profile ? { profile, revision: authProfileRevision(profile) } : null;
  }

  replace(file: AuthProfilesFile): void {
    this.health.assertMutationHealthy();
    const parsed = rawAuthProfilesSchema.parse(file);
    try { durablyReplaceFile(this.filePath, Buffer.from(serializeAuthProfiles(parsed)), { mode: AUTH_PROFILE_FILE_MODE }); }
    catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: this.filePath, operation: 'replace auth profiles', error });
      throw error;
    }
  }

  private errorForReadState(state: Exclude<AuthProfileReadState, { state: 'absent' | 'loaded' }>): Error {
    if (state.state === 'corrupt_json') return new Error(`Failed to parse auth-profiles.json: ${SAFE_CORRUPT_JSON_MESSAGE}`);
    if (state.state === 'invalid_schema') return new Error(SAFE_INVALID_SCHEMA_MESSAGE, { cause: state.error });
    return new Error(`Failed to read auth-profiles.json: ${state.causeMessage}`);
  }
}
