import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { startApp, type App } from '../../src/boot/app.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema, type SaivageConfig } from '../../src/schemas/saivage-config.js';

const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

export type ChatMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] };
export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
};

export function initializeProject(projectRoot: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  delete env.SAIVAGE_API_TOKEN;
  const result = spawnSync(process.execPath, [TSX, CLI, 'init'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) throw new Error(`Project initialization failed:\n${result.stdout}\n${result.stderr}`);
}

export function productionTestConfig(providerPort: number, customize?: (config: SaivageConfig) => void): SaivageConfig {
  const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  config.server = { host: '127.0.0.1', port: 8080 };
  config.models = {
    routes: Object.fromEntries(Object.keys(config.models.routes).map((name) => [name, { candidates: ['fixture-model'], temperature: 0, max_tokens: 512 }])),
    profiles: {}, equivalents: [], failover: {},
  };
  config.providers = {
    fixture: {
      models: ['fixture-model'],
      apiKey: 'test-only-provider-key',
      baseUrl: `http://127.0.0.1:${providerPort}`,
      capabilities: {
        transportProtocol: 'openai-chat-completions',
        toolsMode: 'native',
        exclusiveToolChoiceSupport: 'native',
        contextWindowTokens: 100_000,
        maxOutputTokens: 16_384,
      },
    },
  };
  config.compaction = {
    ...config.compaction,
    context_utilization_fraction: 0.8,
    summarizer_candidate: { provider: 'fixture', account: null, model: 'fixture-model' },
  };
  customize?.(config);
  return effectiveSaivageConfigSchema.parse(config);
}

export function writeProductionConfig(projectRoot: string, config: SaivageConfig): void {
  writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), stringify(config));
}

export async function readJsonRequest(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function offeredToolNames(request: ChatCompletionRequest): string[] {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}

export function sendToolCall(response: ServerResponse, id: string, name: string, args: object): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    choices: [{
      message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    }],
  }));
}

export function sendFinalMessage(response: ServerResponse, content = 'done'): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port.');
  return address.port;
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

export async function startProductionApp(projectRoot: string, token: string): Promise<App> {
  return startApp({
    projectRoot, createRuntime: false,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', SAIVAGE_HOST: '127.0.0.1', SAIVAGE_PORT: '0', SAIVAGE_API_TOKEN: token },
  });
}

export function appOrigin(app: App): string {
  const address = app.server.fastify.server.address();
  if (address === null || typeof address === 'string') throw new Error('Production app has no TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

export async function postStartProject(origin: string, token: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Start the project.' }),
  });
  return { status: response.status, body: await response.json() };
}

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export { createServer };
