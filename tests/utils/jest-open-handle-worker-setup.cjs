const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const originalSpawn = childProcess.spawn;
const originalFork = childProcess.fork;
const originalExec = childProcess.exec;
const originalExecFile = childProcess.execFile;

const childRecords = [];
let nextChildId = 1;

function safeError(value) {
  if (!value) return undefined;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return { value: String(value) };
}

function safeClone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function readProcCmdline(pid) {
  if (!pid || typeof pid !== 'number') return undefined;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (!raw.length) return '';
    return raw.toString('utf8').split('\u0000').filter(Boolean);
  } catch (error) {
    return { unavailable: true, error: safeError(error) };
  }
}

function captureStack() {
  const error = new Error('child_process origin');
  if (!error.stack) return undefined;
  return error.stack
    .split('\n')
    .slice(2)
    .filter((line) => !line.includes('jest-open-handle-worker-setup.cjs'));
}

function normalizeExecOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const clone = { ...options };
  if (typeof clone.env === 'object' && clone.env) {
    clone.env = {
      ...clone.env,
      SAIVAGE_API_TOKEN: clone.env.SAIVAGE_API_TOKEN ? '[redacted]' : clone.env.SAIVAGE_API_TOKEN,
      OPENAI_API_KEY: clone.env.OPENAI_API_KEY ? '[redacted]' : clone.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: clone.env.ANTHROPIC_API_KEY ? '[redacted]' : clone.env.ANTHROPIC_API_KEY,
    };
  }
  return clone;
}

function attachChildRecord(method, command, args, options, child) {
  const record = {
    id: nextChildId++,
    parentPid: process.pid,
    method,
    command,
    args: Array.isArray(args) ? [...args] : [],
    cwd: options && typeof options === 'object' && options.cwd ? options.cwd : process.cwd(),
    options: safeClone(normalizeExecOptions(options)),
    spawnfile: child && child.spawnfile,
    spawnargs: child && Array.isArray(child.spawnargs) ? [...child.spawnargs] : undefined,
    pid: child && typeof child.pid === 'number' ? child.pid : undefined,
    procCmdlineAtSpawn: child && typeof child.pid === 'number' ? readProcCmdline(child.pid) : undefined,
    connectedAtSpawn: child && typeof child.connected === 'boolean' ? child.connected : undefined,
    killedAtSpawn: child && typeof child.killed === 'boolean' ? child.killed : undefined,
    stack: captureStack(),
    events: [],
  };
  childRecords.push(record);

  if (child && typeof child.on === 'function') {
    child.on('spawn', () => {
      record.events.push({
        event: 'spawn',
        at: new Date().toISOString(),
        pid: child.pid,
        procCmdline: readProcCmdline(child.pid),
      });
    });
    child.on('error', (error) => {
      record.events.push({ event: 'error', at: new Date().toISOString(), error: safeError(error) });
    });
    child.on('exit', (code, signal) => {
      record.events.push({ event: 'exit', at: new Date().toISOString(), code, signal });
      record.exitCode = code;
      record.exitSignal = signal;
    });
    child.on('close', (code, signal) => {
      record.events.push({ event: 'close', at: new Date().toISOString(), code, signal });
      record.closeCode = code;
      record.closeSignal = signal;
    });
    child.on('disconnect', () => {
      record.events.push({ event: 'disconnect', at: new Date().toISOString() });
    });
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('close', () => {
        record.events.push({ event: 'stdout-close', at: new Date().toISOString() });
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('close', () => {
        record.events.push({ event: 'stderr-close', at: new Date().toISOString() });
      });
    }
  }

  return child;
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  const child = originalSpawn.apply(this, arguments);
  return attachChildRecord('spawn', command, args, options, child);
};

childProcess.fork = function patchedFork(modulePath, args, options) {
  const child = originalFork.apply(this, arguments);
  return attachChildRecord('fork', process.execPath, [modulePath, ...(Array.isArray(args) ? args : [])], options, child);
};

childProcess.exec = function patchedExec(command, options, callback) {
  const child = originalExec.apply(this, arguments);
  const normalizedOptions = typeof options === 'function' ? undefined : options;
  return attachChildRecord('exec', command, [], normalizedOptions, child);
};

childProcess.execFile = function patchedExecFile(file, args, options, callback) {
  const child = originalExecFile.apply(this, arguments);
  let normalizedArgs = [];
  let normalizedOptions = options;
  if (!Array.isArray(args)) {
    normalizedOptions = args;
  } else {
    normalizedArgs = args;
  }
  if (typeof normalizedOptions === 'function') {
    normalizedOptions = undefined;
  }
  return attachChildRecord('execFile', file, normalizedArgs, normalizedOptions, child);
};

function summarizeHandle(handle) {
  if (!handle || typeof handle !== 'object') {
    return { type: typeof handle, value: String(handle) };
  }

  const summary = {
    type: handle.constructor && handle.constructor.name ? handle.constructor.name : 'Unknown',
  };

  if (typeof handle.hasRef === 'function') {
    try {
      summary.hasRef = handle.hasRef();
    } catch {}
  }

  for (const key of ['fd', 'pid', 'connecting', 'destroyed', 'readable', 'writable', 'bytesRead', 'bytesWritten']) {
    if (key in handle) {
      summary[key] = handle[key];
    }
  }

  if ('_idleTimeout' in handle) summary.idleTimeout = handle._idleTimeout;
  if ('_repeat' in handle) summary.repeat = handle._repeat;
  if ('_onTimeout' in handle) {
    const fn = handle._onTimeout;
    summary.onTimeoutName = typeof fn === 'function' && fn.name ? fn.name : typeof fn;
  }

  if (handle._sockname) summary.sockname = handle._sockname;
  if (handle._peername) summary.peername = handle._peername;
  if (handle.server && handle.server.address) {
    try {
      summary.serverAddress = handle.server.address();
    } catch {}
  }

  if (summary.type === 'ChildProcess') {
    summary.spawnfile = handle.spawnfile;
    summary.spawnargs = Array.isArray(handle.spawnargs) ? [...handle.spawnargs] : undefined;
    summary.killed = handle.killed;
    summary.exitCode = handle.exitCode;
    summary.signalCode = handle.signalCode;
    summary.connected = handle.connected;
    summary.procCmdline = typeof handle.pid === 'number' ? readProcCmdline(handle.pid) : undefined;
    summary.record = childRecords.find((record) => record.pid === handle.pid);
  }

  if (typeof handle.listenerCount === 'function') {
    try {
      summary.listenerCounts = {
        close: handle.listenerCount('close'),
        error: handle.listenerCount('error'),
        finish: handle.listenerCount('finish'),
        end: handle.listenerCount('end'),
        exit: handle.listenerCount('exit'),
      };
    } catch {}
  }

  return summary;
}

const reportDir = process.env.SAIVAGE_STAGE_REPORT_DIR;
let written = false;

function writeSnapshot(reason) {
  if (!reportDir || written) return;
  written = true;
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, `worker-exit-handles-${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      reason,
      timestamp: new Date().toISOString(),
      handleCount: handles.length,
      requestCount: requests.length,
      handles: handles.map(summarizeHandle),
      requests: requests.map((request) => ({
        type: request && request.constructor && request.constructor.name ? request.constructor.name : typeof request,
      })),
      childProcesses: childRecords,
    }, null, 2),
    'utf8',
  );
}

process.once('beforeExit', () => writeSnapshot('beforeExit'));
process.once('exit', () => writeSnapshot('exit'));
