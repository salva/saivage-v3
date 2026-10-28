import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const actual = await import('../../src/runtime/runtime-api.js');
const release = jest.fn<typeof actual.releaseRuntimeLifecycleLock>();
jest.unstable_mockModule('../../src/runtime/runtime-api.js', () => ({ ...actual, releaseRuntimeLifecycleLock: release }));
const question = jest.fn<() => Promise<string>>();
const close = jest.fn();
jest.unstable_mockModule('node:readline/promises', () => ({ createInterface: () => ({ question, close }) }));
const { withDirectMutationComposition } = await import('../../src/boot/direct-mutation-composition.js');
const { handleRepair } = await import('../../src/cli-repair.js');
const roots: string[] = [];
const cwd = process.cwd();
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
afterEach(() => { process.chdir(cwd); Object.defineProperty(process, 'stdin', stdin); jest.restoreAllMocks(); release.mockReset(); question.mockReset(); close.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync('/home/salva/g/ml/tmp/release-callers-'); roots.push(root); return root; }
it('async initializer contains first then dispatches release uncertainty exactly once', async () => {
  const root = fixture(), trace: string[] = [];
  const uncertainty = new PublicationOutcomeUnknownError();
  const fatal = { publicationOutcomeUnknown(error: PublicationOutcomeUnknownError): never { expect(error).toBe(uncertainty); trace.push('fatal'); throw new Error('fatal sentinel'); } };
  release.mockImplementation(() => { trace.push('release'); throw uncertainty; });
  await expect(withDirectMutationComposition(root, 'init', fatal, async composition => {
    const terminate = composition.runner.terminateScopeTree.bind(composition.runner);
    jest.spyOn(composition.runner, 'terminateScopeTree').mockImplementation(async input => { trace.push('contain'); return terminate(input); });
    trace.push('operation');
  })).rejects.toThrow('fatal sentinel');
  expect(trace).toEqual(['operation', 'contain', 'release', 'fatal']); expect(release).toHaveBeenCalledTimes(1);
});
it('repair ordinary-failure release dispatches immediately before sanitized error or further prompt cleanup', async () => {
  const root = fixture(); initProjectTree(root); writeFileSync(join(root, '.saivage/saivage.yaml'), stringify(TEST_SAIVAGE_CONFIG));
  const backup = join(root, 'backup'); mkdirSync(backup);
  process.chdir(root); Object.defineProperty(process, 'stdin', { configurable: true, value: { isTTY: true } });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const uncertainty = new PublicationOutcomeUnknownError(), trace: string[] = [];
  question.mockRejectedValue(new Error('ordinary refusal'));
  close.mockImplementation(() => { trace.push('close'); });
  release.mockImplementation(() => { trace.push('release'); throw uncertainty; });
  await expect(handleRepair({ target: 'card:project', backup, report: join(root, 'report.md') }, {
    publicationOutcomeUnknown(error): never { expect(error).toBe(uncertainty); trace.push('fatal'); throw new Error('fatal sentinel'); },
  })).rejects.toThrow('fatal sentinel');
  expect(trace).toEqual(['close', 'release', 'fatal']); expect(release).toHaveBeenCalledTimes(1);
});
