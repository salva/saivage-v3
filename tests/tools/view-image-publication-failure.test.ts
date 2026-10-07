import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import type { LlmToolInvocationContext } from '../../src/runtime/runtime-api.js';

const publish = jest.fn<() => void>();
const decoder = jest.fn<(...args: Parameters<typeof sharp>) => ReturnType<typeof sharp>>().mockImplementation(sharp);
jest.unstable_mockModule('sharp', () => ({ default: decoder }));
const actualPublication = await import('../../src/persistence/replace-file.js');
jest.unstable_mockModule('../../src/persistence/replace-file.js', () => ({ ...actualPublication, publishFreshFile: publish }));
const { workspaceToolBinders } = await import('../../src/tools/workspace-provider.js');
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); publish.mockReset(); decoder.mockReset().mockImplementation(sharp); });

it.each([new Error('publication denied'), new PublicationOutcomeUnknownError(new Error('rename uncertain'))])('propagates publication failure unchanged with no tool result/retry/cleanup: %s', async (failure) => {
  const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/saivage-image-failure-'); roots.push(projectRoot);
  const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
  writeFileSync(join(projectRoot, 'screen.png'), source);
  publish.mockImplementation(() => { throw failure; });
  const tool = workspaceToolBinders.find((binder) => binder.name === 'view_image')!.bind({ projectRoot, cardId: 'project', agentName: 'executor' });
  await expect(tool.executor({ path: 'screen.png' }, new AbortController().signal, { sessionId: 'agent:executor:project' } as unknown as LlmToolInvocationContext)).rejects.toBe(failure);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(readdirSync(join(projectRoot, '.saivage/cards/project/conversations/executor/images'))).toEqual([]);
});

it('does not classify native/programming decoder failure as invalid input', async () => {
  const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/saivage-image-native-'); roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'screen.png'), await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).png().toBuffer());
  const failure = Object.assign(new Error('Native library unavailable'), { code: 'EACCES' });
  decoder.mockImplementationOnce(() => { throw failure; });
  const tool = workspaceToolBinders.find((binder) => binder.name === 'view_image')!.bind({ projectRoot, cardId: 'project', agentName: 'executor' });
  await expect(tool.executor({ path: 'screen.png' }, new AbortController().signal, { sessionId: 'agent:executor:project' } as unknown as LlmToolInvocationContext)).rejects.toBe(failure);
  expect(publish).not.toHaveBeenCalled();
});

it('fences cancellation during asynchronous conversion before snapshot publication', async () => {
  const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/saivage-image-cancel-'); roots.push(projectRoot);
  const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
  writeFileSync(join(projectRoot, 'screen.png'), source);
  const metadata = await sharp(source).metadata();
  let release!: (value: typeof metadata) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<typeof metadata>(resolve => { release = resolve; });
  decoder.mockImplementationOnce((...args) => {
    const pipeline = sharp(...args);
    jest.spyOn(pipeline, 'metadata').mockImplementation(() => { entered(); return pending; });
    return pipeline;
  });
  const tool = workspaceToolBinders.find(binder => binder.name === 'view_image')!.bind({ projectRoot, cardId: 'project', agentName: 'executor' });
  const controller = new AbortController();
  const operation = tool.executor({ path: 'screen.png' }, controller.signal, { sessionId: 'agent:executor:project' } as unknown as LlmToolInvocationContext);
  await started;
  const reason = new Error('cancelled during image decode');
  controller.abort(reason);
  release(metadata);
  await expect(operation).rejects.toBe(reason);
  expect(publish).not.toHaveBeenCalled();
});
