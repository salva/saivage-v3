import { describe, expect, it } from '@jest/globals';
import { isSecretKey } from '../../src/redaction/secret-key.js';

describe('secret-key boolean language', () => {
  const names = [
    'apiKey', 'apiToken', 'botToken', 'accessToken', 'refreshToken', 'key', 'api_key',
    'token', 'authorization', 'secret', 'password', 'credential', 'credentials',
    'cookie', 'set-cookie', 'auth',
  ];

  it.each(names)('recognizes finite name %s with existing case and boundaries', (name) => {
    expect(isSecretKey(name)).toBe(true);
    expect(isSecretKey(name.toUpperCase())).toBe(true);
    expect(isSecretKey(`!${name}!`)).toBe(true);
    expect(isSecretKey(`${name}Z`)).toBe(false);
  });

  it.each<[string, boolean]>([
    ['', false], ['ordinary', false], ['monkey', true], ['1key', false], ['1secret', false],
    ['aKey', true], ['aKeyZ', false], ['aKey-ordinary', true], ['akey_', false],
    ['_key', true], ['1_key', true], ['1-key', true], ['1key1', false],
    ['key1', false], ['secret0', false], ['authorizationZ', false], ['credentialsZ', false],
    ['!key!', true], ['a-key', true], ['a_token', true], ['a_token0', false],
    ['someSecret', true], ['somePassword', true], ['someToken', true], ['123Secret', false],
    ['\nkey', true], ['\rkey', true], ['\r\nkey', true], ['\u2028key', true], ['\u2029key', true],
    ['a\nKey', true], ['a\nSecret', true], ['aK\ney', false], ['aTo\rken', false],
    ['aSe\u2028cret', false], ['aPass\u2029word', false], ['a_\npassword', true],
    ['ékey', true], ['keyé', true], ['ésecret', true], ['éSecretZ', false],
    ['Key', false], ['ſecret', false], ['KKey', true], ['ſSecret', true],
    ['😀key', true], ['key😀', true], ['\ud800key', true], ['key\udfff', true],
    ['1ſecret', false], ['_password_', false], ['foo_credentials', false],
  ])('classifies arbitrary key %j as %s', (key, expected) => {
    expect(isSecretKey(key)).toBe(expected);
  });

  it('recognizes bounded long mixed keys without changing suffix boundaries', () => {
    const prefix = 'a0_-'.repeat(8192);
    expect(isSecretKey(`${prefix}note`)).toBe(false);
    expect(isSecretKey(`${prefix}aKey`)).toBe(true);
    expect(isSecretKey(`${prefix}_password`)).toBe(true);
    expect(isSecretKey(`${prefix}aKeyZ`)).toBe(false);
    expect(isSecretKey(`${prefix}aKeyZ-password0`)).toBe(false);
  });
});
