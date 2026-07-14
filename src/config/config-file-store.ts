import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { IndeterminatePublicationError } from '../persistence/errors.js';

export class ConfigFileStore {
  constructor(readonly path: string, private readonly health: ApplicationPersistenceHealth) {}

  restabilize(): void {
    const directory = dirname(this.path);
    if (existsSync(directory)) cleanupDurableReplacementTemporaries(directory, [basename(this.path)]);
  }

  publishIfMissing(bytes: Uint8Array): void {
    this.health.assertMutationHealthy();
    if (existsSync(this.path)) return;
    mkdirSync(dirname(this.path), { recursive: true });
    this.replaceBytes(bytes, 'initialize configuration');
  }

  replace(bytes: Uint8Array): void {
    this.health.assertMutationHealthy();
    this.replaceBytes(bytes, 'replace configuration');
  }

  private replaceBytes(bytes: Uint8Array, operation: string): void {
    try { durablyReplaceFile(this.path, bytes); }
    catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: this.path, operation, error });
      throw error;
    }
  }
}
