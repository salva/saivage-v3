import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { mcpConnectionSchema, mcpAccessPolicySchema } from '../schemas/index.js';
import { replaceFile } from '../persistence/index.js';

const mcpServerDefinitionsSchema = z
  .object({
    format_version: z.literal(2),
    type: z.literal('mcp-server-definitions'),
    servers: z.record(
      z.string().min(1),
      z
        .object({
          connection: mcpConnectionSchema,
          policy: mcpAccessPolicySchema,
        })
        .strict(),
    ),
  })
  .strict();

export function mcpServerDefinitionsPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'config', 'mcp-servers.json');
}

export type McpServerDefinition = z.infer<typeof mcpServerDefinitionsSchema>['servers'][string];

export function readMcpServerDefinitions(projectRoot: string): Record<string, McpServerDefinition> {
  let source: string;
  try {
    source = readFileSync(mcpServerDefinitionsPath(projectRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  // Do not include connection values or parser diagnostics in outward failures.
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Invalid MCP server definitions JSON.');
  }
  const parsed = mcpServerDefinitionsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid MCP server definitions contract.');
  return (value as z.infer<typeof mcpServerDefinitionsSchema>).servers;
}

export function replaceMcpServerDefinitions(
  projectRoot: string,
  servers: Record<string, McpServerDefinition>,
): void {
  const path = mcpServerDefinitionsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  replaceFile(
    path,
    Buffer.from(
      `${JSON.stringify({ format_version: 2, type: 'mcp-server-definitions', servers })}\n`,
    ),
  );
}
