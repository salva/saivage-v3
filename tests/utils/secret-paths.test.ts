import { describe, expect, it } from '@jest/globals';
import { looksLikeSecretPath } from '../../src/workspace/secret-paths.js';

describe('secret path detection', () => {
  const cases: Array<[string, boolean]> = [
    ['/tmp/.saivage/auth-profiles.json', true],
    ['/tmp/.saivage/auth-profiles.backup', true],
    ['/tmp/.saivage/AUTH-PROFILES.JSON', true],
    ['/tmp/.saivage/auth-profiles', true],
    ['/tmp/project/.ssh', true],
    ['/tmp/project/.AWS', true],
    ['/tmp/project/nested/../.ssh', true],
    ['C:\\Users\\test\\.AWS', true],
    ['/home/test/.ssh/id_rsa', true],
    ['/home/test/.ssh/id_rsa.pub', true],
    ['/home/test/.ssh/id_ed25519', true],
    ['/home/test/.ssh/id_ed25519.pub', true],
    ['/home/test/.AWS/credentials', true],
    ['/home/test/.config/gcloud/application_default_credentials.json', true],
    ['/work/project/cert.pem', true],
    ['/work/project/signing.key', true],
    ['/work/project/archive.pfx', true],
    ['/work/project/.env', true],
    ['/work/project/.env.production', true],
    ['/work/project/./nested/../.env.local', true],
    ['C:\\Users\\test\\.ssh\\config', true],
    ['C:\\Users\\test\\.AWS\\credentials', true],
    ['C:\\work\\project\\.git\\objects\\ab\\cd', true],
    ['/work/project/cookies.txt', true],
    ['/work/project/.npmrc', true],
    ['/work/project/.pypirc', true],
    ['/work/project/.git/objects', true],
    ['/work/project/.git/objects/ab/cd', true],
    ['/work/project/.git/token-cache', true],
    ['/work/project/.git/auth', true],
    ['/work/project/.git/auth/log', true],
    ['/work/project/src/index.ts', false],
    ['/work/project/README.md', false],
    ['/work/project/.saivage/state/runtime.json', false],
    ['/work/project/docs/credentials-guide.md', false],
    ['/work/project/.github/workflows/ci.yml', false],
  ];

  it.each(cases)('looksLikeSecretPath(%s) -> %s', (input, expected) => {
    expect(looksLikeSecretPath(input)).toBe(expected);
  });
});
