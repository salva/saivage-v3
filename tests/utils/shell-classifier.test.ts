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
    ['cat ".saivage/auth-profiles.json"', '/work/saivage-v3', 'destructive'],
    ['cat ./.saivage/../.saivage/auth-profiles.json', '/work/saivage-v3', 'destructive'],
    ['echo hi > ".saivage/auth-profiles.json"', '/work/saivage-v3', 'destructive'],
    ['FOO=bar cat ".saivage/auth-profiles.json"', '/work/saivage-v3', 'destructive'],
    ['cat .AWS/credentials', '/work/saivage-v3', 'destructive'],
    ['cat .ssh', '/work/saivage-v3', 'destructive'],
    ['ls .AWS', '/work/saivage-v3', 'destructive'],
    ['cat ./.config/../.config/gcloud/application_default_credentials.json', '/work/saivage-v3', 'destructive'],
    ['cat C:/Users/test/.ssh/config', '/work', 'destructive'],
    ['cat C:/Users/test/.git/objects/ab/cd', '/work', 'destructive'],
    ['ls && python3 scripts/report-state.py', '/work/saivage-v3', 'low'],
    ['python3 scripts/report-state.py | grep ready', '/work/saivage-v3', 'low'],
    ['python3 scripts/report-state.py && cat docs/analyst.md', '/work/saivage-v3', 'low'],
    ['grep -r analyst docs/ && echo done', '/work/saivage-v3', 'low'],
    ['echo hi >> /home/test/.ssh/config', '/work', 'destructive'],
    ['cat "/home/test/.ssh/config"', '/work', 'destructive'],
    ['grep foo < .env', '/work/saivage-v3', 'destructive'],
    ['grep foo < ".saivage/auth-profiles.json"', '/work/saivage-v3', 'destructive'],
    ['grep foo < ./.saivage/../.saivage/auth-profiles.json', '/work/saivage-v3', 'destructive'],
    ['grep -r foo src/', '/work/saivage-v3', 'read_only'],
    ['git status', '/work/saivage-v3', 'read_only'],
    ['git reset --hard', '/work/saivage-v3', 'destructive'],
    ['git push --force origin main', '/work/saivage-v3', 'destructive'],
    ['git push -f origin main', '/work/saivage-v3', 'destructive'],
    ['git checkout -- .', '/work/saivage-v3', 'destructive'],
    ['git clean -fd', '/work/saivage-v3', 'destructive'],
  ];

  it.each(cases)('classifies %s as %s', (command, cwd, expected) => {
    expect(classifyShellCommand(command, cwd)).toBe(expected);
  });

  it('sanitizes inherited env keys while preserving intended safe keys', () => {
    process.env.OPENAI_API_KEY = 'secret';
    process.env.SAIVAGE_API_TOKEN = 'secret';
    process.env.ANTHROPIC_API_KEY = 'secret';
    process.env.GOOGLE_API_KEY = 'secret';
    process.env.AZURE_OPENAI_KEY = 'secret';
    process.env.TELEGRAM_BOT_TOKEN = 'secret';
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

    const env = sanitizedEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SAIVAGE_API_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.AZURE_OPENAI_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
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
});
