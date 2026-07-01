import { toolDefinitionByName } from '../tools/definitions/index.js';
import type { AgentRole } from '../tools/tool-catalog.js';
export {
  READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
} from '../tools/definitions/index.js';
import { applyProjectPatch, editProject, globProject, grepProject, readProject, writeProject } from '../tools/project-file-tools.js';
import { createProcessProvider } from '../tools/process-provider.js';
import { buildInvocationSurface, invokeTool } from '../tools/invocation.js';

export interface WorkspaceToolContext {
  projectRoot: string;
  sessionId: string;
  cardId?: string;
  goalId?: string;
  agentRole?: AgentRole;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Workspace tool arguments must be valid JSON.');
  }
}

function parseWorkspaceArgs(name: string, raw: string): Record<string, unknown> {
  const definition = toolDefinitionByName(name);
  if (!definition?.workspace) throw new Error(`Unknown workspace tool '${name}'.`);
  const parsed = definition.input.parse(parseArgs(raw));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export async function processWorkspaceToolCall(
  name: string,
  rawArguments: string,
  context: WorkspaceToolContext,
): Promise<unknown> {
  const args = parseWorkspaceArgs(name, rawArguments);

  if (name === 'read') {
    return readProject(context, args as { path: string; offset?: number; limit?: number; read_mode?: 'auto' | 'text' | 'multimodal' });
  }

  if (name === 'write') {
    return writeProject(context, args as { path: string; content: string });
  }

  if (name === 'glob') {
    return globProject(context, args as { directory: string; pattern: string; max_results?: number });
  }

  if (name === 'grep') {
    return grepProject(context, args as { pattern: string; path?: string; include?: string; max_results?: number });
  }

  if (name === 'edit') {
    return editProject(context, args as { path: string; old_string: string; new_string: string; replace_all?: boolean });
  }

  if (name === 'apply_patch') {
    return applyProjectPatch(context, args as { patch: string });
  }

  if (name === 'run_command' || name === 'wait_process' || name === 'kill_process') {
    const surface = buildInvocationSurface(context.agentRole ?? 'executor', [createProcessProvider({ projectRoot: context.projectRoot, ownerId: context.sessionId, cardId: context.cardId })]);
    const result = await invokeTool(surface, name, args);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }

  throw new Error(`Unknown workspace tool '${name}'.`);
}
