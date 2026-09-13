import { describe, expect, it } from '@jest/globals';
import { redactCommandForPolicy, sanitizedCommandEnv } from '../../src/runtime/command-policy.js';

describe('command policy', () => {
  it('sanitizes inherited env keys while preserving intended safe keys', () => {
    const originalEnv = { ...process.env };
    try {
      process.env.OPENAI_API_KEY = 'synthetic-provider-secret';
      process.env.SAIVAGE_API_TOKEN = 'synthetic-api-token';
      process.env.ANTHROPIC_API_KEY = 'synthetic-provider-secret';
      process.env.GOOGLE_API_KEY = 'synthetic-provider-secret';
      process.env.AZURE_OPENAI_KEY = 'synthetic-provider-secret';
      process.env.EXAMPLE_API_TOKEN = 'synthetic-api-token';
      process.env.CUSTOM_TOKEN = 'synthetic-token';
      process.env.CUSTOM_KEY = 'synthetic-key';
      process.env.CUSTOM_SECRET = 'synthetic-secret';
      process.env.CUSTOM_PASSWORD = 'synthetic-password';
      process.env.GIT_CONFIG = '/synthetic/git-config';
      process.env.GIT_CONFIG_GLOBAL = '/synthetic/global-git-config';
      process.env.GIT_SSH = '/synthetic/git-ssh';
      process.env.GIT_SSH_COMMAND = 'synthetic-ssh-command';
      process.env.PATH = '/synthetic/bin';
      process.env.HOME = '/synthetic/home';
      process.env.USER = 'synthetic-user';
      process.env.LANG = 'C.UTF-8';
      process.env.TERM = 'synthetic-terminal';
      process.env.LC_ALL = 'C.UTF-8';
      process.env.UNKNOWN_COMMAND_ENV = 'synthetic-unknown-value';
      process.env.GIT_AUTHOR_NAME = 'Synthetic Author';
      process.env.GIT_AUTHOR_EMAIL = 'author@example.invalid';
      process.env.GIT_COMMITTER_NAME = 'Synthetic Committer';
      process.env.GIT_COMMITTER_EMAIL = 'committer@example.invalid';

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
      expect(env.GIT_CONFIG).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.GIT_SSH).toBeUndefined();
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.PATH).toBe('/synthetic/bin');
      expect(env.HOME).toBe('/synthetic/home');
      expect(env.USER).toBe('synthetic-user');
      expect(env.LANG).toBe('C.UTF-8');
      expect(env.TERM).toBe('synthetic-terminal');
      expect(env.LC_ALL).toBe('C.UTF-8');
      expect(env.UNKNOWN_COMMAND_ENV).toBeUndefined();
      expect(env.GIT_AUTHOR_NAME).toBe('Synthetic Author');
      expect(env.GIT_AUTHOR_EMAIL).toBe('author@example.invalid');
      expect(env.GIT_COMMITTER_NAME).toBe('Synthetic Committer');
      expect(env.GIT_COMMITTER_EMAIL).toBe('committer@example.invalid');

      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_NAME;
      delete process.env.GIT_COMMITTER_EMAIL;
      const absentIdentityEnv = sanitizedCommandEnv();
      expect(absentIdentityEnv).not.toHaveProperty('GIT_AUTHOR_NAME');
      expect(absentIdentityEnv).not.toHaveProperty('GIT_AUTHOR_EMAIL');
      expect(absentIdentityEnv).not.toHaveProperty('GIT_COMMITTER_NAME');
      expect(absentIdentityEnv).not.toHaveProperty('GIT_COMMITTER_EMAIL');

      process.env.GIT_AUTHOR_NAME = '';
      process.env.GIT_AUTHOR_EMAIL = '';
      process.env.GIT_COMMITTER_NAME = '';
      process.env.GIT_COMMITTER_EMAIL = '';
      const emptyIdentityEnv = sanitizedCommandEnv();
      expect(emptyIdentityEnv.GIT_AUTHOR_NAME).toBe('');
      expect(emptyIdentityEnv.GIT_AUTHOR_EMAIL).toBe('');
      expect(emptyIdentityEnv.GIT_COMMITTER_NAME).toBe('');
      expect(emptyIdentityEnv.GIT_COMMITTER_EMAIL).toBe('');
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });

  it('redacts synthetic secrets from command text', () => {
    const rawSecret = 'synthetic-command-secret';
    const redacted = redactCommandForPolicy(`echo token=${rawSecret}`);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain(rawSecret);
  });
});
