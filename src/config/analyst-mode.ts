import { externalPrincipalSchema } from '../schemas/index.js';
import type { CompiledProjectWorkflows } from '../runtime/runtime-api.js';

export type AnalystStartup =
  | Readonly<{ mode: 'internal' }>
  | Readonly<{
      mode: 'external' | 'both';
      port: number;
      principal: string;
      tools: readonly string[];
      token: string;
    }>;

export interface AnalystStartInputs {
  readonly analystMode?: string;
  readonly analystMcpPort?: string;
  readonly analystMcpPrincipal?: string;
  readonly analystMcpTools?: string;
}

export function resolveAnalystStartup(
  inputs: AnalystStartInputs,
  token: string | undefined,
  workflows: CompiledProjectWorkflows,
): AnalystStartup {
  const mode = inputs.analystMode ?? 'internal';
  if (mode !== 'internal' && mode !== 'external' && mode !== 'both')
    throw new Error('Invalid Analyst mode; expected internal, external or both.');
  if (mode === 'internal') {
    if (
      inputs.analystMcpPort !== undefined ||
      inputs.analystMcpPrincipal !== undefined ||
      inputs.analystMcpTools !== undefined ||
      token !== undefined
    )
      throw new Error('External Analyst settings require external or both mode.');
    return Object.freeze({ mode });
  }
  const rawPort = inputs.analystMcpPort;
  if (
    rawPort === undefined ||
    !/^[0-9]+$/u.test(rawPort) ||
    Number(rawPort) < 1 ||
    Number(rawPort) > 65535
  )
    throw new Error('External Analyst port must be an integer from 1 through 65535.');
  const principal = externalPrincipalSchema.safeParse(inputs.analystMcpPrincipal);
  if (!principal.success)
    throw new Error('External Analyst principal must be a bounded lowercase identifier.');
  if (token === undefined || token.trim() === '' || token !== token.trim())
    throw new Error(
      'SAIVAGE_ANALYST_MCP_TOKEN must be nonblank and have no surrounding whitespace.',
    );
  const tools = inputs.analystMcpTools?.split(',') ?? [];
  const configured = new Set(workflows.analyst.tools.map(({ name }) => name));
  if (
    !tools.length ||
    new Set(tools).size !== tools.length ||
    tools.some((name) => !configured.has(name))
  )
    throw new Error(
      'External Analyst tools must be a nonempty unique list of configured canonical names.',
    );
  return Object.freeze({
    mode,
    port: Number(rawPort),
    principal: principal.data,
    tools: Object.freeze(tools),
    token,
  });
}
