import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('durable growing-schema and writer inventory', () => {
  it('keeps retained strict row families on the shared envelope mechanics', () => {
    const appLogContract = source('src/contracts/app-log.ts');
    const appLog = source('src/persistence/app-log.ts');
    const messages = source('src/schemas/validators.ts');
    const conversations = source('src/persistence/conversation-file.ts');

    expect(appLogContract).toContain("z.discriminatedUnion('type'");
    for (const type of ['event', 'control_action', 'provider_exchange']) expect(appLogContract).toContain(`z.literal('${type}')`);
    expect(Array.from(appLogContract.matchAll(/type: z\.literal\('([^']+)'\)/g), (match) => match[1])).toEqual(['event', 'control_action', 'provider_exchange']);
    expect(appLogContract).not.toContain('card_deleted');
    expect(appLogContract).not.toMatch(/from ['"]node:|from ['"]\.\.\/persistence\//);
    expect(messages).toMatch(/entityLinkSchema = z\.object\([\s\S]*?\)\.strict\(\)/);
    expect(messages).toMatch(/agentMessageSchema = z\.object\([\s\S]*?\)\.strict\(\)\.superRefine/);

    expect(appLog).toContain('prepareGrowingEnvelope');
    expect(conversations).toContain('serializeGrowingEnvelope');
    for (const owner of [appLog, conversations]) {
      expect(owner).toContain('publishFirstEnvelope');
      expect(owner).toContain('appendEnvelope');
      expect(owner).not.toContain('appendFileSync');
    }
  });

  it('keeps app-log consumers on typed payloads without parse/drop or payload casts', () => {
    for (const path of [
      'src/observability/event-logger.ts',
      'src/persistence/control-action-audit.ts',
      'src/persistence/provider-exchange-log.ts',
    ]) {
      const text = source(path);
      expect(text).not.toMatch(/safeParse\(entry\.data\)|entry\.data\s+as\s+/);
    }
  });
});
