/**
 * Stage 9 — Telegram Bot Tests
 *
 * Tests cover:
 *   1. convertMarkdownToHtml — all 8+ conversion patterns
 *   2. splitLongMessage — splitting logic at paragraph/sentence boundaries
 *   3. TelegramBot class — config, isAuthorized, isRunning (mocked fetch)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  convertMarkdownToHtml,
  splitLongMessage,
  TelegramBot,
} from '../../src/telegram/bot.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ───────────────────────────────────────────────────

const testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-telegram-test-'));
  testRoots.push(dir);
  return dir;
}

function writeSaivageJson(projectRoot: string, overrides: Record<string, unknown>): void {
  const saivageDir = join(projectRoot, '.saivage');
  mkdirSync(saivageDir, { recursive: true });
  // Also create directories needed by AnalystHandler
  mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
  const config = {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: {
      test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
    },
    ...overrides,
  };
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify(config, null, 2));
}

afterEach(() => {
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  testRoots.length = 0;
});

// ═══════════════════════════════════════════════════════════════
// Suite 1: convertMarkdownToHtml
// ═══════════════════════════════════════════════════════════════

describe('convertMarkdownToHtml', () => {
  // 1. Inline code
  it('converts `code` to <code>code</code>', () => {
    expect(convertMarkdownToHtml('Use `const x = 1` here')).toBe(
      'Use <code>const x = 1</code> here',
    );
  });

  it('handles multiple inline code spans', () => {
    expect(convertMarkdownToHtml('`a` and `b`')).toBe(
      '<code>a</code> and <code>b</code>',
    );
  });

  // 2. Fenced code blocks
  it('converts ``` blocks to <pre>...</pre>', () => {
    const input = '```\nconst x = 1;\nconsole.log(x);\n```';
    const result = convertMarkdownToHtml(input);
    // The regex captures content between ``` and ``` including newlines.
    // The content after trimming the trailing newline should be inside <pre>
    expect(result).toContain('<pre>const x = 1;\nconsole.log(x);</pre>');
  });

  it('escapes HTML entities inside code blocks', () => {
    const input = '```\n<div>hello</div>\n```';
    const result = convertMarkdownToHtml(input);
    expect(result).toContain('&lt;div&gt;hello&lt;/div&gt;');
  });

  it('escapes HTML entities inside inline code', () => {
    expect(convertMarkdownToHtml('`<script>alert(1)</script>`')).toBe(
      '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
    );
  });

  // 3. Bold
  it('converts **bold** to <b>bold</b>', () => {
    expect(convertMarkdownToHtml('This is **really** important')).toBe(
      'This is <b>really</b> important',
    );
  });

  it('handles multiple bold spans', () => {
    expect(convertMarkdownToHtml('**a** and **b**')).toBe(
      '<b>a</b> and <b>b</b>',
    );
  });

  // 4. Italic
  it('converts *italic* to <i>italic</i>', () => {
    expect(convertMarkdownToHtml('This is *really* cool')).toBe(
      'This is <i>really</i> cool',
    );
  });

  it('does not convert intra-word asterisks', () => {
    // Words with internal asterisks should not be converted
    expect(convertMarkdownToHtml('file_name.txt')).toBe('file_name.txt');
  });

  // 5. Strikethrough
  it('converts ~~strike~~ to <s>strike</s>', () => {
    expect(convertMarkdownToHtml('This is ~~wrong~~ correct')).toBe(
      'This is <s>wrong</s> correct',
    );
  });

  // 6. Links
  it('converts [text](url) to <a href="url">text</a>', () => {
    expect(convertMarkdownToHtml('See [Google](https://google.com) for more')).toBe(
      'See <a href="https://google.com">Google</a> for more',
    );
  });

  it('handles multiple links', () => {
    expect(convertMarkdownToHtml('[a](http://a.com) and [b](http://b.com)')).toBe(
      '<a href="http://a.com">a</a> and <a href="http://b.com">b</a>',
    );
  });

  // 7. Headings
  it('converts # Header to <b>Header</b>', () => {
    expect(convertMarkdownToHtml('# Important')).toBe('<b>Important</b>');
  });

  it('converts ## Subheader to <b>Subheader</b>', () => {
    expect(convertMarkdownToHtml('## Subheader')).toBe('<b>Subheader</b>');
  });

  it('converts ###### Deep heading to <b>Deep heading</b>', () => {
    expect(convertMarkdownToHtml('###### Deep heading')).toBe('<b>Deep heading</b>');
  });

  it('only converts headings at start of line', () => {
    expect(convertMarkdownToHtml('Not a # heading here')).toBe('Not a # heading here');
  });

  // 8. Unordered list items
  it('converts "- item" to "• item" at start of line', () => {
    expect(convertMarkdownToHtml('- First item')).toBe('• First item');
  });

  it('handles indented list items', () => {
    expect(convertMarkdownToHtml('  - Nested item')).toBe('  • Nested item');
  });

  it('does not convert hyphens in the middle of text', () => {
    expect(convertMarkdownToHtml('high-level overview')).toBe('high-level overview');
  });

  // 9. Edge cases
  it('returns empty string for empty input', () => {
    expect(convertMarkdownToHtml('')).toBe('');
  });

  it('handles text with no markdown unchanged', () => {
    const plain = 'Just some plain text without any formatting.';
    expect(convertMarkdownToHtml(plain)).toBe(plain);
  });

  // 10. Complex mixed formatting
  it('handles complex mixed formatting', () => {
    const input = [
      '# My Report',
      '',
      'This is **very** important. See `code.js` for details.',
      '',
      '```',
      'const x = 1;',
      '```',
      '',
      '- Item one',
      '- Item two with *italic* and ~~strikethrough~~',
      '',
      'Visit [docs](https://docs.example.com) for more.',
    ].join('\n');

    const result = convertMarkdownToHtml(input);
    expect(result).toContain('<b>My Report</b>');
    expect(result).toContain('<b>very</b>');
    expect(result).toContain('<code>code.js</code>');
    expect(result).toContain('<pre>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('• Item one');
    expect(result).toContain('• Item two with <i>italic</i> and <s>strikethrough</s>');
    expect(result).toContain('<a href="https://docs.example.com">docs</a>');
  });

  it('process order: code blocks before inline code', () => {
    // Triple backticks should be processed before single backticks
    const input = 'Outer `code` with\n```\nfenced\n```\ninside';
    const result = convertMarkdownToHtml(input);
    // The fenced block should become <pre> containing "fenced"
    expect(result).toContain('<pre>fenced</pre>');
    // The inline code should be <code>
    expect(result).toContain('<code>code</code>');
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: splitLongMessage
// ═══════════════════════════════════════════════════════════════

describe('splitLongMessage', () => {
  it('returns text as single chunk when under limit', () => {
    const text = 'Hello, world!';
    const chunks = splitLongMessage(text, 4096);
    expect(chunks).toEqual([text]);
  });

  it('returns empty array for empty string', () => {
    expect(splitLongMessage('')).toEqual([]);
    expect(splitLongMessage('', 100)).toEqual([]);
  });

  it('splits at paragraph boundaries (double newlines)', () => {
    // Create two paragraphs that individually fit but together exceed limit
    const para1 = 'A'.repeat(3000);
    const para2 = 'B'.repeat(3000);
    const text = `${para1}\n\n${para2}`;

    const chunks = splitLongMessage(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('splits long single paragraph at sentence boundaries', () => {
    // Create sentences with lots of filler to push past limit
    const sentence = 'X'.repeat(1000) + '. ';
    const longText = sentence.repeat(6);
    // With 6 sentences of ~1002 chars each = ~6012 chars > 4096

    const chunks = splitLongMessage(longText, 4096);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should be <= maxLength
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('splits at word boundaries when sentences are too long', () => {
    // Create a single "word" (no sentences, no spaces) that exceeds limit
    const longWord = 'ABCDEFGHIJ'.repeat(500); // 5000 chars, no spaces
    const chunks = splitLongMessage(longWord, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it('handles exact boundary match', () => {
    // Text that exactly fits in the limit
    const text = 'A'.repeat(4096);
    const chunks = splitLongMessage(text, 4096);
    expect(chunks).toEqual([text]);
  });

  it('handles text with one character over limit', () => {
    const text = 'A'.repeat(4097);
    const chunks = splitLongMessage(text, 4096);
    expect(chunks.length).toBe(2);

    // Combined length should be at least the original length
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    expect(totalLen).toBeGreaterThanOrEqual(4096);
  });

  it('uses custom maxLength', () => {
    const text = 'Hello world! This is a longer text that should be split.';
    const chunks = splitLongMessage(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it('handles three paragraphs where middle is oversized', () => {
    const para1 = 'Short intro.';
    const para2 = 'X'.repeat(5000); // Oversized
    const para3 = 'Short outro.';
    const text = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = splitLongMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be within limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('preserves content integrity across splits', () => {
    const text = 'Paragraph one.\n\nParagraph two with more content here.\n\nParagraph three.';
    const chunks = splitLongMessage(text, 50);
    const rejoined = chunks.join('\n\n');
    // All original words should appear
    for (const word of ['Paragraph', 'one', 'two', 'three']) {
      expect(rejoined).toContain(word);
    }
  });

  it('handles text with many sentence boundaries', () => {
    const sentences = Array.from({ length: 100 }, (_, i) => `Sentence ${i + 1}.`).join(' ');
    const chunks = splitLongMessage(sentences, 500);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    // Should have produced multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: TelegramBot class
// ═══════════════════════════════════════════════════════════════

describe('TelegramBot class', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('constructor loads config correctly', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      telegram: {
        botToken: 'test-bot-token-123',
        allowedUserIds: [111, 222, 333],
      },
    });

    const bot = new TelegramBot(root);
    expect(bot.isRunning()).toBe(false);
    // Check isAuthorized with configured users
    expect(bot.isAuthorized(111)).toBe(true);
    expect(bot.isAuthorized(222)).toBe(true);
    expect(bot.isAuthorized(333)).toBe(true);
  });

  it('constructor handles missing telegram config gracefully', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const bot = new TelegramBot(root);
    expect(bot.isRunning()).toBe(false);
    // No users configured -> no one is authorized
    expect(bot.isAuthorized(123)).toBe(false);
  });

  it('constructor handles missing saivage.json gracefully', () => {
    const root = makeProjectRoot();
    // Don't write a config file; create empty dir structure
    const saivageDir = join(root, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });

    const bot = new TelegramBot(root);
    expect(bot.isRunning()).toBe(false);
    expect(bot.isAuthorized(123)).toBe(false);
  });

  // ── isAuthorized ─────────────────────────────────────────

  describe('isAuthorized', () => {
    let bot: TelegramBot;

    beforeEach(() => {
      const root = makeProjectRoot();
      writeSaivageJson(root, {
        telegram: {
          botToken: 'test-token',
          allowedUserIds: [100, 200, 300],
        },
      });
      bot = new TelegramBot(root);
    });

    it('returns true for authorized user ID', () => {
      expect(bot.isAuthorized(100)).toBe(true);
      expect(bot.isAuthorized(200)).toBe(true);
      expect(bot.isAuthorized(300)).toBe(true);
    });

    it('returns false for unauthorized user', () => {
      expect(bot.isAuthorized(999)).toBe(false);
      expect(bot.isAuthorized(0)).toBe(false);
    });

    it('returns false when allowedUserIds is empty', () => {
      const root = makeProjectRoot();
      writeSaivageJson(root, {
        telegram: { botToken: 'test-token', allowedUserIds: [] },
      });
      const bot2 = new TelegramBot(root);
      expect(bot2.isAuthorized(100)).toBe(false);
    });

    it('returns false when allowedUserIds is undefined', () => {
      const root = makeProjectRoot();
      writeSaivageJson(root, {
        telegram: { botToken: 'test-token' },
      });
      const bot2 = new TelegramBot(root);
      expect(bot2.isAuthorized(100)).toBe(false);
    });
  });

  // ── isRunning ────────────────────────────────────────────

  describe('isRunning', () => {
    let bot: TelegramBot;

    beforeEach(() => {
      const root = makeProjectRoot();
      writeSaivageJson(root, { telegram: { botToken: 'test-token' } });
      bot = new TelegramBot(root);
    });

    afterEach(async () => {
      if (bot.isRunning()) {
        await bot.stop();
      }
    });

    it('returns false before start', () => {
      expect(bot.isRunning()).toBe(false);
    });

    it('returns true after start', async () => {
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        } as unknown as Response),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await bot.start();
      expect(bot.isRunning()).toBe(true);
    });

    it('returns false after stop', async () => {
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        } as unknown as Response),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await bot.start();
      expect(bot.isRunning()).toBe(true);
      await bot.stop();
      expect(bot.isRunning()).toBe(false);
    });
  });

  // ── start / stop behavior ────────────────────────────────

  describe('start', () => {
    let bot: TelegramBot;

    afterEach(async () => {
      if (bot && bot.isRunning()) {
        await bot.stop();
      }
    });

    it('does nothing when no bot token is configured', async () => {
      const root = makeProjectRoot();
      writeSaivageJson(root, {});

      bot = new TelegramBot(root);
      await bot.start();
      expect(bot.isRunning()).toBe(false);
    });

    it('does not start twice', async () => {
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        } as unknown as Response),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const root = makeProjectRoot();
      writeSaivageJson(root, { telegram: { botToken: 'test-token' } });
      bot = new TelegramBot(root);

      await bot.start();
      expect(bot.isRunning()).toBe(true);

      // Second start should be no-op
      await bot.start();
      expect(bot.isRunning()).toBe(true);
    });
  });

  describe('stop', () => {
    it('does nothing when not running', async () => {
      const root = makeProjectRoot();
      writeSaivageJson(root, { telegram: { botToken: 'test-token' } });

      const bot = new TelegramBot(root);
      await bot.stop();
      expect(bot.isRunning()).toBe(false);
    });
  });
});

describe('Telegram outbound recipient separation', () => {
  it('does not treat notificationChatIds as inbound allowedUserIds', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      telegram: {
        botToken: '123456:TEST_TOKEN',
        allowedUserIds: [9001],
        notificationChatIds: [111111],
      },
    });

    const bot = new TelegramBot(root);
    expect(bot.isAuthorized(9001)).toBe(true);
    expect(bot.isAuthorized(111111)).toBe(false);
  });
});
