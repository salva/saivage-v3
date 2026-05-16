import { describe, expect, it } from '@jest/globals';
import { looksLikeSecretPath } from '../../src/utils/secret-paths.js';

describe('secret path detection', () => {
  const cases: Array<[string, boolean]> = [
    ['/tmp/.saivage/auth-profiles.json', true],
    ['/tmp/.saivage/auth-profiles.backup', true],
    ['/home/test/.ssh/id_rsa', true],
    ['/home/test/.ssh/id_ed25519', true],
    ['/work/project/cert.pem', true],
    ['/work/project/signing.key', true],
    ['/work/project/archive.pfx', true],
    ['/work/project/.env', true],
    ['/work/project/.env.production', true],
    ['/home/test/.aws/credentials', true],
    ['/home/test/.config/gcloud/application_default_credentials.json', true],
    ['/work/project/cookies.txt', true],
    ['/work/project/.npmrc', true],
    ['/work/project/.pypirc', true],
    ['/work/project/.git/objects/ab/cd', true],
    ['/work/project/.git/token-cache', true],
    ['/work/project/src/index.ts', false],
    ['/work/project/README.md', false],
    ['/work/project/.saivage/runtime/state.json', false],
    ['/work/project/docs/credentials-guide.md', false],
  ];

  it.each(cases)('looksLikeSecretPath(%s) -> %s', (input, expected) => {
    expect(looksLikeSecretPath(input)).toBe(expected);
  });
});
