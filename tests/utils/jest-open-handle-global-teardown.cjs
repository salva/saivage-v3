const fs = require('node:fs');
const path = require('node:path');

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

  if ('fd' in handle) summary.fd = handle.fd;
  if ('pid' in handle) summary.pid = handle.pid;
  if ('connecting' in handle) summary.connecting = handle.connecting;
  if ('destroyed' in handle) summary.destroyed = handle.destroyed;
  if ('readable' in handle) summary.readable = handle.readable;
  if ('writable' in handle) summary.writable = handle.writable;
  if ('bytesRead' in handle) summary.bytesRead = handle.bytesRead;
  if ('bytesWritten' in handle) summary.bytesWritten = handle.bytesWritten;

  if ('_idleTimeout' in handle) summary.idleTimeout = handle._idleTimeout;
  if ('_repeat' in handle) summary.repeat = handle._repeat;
  if ('_onTimeout' in handle) {
    const fn = handle._onTimeout;
    summary.onTimeoutName = typeof fn === 'function' && fn.name ? fn.name : typeof fn;
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

module.exports = async () => {
  const reportDir = process.env.SAIVAGE_STAGE_REPORT_DIR;
  if (!reportDir) return;

  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];

  const payload = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    handleCount: handles.length,
    requestCount: requests.length,
    handles: handles.map(summarizeHandle),
    requests: requests.map((request) => ({
      type: request && request.constructor && request.constructor.name ? request.constructor.name : typeof request,
    })),
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, `open-handles-worker-${process.pid}.json`),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
};
