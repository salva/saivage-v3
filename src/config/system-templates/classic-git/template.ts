import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  gitProvisioningSchema,
  saivageConfigSchema,
  type SaivageConfigSource,
} from '../../../schemas/index.js';
import { CLASSIC_TEMPLATE } from '../classic/template.js';
import { createClassicConfig } from '../classic-shared.js';

export type GitProvisioning = z.infer<typeof gitProvisioningSchema>;
const nativeGlobalExcludedTools: readonly string[] = [
  'run_command',
  'wait_process',
  'kill_process',
  'mcp_tool_call',
  'mcp_server_control',
  'mcp_tools',
];
const nativeExecutorTools = ['checkpoint_source'];

/** No effective native configuration exists until the project supplies its policy. */
function createClassicGitConfig(input: GitProvisioning): SaivageConfigSource {
  const provisioning = gitProvisioningSchema.parse(input);
  const config = structuredClone(
    createClassicConfig(structuredClone(CLASSIC_TEMPLATE.config.card_types!)),
  );
  // This is the native profile's explicit selection, not runtime tool stripping.
  config.agents.analyst!.tools = config.agents.analyst!.tools.filter(
    (name) => !nativeGlobalExcludedTools.includes(name),
  );
  config.agents.executor!.tools.push(...nativeExecutorTools);
  config.agents.executor!.record_writes.push('git-correction.md');
  for (const definition of Object.values(config.card_types!)) {
    definition.records['git-correction.md'] = {
      format: 'markdown',
      schema: 'git-correction.v1',
      bootstrap: false,
    };
  }
  config.git_workflow = {
    format_version: 1,
    enabled: true,
    ...provisioning,
    integration: 'squash',
    preservation: {
      source_checkpoint: 'eligible-worktree',
      interrupted_rebase: 'preserve-source-before-abort',
    },
    correction: {
      agent: 'executor',
      prompt: { reference: 'git-rebase-correction', compactable: true },
      correction_prompt: { reference: 'correct-git-rebase-result', compactable: true },
    },
    review_bindings: Object.fromEntries(
      Object.keys(config.card_types!).map((type) => [
        type,
        type === 'project' || type === 'goal'
          ? { node: 'review', approved_outcome: 'approved' }
          : null,
      ]),
    ),
  };
  return saivageConfigSchema.parse(config);
}

export const CLASSIC_GIT_TEMPLATE = Object.freeze({
  name: 'classic-git',
  provisioning: 'native-git' as const,
  materialize: createClassicGitConfig,
  promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)),
});
