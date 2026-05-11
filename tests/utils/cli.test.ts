/**
 * Stage 25 — CLI Entry Point Tests
 *
 * Tests for src/cli.ts covering:
 *   1. 'saivage help' prints usage text
 *   2. 'saivage status' when not in a project
 *   3. 'saivage status' when in a project with state
 *   4. 'saivage status' when in a project with no state file
 *   5. 'saivage init' initializes a non-initialized directory
 *   6. 'saivage init' in an already-initialized directory (no-op)
 *   7. 'saivage init --force' re-initializes
 *   8. 'saivage start' calls startServer with correct flags
 *   9. Unknown command prints error
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll, jest } from '@jest/globals';

// ── Spy storage ─────────────────────────────────────────────

const mockLog = jest.fn<(...args: unknown[]) => void>();
const mockError = jest.fn<(...args: unknown[]) => void>();
const mockExit = jest.fn<(code?: number) => never>();

const mockInitProjectTree = jest.fn<(root: string) => { projectRoot: string }>();
const mockIsInitialized = jest.fn<(root: string) => boolean>();
const mockFindProjectRoot = jest.fn<(startDir?: string) => string | null>();
const mockReadRuntimeState = jest.fn<(root: string) => unknown>();
const mockStartServer = jest.fn<(root: string, createRuntime?: boolean) => Promise<{ stop: () => Promise<void> }>>();

// ── Module mocks via unstable_mockModule (ESM-compatible) ──

jest.unstable_mockModule('../../src/utils/file-tree.js', () => ({
  initProjectTree: mockInitProjectTree,
  isInitialized: mockIsInitialized,
}));

jest.unstable_mockModule('../../src/utils/runtime-state.js', () => ({
  readRuntimeState: mockReadRuntimeState,
}));

jest.unstable_mockModule('../../src/utils/discovery.js', () => ({
  findProjectRoot: mockFindProjectRoot,
}));

jest.unstable_mockModule('../../src/server/server.js', () => ({
  startServer: mockStartServer,
}));

// ── Process overrides ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
process.exit = mockExit as any;

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.log = mockLog as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.error = mockError as any;

// ── Dynamic import ──────────────────────────────────────────

async function importCli() {
  return await import('../../src/cli.js');
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('CLI Entry Point', () => {
  let run: (args: string[]) => Promise<void>;

  beforeAll(async () => {
    const cli = await importCli();
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
    mockStartServer.mockClear();
  });

  afterAll(() => {
    // Restore console
    console.log = origLog;
    console.error = origError;
  });

  // ═════════════════════════════════════════════════════════════
  // help
  // ═════════════════════════════════════════════════════════════

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

  // ═════════════════════════════════════════════════════════════
  // status
  // ═════════════════════════════════════════════════════════════

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

  // ═════════════════════════════════════════════════════════════
  // init
  // ═════════════════════════════════════════════════════════════

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

      // initProjectTree should NOT be called when already initialized
      expect(mockInitProjectTree).not.toHaveBeenCalled();

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project already initialized at');
    });

    it('re-initializes with --force flag even if already initialized', async () => {
      mockIsInitialized.mockReturnValue(true);

      await run(['node', 'cli.js', 'init', '--force']);

      // initProjectTree SHOULD be called with --force
      expect(mockInitProjectTree).toHaveBeenCalledTimes(1);
      expect(mockInitProjectTree).toHaveBeenCalledWith(process.cwd());

      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Project initialized at');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // start
  // ═════════════════════════════════════════════════════════════

  describe('saivage start', () => {
    it('calls startServer with (cwd, false) by default', async () => {
      const mockServer = { stop: jest.fn<() => Promise<void>>() };
      mockStartServer.mockResolvedValue(mockServer);

      await run(['node', 'cli.js', 'start']);

      expect(mockStartServer).toHaveBeenCalledTimes(1);
      expect(mockStartServer).toHaveBeenCalledWith(process.cwd(), false);

      // Should print the listening message
      const allCalls = mockLog.mock.calls.map((c) => c[0]).join('\n');
      expect(allCalls).toContain('Saivage server listening on');

      // Clean up: remove signal handlers to avoid leaks
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

    it('prints error and calls process.exit(1) when startServer throws', async () => {
      mockStartServer.mockRejectedValue(new Error('Port already in use'));

      await run(['node', 'cli.js', 'start']);

      // Error should be logged
      const allErrors = mockError.mock.calls.map((c) => c[0]).join('\n');
      expect(allErrors).toContain('Failed to start server: Port already in use');

      // process.exit(1) should have been called
      expect(mockExit).toHaveBeenCalledWith(1);

      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // unknown command
  // ═════════════════════════════════════════════════════════════

  describe('unknown command', () => {
    it('prints error message and exits with code 1', async () => {
      await run(['node', 'cli.js', 'bogus']);

      const allErrors = mockError.mock.calls.map((c) => c[0]).join('\n');
      expect(allErrors).toContain('Unknown command: bogus');
      expect(allErrors).toContain('Run "saivage help"');

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // unknown flags
  // ═════════════════════════════════════════════════════════════

  describe('unknown flags', () => {
    it('prints parse error and exits with code 1 on unknown flag', async () => {
      await run(['node', 'cli.js', 'init', '--nonexistent']);

      const allErrors = mockError.mock.calls.map((c) => c[0]).join('\n');
      // parseArgs should produce an error message about unknown option
      expect(allErrors.length).toBeGreaterThan(0);
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
