import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import type { CompositionMutationAuthority, MutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';
import type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry } from '../contracts/candidate-availability.js';
import { candidateKey, type Candidate } from '../contracts/provider-candidate.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { IndeterminatePublicationError } from '../persistence/errors.js';
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
  #bytesWritten = 0;
  #failed = false;

  constructor(projectRoot: string, private readonly lane: MutationLane, private readonly compactBytes = 262144) {
    this.jsonlPath = providerAvailabilityFile(projectRoot);
  }

  restabilize(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'candidate availability restabilization', () => {
      const directory = dirname(this.jsonlPath);
      mkdirSync(directory, { recursive: true });
      cleanupDurableReplacementTemporaries(directory, [basename(this.jsonlPath)]);
      if (existsSync(this.jsonlPath)) discardIncompleteJsonlTail(this.jsonlPath);
      this.replay();
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  isAvailable(candidate: Candidate): boolean {
    const entry = this.#entries.get(candidateKey(candidate));
    return entry === undefined || entry.state === 'HEALTHY' || Date.now() >= entry.untilMs;
  }

  markSucceeded(authority: MutationAuthority, candidate: Candidate): void {
    this.apply(authority, () => ({ candidate, state: 'HEALTHY', untilMs: 0, updatedAtMs: Date.now() }));
  }

  markFailed(authority: MutationAuthority, candidate: Candidate, decision: AvailabilityDecision): void {
    this.apply(authority, () => {
      const previous = this.#entries.get(candidateKey(candidate));
      const untilMs = previous && previous.state !== 'HEALTHY' && previous.untilMs > decision.untilMs
        ? previous.untilMs
        : decision.untilMs;
      return { candidate, state: decision.state, untilMs, reason: decision.reason, updatedAtMs: Date.now() };
    });
  }

  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined {
    return this.#entries.get(candidateKey(candidate));
  }

  getAllEntries(): CandidateAvailabilityEntry[] {
    return [...this.#entries.values()];
  }

  private apply(authority: MutationAuthority, createEntry: () => CandidateAvailabilityEntry): void {
    if (this.#failed) throw new Error('Candidate availability store has failed and requires restart.');
    const result = this.lane.apply(authority, 'candidate availability append', () => {
      const entry = createEntry();
      const record = recordSchema.parse(entry);
      const line = `${JSON.stringify(record)}\n`;
      try {
        this.append(line);
        this.#entries.set(candidateKey(entry.candidate), entry);
        this.#bytesWritten += Buffer.byteLength(line);
        if (this.#bytesWritten > this.compactBytes) this.compact();
      } catch (error) {
        this.#failed = true;
        throw error;
      }
    });
    if (!result.applied) throw new Error('Candidate availability mutation authority is stale.');
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

  private compact(): void {
    const payload = this.getAllEntries().map((entry) => JSON.stringify(recordSchema.parse(entry))).join('\n');
    try {
      durablyReplaceFile(this.jsonlPath, Buffer.from(payload.length === 0 ? '' : `${payload}\n`));
      this.#bytesWritten = statSync(this.jsonlPath).size;
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.#failed = true;
      throw error;
    }
  }

  private replay(): void {
    this.#entries.clear();
    if (!existsSync(this.jsonlPath)) {
      this.#bytesWritten = 0;
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
    this.#bytesWritten = Buffer.byteLength(raw);
  }
}

export { MemoryCandidateAvailability as MemoryCandidateAvailabilityStore } from './candidate-availability.js';
export type { AvailabilityDecision };
