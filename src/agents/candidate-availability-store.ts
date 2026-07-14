import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry } from '../contracts/candidate-availability.js';
import { candidateKey, type Candidate } from '../contracts/provider-candidate.js';
import { cleanupDurableReplacementTemporaries } from '../persistence/durable-file-replacement.js';
import { appendEnvelope, parseGrowingFile, publishFirstEnvelope, serializeGrowingEnvelope } from '../persistence/growing-file.js';
import { providerAvailabilityFile } from '../persistence/layout.js';
import { discardIncompleteJsonlTail } from '../persistence/store-restabilization.js';

const recordSchema = z.object({
  candidate: z.object({ provider: z.string(), account: z.string().nullable(), model: z.string() }).strict(),
  state: z.enum(['HEALTHY', 'BLOCKED_UNTIL', 'COOLING']),
  untilMs: z.number(),
  reason: z.string().optional(),
  updatedAtMs: z.number(),
}).strict();

export class CandidateAvailabilityStore implements CandidateAvailability {
  readonly jsonlPath: string;
  readonly #entries = new Map<string, CandidateAvailabilityEntry>();
  #loaded = false;
  #published = false;

  constructor(projectRoot: string, private readonly health: ApplicationPersistenceHealth) {
    this.jsonlPath = providerAvailabilityFile(projectRoot);
  }

  restabilize(): void {
    const directory = dirname(this.jsonlPath);
    mkdirSync(directory, { recursive: true });
    cleanupDurableReplacementTemporaries(directory, [basename(this.jsonlPath)]);
    if (existsSync(this.jsonlPath)) discardIncompleteJsonlTail(this.jsonlPath);
    this.loadProjection();
    this.#published = existsSync(this.jsonlPath);
    this.#loaded = true;
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
    if (!this.#loaded) throw new Error('Provider availability has not been loaded.');
    const record = recordSchema.parse(entry);
    const bytes = serializeGrowingEnvelope([record], recordSchema);
    if (this.#published) appendEnvelope(this.jsonlPath, bytes, this.health, 'append provider availability');
    else publishFirstEnvelope(this.jsonlPath, bytes, this.health, 'publish first provider availability envelope');
    this.#entries.set(candidateKey(entry.candidate), entry);
    this.#published = true;
  }

  private loadProjection(): void {
    this.#entries.clear();
    if (!existsSync(this.jsonlPath)) {
      return;
    }
    const records = parseGrowingFile(this.jsonlPath, readFileSync(this.jsonlPath, 'utf8'), recordSchema);
    for (const record of records) {
      this.#entries.set(candidateKey(record.candidate), record);
    }
  }
}

export type { AvailabilityDecision };
