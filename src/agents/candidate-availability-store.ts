import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry } from '../contracts/candidate-availability.js';
import { candidateKey, type Candidate } from '../contracts/provider-candidate.js';
import { cleanupDurableReplacementTemporaries } from '../persistence/durable-file-replacement.js';
import { providerAvailabilityFile } from '../persistence/layout.js';
import { discardIncompleteJsonlTail } from '../persistence/store-restabilization.js';

const recordSchema = z.object({
  candidate: z.object({ provider: z.string(), account: z.string().nullable(), model: z.string() }).strict(),
  state: z.enum(['HEALTHY', 'BLOCKED_UNTIL', 'COOLING']),
  untilMs: z.number(),
  reason: z.string().optional(),
  updatedAtMs: z.number(),
}).strict();

type AvailabilityRecord = z.infer<typeof recordSchema>;

export class CandidateAvailabilityStore implements CandidateAvailability {
  readonly jsonlPath: string;
  readonly #entries = new Map<string, CandidateAvailabilityEntry>();

  constructor(projectRoot: string, private readonly health: ApplicationPersistenceHealth) {
    this.jsonlPath = providerAvailabilityFile(projectRoot);
  }

  restabilize(): void {
    const directory = dirname(this.jsonlPath);
    mkdirSync(directory, { recursive: true });
    cleanupDurableReplacementTemporaries(directory, [basename(this.jsonlPath)]);
    if (existsSync(this.jsonlPath)) discardIncompleteJsonlTail(this.jsonlPath);
    this.replay();
  }

  isAvailable(candidate: Candidate): boolean {
    const entry = this.#entries.get(candidateKey(candidate));
    return entry === undefined || entry.state === 'HEALTHY' || Date.now() >= entry.untilMs;
  }

  markSucceeded(candidate: Candidate): void {
    this.appendRecord({ candidate, state: 'HEALTHY', untilMs: 0, updatedAtMs: Date.now() });
  }

  markFailed(candidate: Candidate, decision: AvailabilityDecision): void {
    const previous = this.#entries.get(candidateKey(candidate));
    const untilMs = previous && previous.state !== 'HEALTHY' && previous.untilMs > decision.untilMs
      ? previous.untilMs
      : decision.untilMs;
    this.appendRecord({ candidate, state: decision.state, untilMs, reason: decision.reason, updatedAtMs: Date.now() });
  }

  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined {
    return this.#entries.get(candidateKey(candidate));
  }

  getAllEntries(): CandidateAvailabilityEntry[] {
    return [...this.#entries.values()];
  }

  private appendRecord(entry: CandidateAvailabilityEntry): void {
    this.health.assertMutationHealthy();
    const record = recordSchema.parse(entry);
    try { this.append(`${JSON.stringify(record)}\n`); }
    catch (error) { this.health.reportUncertainFailure({ target: this.jsonlPath, operation: 'append provider availability', error }); }
    this.#entries.set(candidateKey(entry.candidate), entry);
  }

  private append(line: string): void {
    mkdirSync(dirname(this.jsonlPath), { recursive: true });
    const fd = openSync(this.jsonlPath, 'a');
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written === 0) throw new Error(`Candidate availability append made no progress at ${this.jsonlPath}.`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private replay(): void {
    this.#entries.clear();
    if (!existsSync(this.jsonlPath)) {
      return;
    }
    const raw = readFileSync(this.jsonlPath, 'utf8');
    if (raw.length > 0 && !raw.endsWith('\n')) throw new Error(`Candidate availability JSONL has an incomplete tail at ${this.jsonlPath}.`);
    for (const [index, line] of raw.split('\n').slice(0, -1).entries()) {
      if (line.length === 0) throw new Error(`Candidate availability JSONL row ${index + 1} is empty at ${this.jsonlPath}.`);
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch (error) { throw new Error(`Candidate availability JSONL row ${index + 1} is malformed at ${this.jsonlPath}.`, { cause: error }); }
      const record: AvailabilityRecord = recordSchema.parse(parsed);
      this.#entries.set(candidateKey(record.candidate), record);
    }
  }
}

export { MemoryCandidateAvailability as MemoryCandidateAvailabilityStore } from './candidate-availability.js';
export type { AvailabilityDecision };
