import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import ThreadStream from 'thread-stream';
import type { Environment } from '../../src/config/index.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

// Synthetic clear-screen/OSC sequences differ from the formatter's trusted SGR.
const controls = '\u0000\u0007\r\u001b[2J\u001b]0;INJECTED-TITLE\u0007\u007f\u0085\u009b';
const message = `LOGGER-MESSAGE-BEGIN ordinary\ttext\nsecond-line ${controls} LOGGER-MESSAGE-END`;
const property = `LOGGER-KEY-BEGIN property-${controls} LOGGER-KEY-END`;
const errorMessage = `LOGGER-ERR-MESSAGE-BEGIN synthetic-error ${controls} LOGGER-ERR-MESSAGE-END`;
const stack = `Error: LOGGER-STACK-BEGIN synthetic-error ${controls}\n    at synthetic-frame\tLOGGER-STACK-END`;
const redacted = redactTextForOutbound('safe prose token=LOGGER-SYNTHETIC-SECRET\nmore safe prose');

function report(value: object): void {
  if (!process.send) throw new Error('Logger fixture requires IPC');
  process.send(value, (error) => {
    if (error) throw error;
    process.disconnect();
  });
}

function dependencySmoke(): void {
  const require = createRequire(import.meta.url);
  const prettyRequire = createRequire(require.resolve('pino-pretty'));
  const pinoRequire = createRequire(require.resolve('pino'));
  const prettyVersion = require('pino-pretty/package.json').version;
  const pinoVersion = require('pino/package.json').version;
  const prettySonicVersion = prettyRequire('sonic-boom/package.json').version;
  const pinoSonicVersion = pinoRequire('sonic-boom/package.json').version;
  const copyEntry = prettyRequire.resolve('fast-copy');
  const { copy } = prettyRequire('fast-copy') as { copy: <T>(value: T) => T };
  const version = JSON.parse(readFileSync(resolve(dirname(copyEntry), '../../package.json'), 'utf8')).version;
  const source = { nested: { value: 'shallow-copy' } };
  const cloned = copy(source);
  let deep: Record<string, unknown> = {};
  for (let depth = 0; depth < 1_100; depth += 1) deep = { nested: deep };
  let depthError: object | null = null;
  try {
    copy(deep);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    depthError = { name: error.name, message: error.message, rangeError: error instanceof RangeError };
  }
  report({ version, prettyVersion, pinoVersion, prettySonicVersion, pinoSonicVersion, cloned, independent: cloned !== source && cloned.nested !== source.nested, depthError });
}

async function loggerSmoke(nodeEnv: 'development' | 'production'): Promise<void> {
  // Composition consumes only these fields: no runtime state or providers.
  const app = await createFastifyApp({ nodeEnv, server: { logLevel: 'info' } } as Environment, testApplicationFatalPort);
  const destination = (app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym];
  const prettyWorker = destination instanceof ThreadStream;
  if (destination instanceof ThreadStream) {
    // Pino unrefs its transport on ready. Keep the actual worker alive until
    // explicit flush/end/close, rather than relying on exit hooks.
    // thread-stream exposes these APIs at runtime but omits them in its types.
    const transport = destination as ThreadStream & { readonly ready: boolean; ref(): void };
    if (!transport.ready) await once(transport, 'ready');
    transport.ref();
  }
  app.get('/logger-probe', async (request) => ({
    url: request.url, query: request.query, authorization: request.headers.authorization,
  }));
  app.post('/logger-json', async () => ({ ok: true }));
  app.get('/logger-error', async () => { throw new Error('ordinary-handler-error'); });
  const error = new Error(errorMessage);
  error.stack = stack;
  app.log.info({ [property]: 'property-value', err: error }, message);
  app.log.info(redacted);
  const routed = await app.inject({
    method: 'GET', url: '/logger-probe?ticket=LOGGER-QUERY-CREDENTIAL&query_marker=present',
    headers: { authorization: 'Bearer LOGGER-HEADER-CREDENTIAL', host: 'operator.example' },
  });
  const malformed = await app.inject({
    method: 'POST', url: '/logger-json', headers: { 'content-type': 'application/json' }, payload: '{broken',
  });
  const thrown = await app.inject({ method: 'GET', url: '/logger-error' });
  await app.close();
  // Fastify's base logger type omits flush; composition constructs a real Pino
  // logger, whose supported flush API drains the configured destination.
  const logger = app.log as pino.Logger;
  await new Promise<void>((done, reject) => logger.flush((error) => error ? reject(error) : done()));
  if (destination instanceof ThreadStream) {
    const closed = once(destination, 'close');
    destination.end();
    await closed;
  }
  report({ prettyWorker, routedStatus: routed.statusCode, routed: routed.json(), malformedStatus: malformed.statusCode, thrownStatus: thrown.statusCode });
}

const mode = process.argv[2];
if (mode === 'copy') dependencySmoke();
else if (mode === 'development' || mode === 'production') await loggerSmoke(mode);
else throw new Error(`Unknown logger fixture mode: ${mode}`);
