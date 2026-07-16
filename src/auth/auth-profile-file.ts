import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { replaceFile, type PublicationTemporaryIdFactory } from '../persistence/replace-file.js';

export interface AuthProfile {
  type: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProfilesFile { version: number; profiles: Record<string, AuthProfile> }

export const AUTH_FILE_REL = '.saivage/auth-profiles.json';

const rawProfileSchema = z.object({
  type: z.string().min(1), provider: z.string().min(1), accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(), expiresAt: z.number().finite().optional(),
}).strict();
const rawAuthProfilesSchema = z.object({ version: z.number().int().positive(), profiles: z.record(z.string().min(1), rawProfileSchema) }).strict();

const SAFE_CORRUPT_JSON_MESSAGE = 'auth profiles contain malformed JSON; inspect the file manually.';
const SAFE_INVALID_SCHEMA_MESSAGE = 'auth profiles do not match the expected schema; inspect the file manually.';

export function authProfilePath(projectRoot: string): string { return join(projectRoot, AUTH_FILE_REL); }

export function serializeAuthProfiles(file: AuthProfilesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function readAuthProfiles(projectRoot: string): AuthProfilesFile | null {
    const filePath = authProfilePath(projectRoot);
    let raw: string;
    try { raw = readFileSync(filePath, 'utf8'); }
    catch (error) {
      const ioError = error as NodeJS.ErrnoException;
      if (ioError.code === 'ENOENT' && ioError.path === filePath) return null;
      throw new Error('Failed to read auth-profiles.json.', { cause: error });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(SAFE_CORRUPT_JSON_MESSAGE, { cause: error }); }
    const result = rawAuthProfilesSchema.safeParse(parsed);
    if (!result.success) throw new Error(SAFE_INVALID_SCHEMA_MESSAGE, { cause: result.error });
    return result.data;
}

export function readAuthProfile(projectRoot: string, name: string): AuthProfile | null {
  return readAuthProfiles(projectRoot)?.profiles[name] ?? null;
}

export function replaceAuthProfiles(projectRoot: string, file: AuthProfilesFile, publicationTemporaryId?: PublicationTemporaryIdFactory): void {
    const parsed = rawAuthProfilesSchema.parse(file);
    replaceFile(authProfilePath(projectRoot), Buffer.from(serializeAuthProfiles(parsed)), publicationTemporaryId);
}
