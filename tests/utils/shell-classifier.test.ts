import { describe, expect, it } from '@jest/globals';
import { classifyShellCommand, sanitizedEnv } from '../../src/utils/shell-classifier.js';

describe('shell classifier', () => {
  const cases: Array<[string, string, 'read_only' | 'low' | 'destructive']> = [
    ['ls -la /work/target-project', '/work', 'read_only'],
    ['sudo systemctl restart x', '/work', 'destructive'],
    ['curl -fsS http://10.0.3.170:8080/health', '/work', 'read_only'],
    ['echo hi > /etc/foo', '/work', 'destructive'],
    ['rm -rf .saivage-work/tmp', '/work', 'destructive'],
    ['grep -r foo src/', '/work', 'read_only'],
    ['ls | grep foo', '/work', 'read_only'],
    ['ls && rm -rf x', '/work', 'destructive'],
    ['FOO=bar BAZ=qux ls -la', '/work', 'read_only'],
    ['find . -name package.json', '/work', 'read_only'],
    ['find . -delete', '/work', 'destructive'],
    ['cat .saivage/auth-profiles.json', '/work/saivage-v3', 'destructive'],
    ['node --version', '/work', 'read_only'],
  ];

  it.each(cases)('classifies %s as %s', (command, cwd, expected) => {
    expect(classifyShellCommand(command, cwd)).toBe(expected);
  });

  it('detects home ssh redirect targets as destructive', () => {
    expect(classifyShellCommand('echo hi >> /home/test/.ssh/config', '/work')).toBe('destructive');
  });

  it('sanitizes inherited env keys', () => {
    process.env.OPENAI_API_KEY = 'secret';
    process.env.SAIVAGE_API_TOKEN = 'secret';
    process.env.ANTHROPIC_API_KEY = 'secret';
    process.env.PATH = process.env.PATH ?? '/usr/bin';
    const env = sanitizedEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SAIVAGE_API_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });
});
