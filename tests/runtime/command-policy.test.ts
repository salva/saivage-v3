import { describe, expect, it } from '@jest/globals';
import { redactCommandForPolicy, sanitizedCommandEnv } from '../../src/runtime/command-policy.js';

describe('command policy', () => {
  it('sanitizes inherited env keys while preserving intended safe keys', () => {
    process.env.OPENAI_API_KEY = 'secret';
    process.env.SAIVAGE_API_TOKEN = 'secret';
    process.env.ANTHROPIC_API_KEY = 'secret';
    process.env.GOOGLE_API_KEY = 'secret';
    process.env.AZURE_OPENAI_KEY = 'secret';
    process.env.EXAMPLE_API_TOKEN = 'secret';
    process.env.CUSTOM_TOKEN = 'secret';
    process.env.CUSTOM_KEY = 'secret';
    process.env.CUSTOM_SECRET = 'secret';
    process.env.CUSTOM_PASSWORD = 'secret';
    process.env.PATH = process.env.PATH ?? '/usr/bin';
    process.env.HOME = process.env.HOME ?? '/tmp/home';
    process.env.USER = process.env.USER ?? 'tester';
    process.env.LANG = process.env.LANG ?? 'C.UTF-8';
    process.env.TERM = process.env.TERM ?? 'xterm';
    process.env.LC_ALL = process.env.LC_ALL ?? 'C.UTF-8';
    process.env.NOT_SECRET = 'value';

    const env = sanitizedCommandEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SAIVAGE_API_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.AZURE_OPENAI_KEY).toBeUndefined();
    expect(env.EXAMPLE_API_TOKEN).toBeUndefined();
    expect(env.CUSTOM_TOKEN).toBeUndefined();
    expect(env.CUSTOM_KEY).toBeUndefined();
    expect(env.CUSTOM_SECRET).toBeUndefined();
    expect(env.CUSTOM_PASSWORD).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    expect(env.USER).toBeTruthy();
    expect(env.LANG).toBeTruthy();
    expect(env.TERM).toBeTruthy();
    expect(env.LC_ALL).toBeTruthy();
    expect(env.NOT_SECRET).toBeUndefined();
  });

  it('redacts synthetic secrets from command text', () => {
    const rawSecret = 'synthetic-command-secret';
    const redacted = redactCommandForPolicy(`echo token=${rawSecret}`);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain(rawSecret);
  });
});
