import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramBot } from '../../src/telegram/bot.js';
import { evaluateAuthz } from '../../src/agents/authz.js';

function setup(root: string) {
  const sd = join(root, '.saivage');
  mkdirSync(join(sd, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(sd, 'agents', 'messages'), { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ telegram: { botToken: 'x', allowedUserIds: [1] }, server: { port: 8080, host: '127.0.0.1' }, models: { default: ['test-model'] }, providers: { test: { priority: 1, models: ['test-model'], apiKey: 'secret' } } }, null, 2));
}

describe('telegram surface authz', () => {
  it('constructs telegram bot and preserves telegram surface policy distinctions', () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-telegram-'));
    try {
      setup(root);
      const bot = new TelegramBot(root);
      expect(bot.isAuthorized(1)).toBe(true);
      expect(evaluateAuthz({ actor: 'analyst', surface: 'telegram', safety_class: 'destructive' })).toBe('deny');
      expect(evaluateAuthz({ actor: 'analyst', surface: 'web-chat', safety_class: 'destructive' })).toBe('preview_only');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
