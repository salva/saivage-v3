import { describe, it, expect, beforeEach, afterAll, beforeAll, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const mockLog = jest.fn<(...args: unknown[]) => void>();
const mockError = jest.fn<(...args: unknown[]) => void>();
const mockExit = jest.fn<(code?: number) => never>();

const mockInitProjectTree = jest.fn<(root: string) => { projectRoot: string }>();
const mockIsInitialized = jest.fn<(root: string) => boolean>();
const mockFindProjectRoot = jest.fn<(startDir?: string) => string | null>();
const mockReadRuntimeState = jest.fn<(root: string) => unknown>();
const mockUpdateRuntimeState = jest.fn<(root: string, patch: unknown) => void>();
const mockStartServer = jest.fn<(root: string, createRuntime?: boolean) => Promise<{ stop: () => Promise<void> }>>();
const mockIsLocked = jest.fn<(root: string) => boolean>();
const mockPauseRuntimeControl = jest.fn<(input: unknown) => { ok: boolean; message?: string; error?: string }>();
const mockResumeRuntimeControl = jest.fn<(input: unknown) => { ok: boolean; message?: string; error?: string }>();
const mockEvaluateAuthz = jest.fn<(...args: unknown[]) => 'allow' | 'deny' | 'preview_only'>();
const mockRecordControlAction = jest.fn<(...args: unknown[]) => void>();
const mockStableStringify = jest.fn<(value: unknown) => string>();

jest.unstable_mockModule('../../src/utils/file-tree.js', () => ({
  initProjectTree: mockInitProjectTree,
  isInitialized: mockIsInitialized,
  writeFileAtomic: jest.fn(),
}));

jest.unstable_mockModule('../../src/runtime/state.js', () => ({
  readRuntimeState: mockReadRuntimeState,
  updateRuntimeState: mockUpdateRuntimeState,
}));

jest.unstable_mockModule('../../src/utils/discovery.js', () => ({
  findProjectRoot: mockFindProjectRoot,
}));

jest.unstable_mockModule('../../src/server/server.js', () => ({
  startServer: mockStartServer,
}));

jest.unstable_mockModule('../../src/utils/runtime-lock.js', () => ({
  isLocked: mockIsLocked,
}));

jest.unstable_mockModule('../../src/utils/runtime-control.js', () => ({
  pauseRuntimeControl: mockPauseRuntimeControl,
  resumeRuntimeControl: mockResumeRuntimeControl,
}));

jest.unstable_mockModule('../../src/agents/authz.js', () => ({
  evaluateAuthz: mockEvaluateAuthz,
}));

jest.unstable_mockModule('../../src/utils/control-action-audit.js', () => ({
  recordControlAction: mockRecordControlAction,
  stableStringify: mockStableStringify,
}));

process.exit = mockExit as any;

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = mockLog as any;
console.error = mockError as any;

async function importCli() {
  return await import('../../src/cli.js');
}

describe('CLI Entry Point', () => {
  let run: (args: string[]) => Promise<void>;
  let importSideEffects: { logCalls: number; errorCalls: number; exitCalls: number };
  const originalArgv1 = process.argv[1];

  beforeAll(async () => {
    process.argv[1] = '/tmp/not-the-entrypoint/saivage';
    const cli = await importCli();
    await new Promise<void>((resolve) => setImmediate(resolve));
    importSideEffects = {
      logCalls: mockLog.mock.calls.length,
      errorCalls: mockError.mock.calls.length,
      exitCalls: mockExit.mock.calls.length,
    };
    process.argv[1] = originalArgv1;
    run = cli.run;
  });

  beforeEach(() => {
    mockLog.mockClear();
    mockError.mockClear();
    mockExit.mockClear();
    mockInitProjectTree.mockClear();
    mockIsInitialized.mockClear();
    mockFindProjectRoot.mockClear();
    mockReadRuntimeState.mockClear();
    mockUpdateRuntimeState.mockClear();
    mockStartServer.mockClear();
    mockIsLocked.mockReset();
    mockPauseRuntimeControl.mockReset();
    mockResumeRuntimeControl.mockReset();
    mockEvaluateAuthz.mockReset();
    mockRecordControlAction.mockClear();
    mockStableStringify.mockReset();
    mockIsLocked.mockReturnValue(false);
    mockEvaluateAuthz.mockReturnValue('allow');
    mockStableStringify.mockImplementation((value: unknown) => JSON.stringify(value));
    mockPauseRuntimeControl.mockReturnValue({ ok: true });
    mockResumeRuntimeControl.mockReturnValue({ ok: true });
  });

  afterAll(() => {
    process.argv[1] = originalArgv1;
    console.log = origLog;
    console.error = origError;
  });

  describe('entrypoint guard', () => {
    it('does not auto-run when imported with a different argv path named saivage', () => {
      expect(importSideEffects).toEqual({ logCalls: 0, errorCalls: 0, exitCalls: 0 });
    });

    it('bin wrapper imports the compiled CLI and explicitly invokes run(process.argv)', () => {
      const wrapper = readFileSync(new URL('../../bin/saivage.js', import.meta.url), 'utf-8');
      expect(wrapper).toContain("import('../dist/src/cli.js')");
      expect(wrapper).toContain('mod.run(process.argv)');
    });
  });

  describe('saivage help', () => {
    it('prints usage text containing "Saivage v3 CLI"', async () => {
      await run(['node', 'cli.js', 'help']);
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage v3 CLI');
    });

    it('prints usage for --help flag', async () => {
      await run(['node', 'cli.js', '--help']);
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage v3 CLI');
    });

    it('prints usage for -h flag', async () => {
      await run(['node', 'cli.js', '-h']);
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage v3 CLI');
    });

    it('no arguments defaults to help', async () => {
      await run(['node', 'cli.js']);
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage v3 CLI');
    });
  });

  describe('saivage status', () => {
    it('prints "Not in a Saivage project" when findProjectRoot returns null', async () => {
      mockFindProjectRoot.mockReturnValue(null);
      await run(['node', 'cli.js', 'status']);
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Not in a Saivage project');
    });

    it('prints all state fields when state exists', async () => {
      mockFindProjectRoot.mockReturnValue('/tmp/test-project');
      mockReadRuntimeState.mockReturnValue({
        status: 'running',
        pid: 12345,
        paused: false,
        current_card_id: 'card-42',
        started_at: '2025-06-01T12:00:00.000Z',
        queue: ['goal-a', 'goal-b'],
      });

      await run(['node', 'cli.js', 'status']);

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project root: /tmp/test-project');
      expect(allCalls).toContain('Status:       running');
      expect(allCalls).toContain('PID:          12345');
      expect(allCalls).toContain('Paused:       false');
      expect(allCalls).toContain('Current card: card-42');
      expect(allCalls).toContain('Started at:   2025-06-01T12:00:00.000Z');
      expect(allCalls).toContain('Queue length: 2');
    });

    it('prints "not initialized" when state file does not exist', async () => {
      mockFindProjectRoot.mockReturnValue('/tmp/test-project');
      mockReadRuntimeState.mockReturnValue(null);

      await run(['node', 'cli.js', 'status']);

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project root: /tmp/test-project');
      expect(allCalls).toContain('Runtime state: not initialized (no state.json)');
    });

    it('handles null current_card_id gracefully', async () => {
      mockFindProjectRoot.mockReturnValue('/tmp/test-project');
      mockReadRuntimeState.mockReturnValue({
        status: 'idle',
        pid: 999,
        paused: true,
        current_card_id: null,
        started_at: '2025-06-02T00:00:00.000Z',
        queue: [],
      });

      await run(['node', 'cli.js', 'status']);

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Current card: (none)');
      expect(allCalls).toContain('Paused:       true');
      expect(allCalls).toContain('Queue length: 0');
    });
  });

  describe('saivage init', () => {
    it('initializes a non-initialized directory', async () => {
      mockIsInitialized.mockReturnValue(false);
      mockInitProjectTree.mockReturnValue({ projectRoot: '/tmp/fresh-project' });

      await run(['node', 'cli.js', 'init']);

      expect(mockInitProjectTree).toHaveBeenCalledTimes(1);
      expect(mockInitProjectTree).toHaveBeenCalledWith(process.cwd());

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project initialized at');
    });

    it('prints "already initialized" when project is initialized and no --force', async () => {
      mockIsInitialized.mockReturnValue(true);

      await run(['node', 'cli.js', 'init']);

      expect(mockInitProjectTree).not.toHaveBeenCalled();

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project already initialized at');
    });

    it('re-initializes with --force flag even if already initialized', async () => {
      mockIsInitialized.mockReturnValue(true);

      await run(['node', 'cli.js', 'init', '--force']);

      expect(mockInitProjectTree).toHaveBeenCalledTimes(1);
      expect(mockInitProjectTree).toHaveBeenCalledWith(process.cwd());

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project initialized at');
    });
  });

  describe('saivage start', () => {
    it('calls startServer with (cwd, false) by default', async () => {
      const mockServer = { stop: jest.fn<() => Promise<void>>() };
      mockStartServer.mockResolvedValue(mockServer);

      await run(['node', 'cli.js', 'start']);

      expect(mockStartServer).toHaveBeenCalledTimes(1);
      expect(mockStartServer).toHaveBeenCalledWith(process.cwd(), false);

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage server listening on');

      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    });

    it('calls startServer with (cwd, true) when --create-runtime is passed', async () => {
      const mockServer = { stop: jest.fn<() => Promise<void>>() };
      mockStartServer.mockResolvedValue(mockServer);

      await run(['node', 'cli.js', 'start', '--create-runtime']);

      expect(mockStartServer).toHaveBeenCalledTimes(1);
      expect(mockStartServer).toHaveBeenCalledWith(process.cwd(), true);

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage server listening on');

      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    });
  });

  describe('unknown command', () => {
    it('rejects with unknown command error', async () => {
      await expect(run(['node', 'cli.js', 'bogus'])).rejects.toThrow('Unknown command: bogus');
    });
  });

  describe('unknown flags', () => {
    it('rejects on unknown flag', async () => {
      await expect(run(['node', 'cli.js', 'init', '--nonexistent'])).rejects.toThrow();
    });
  });
});
