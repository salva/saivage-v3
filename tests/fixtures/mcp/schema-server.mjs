import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const [toolFile, callFile] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'schema-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [JSON.parse(readFileSync(toolFile, 'utf8'))] };
  else if (request.method === 'tools/call') {
    appendFileSync(callFile, JSON.stringify(request.params) + '\n');
    result = { content: [{ type: 'text', text: 'accepted' }] };
  } else throw new Error(`Unexpected method ${request.method}`);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
