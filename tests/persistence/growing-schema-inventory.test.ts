import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('durable growing-schema and writer inventory', () => {
  it('keeps exactly four strict row families on the shared envelope mechanics', () => {
    const appLog = source('src/persistence/app-log.ts');
    const availability = source('src/agents/candidate-availability-store.ts');
    const messages = source('src/schemas/validators.ts');
    const summaries = source('src/runtime/actors/compaction/summary-cache.ts');
    const conversations = source('src/persistence/conversation-store.ts');

    expect(appLog).toContain("z.discriminatedUnion('type'");
    for (const type of ['event', 'error', 'control_action', 'provider_exchange', 'content_review']) expect(appLog).toContain(`z.literal('${type}')`);
    expect(appLog).not.toContain('card_deleted');
    expect(availability).toMatch(/const recordSchema = z\.object\([\s\S]*?\)\.strict\(\)/);
    expect(messages).toMatch(/entityLinkSchema = z\.object\([\s\S]*?\)\.strict\(\)/);
    expect(messages).toMatch(/agentMessageSchema = z\.object\([\s\S]*?\)\.strict\(\)\.superRefine/);
    expect(summaries).toContain('provenance: z.object');
    expect(summaries).not.toContain('.passthrough()');
    expect(summaries).not.toContain('z.any()');

    for (const owner of [appLog, availability, conversations]) {
      expect(owner).toContain('serializeGrowingEnvelope');
      expect(owner).toContain('publishFirstEnvelope');
      expect(owner).toContain('appendEnvelope');
      expect(owner).not.toContain('appendFileSync');
    }
  });

  it('keeps app-log consumers on typed payloads without parse/drop or payload casts', () => {
    for (const path of [
      'src/observability/event-logger.ts',
      'src/observability/error-logger.ts',
      'src/persistence/control-action-audit.ts',
      'src/persistence/provider-exchange-log.ts',
      'src/workspace/quarantine.ts',
    ]) {
      const text = source(path);
      expect(text).not.toMatch(/safeParse\(entry\.data\)|entry\.data\s+as\s+/);
    }
  });
});
