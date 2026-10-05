import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';

const unknown = new PublicationOutcomeUnknownError();
const replaceConfigYaml = jest.fn(() => { throw unknown; });
jest.unstable_mockModule('../../src/config/config-file.js', () => ({ replaceConfigYaml }));
const { createTestConfigAuthority } = await import('../helpers/project-config.js');

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  replaceConfigYaml.mockClear();
});

describe('resolved config publication uncertainty', () => {
  it('escapes with identical uncertainty after real candidate compilation, without retry or reread', () => {
    const root = mkdtempSync(join(tmpdir(), 'resolved-config-unknown-'));
    roots.push(root);
    const authority = createTestConfigAuthority(root);
    const readDocument = jest.spyOn(Object.getPrototypeOf(authority), 'readDocument');
    let caught: unknown;
    try {
      authority.applyChange({ kind: 'set_server_setting', key: 'port', value: 8181 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(unknown);
    expect(replaceConfigYaml).toHaveBeenCalledTimes(1);
    expect(readDocument).toHaveBeenCalledTimes(1);
  });
});
