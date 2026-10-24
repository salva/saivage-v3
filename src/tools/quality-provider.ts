import type { QualityToolPort } from '../contracts/quality-tools.js';
import { qualityToolInputSchema } from '../contracts/quality-tools.js';
import { qualityToolNames } from '../schemas/quality-operation-config.js';
import type { AgentName } from '../schemas/index.js';
import type { CardService } from '../cards/store-api.js';
import { toolSucceeded, toolFailed } from '../contracts/index.js';
import { resolveAgentReadPath } from '../workspace/index.js';
import { buildScopedPathUrl } from '../contracts/scoped-path-url.js';
import { defineToolBinder, executeToolAction, OPERATIONAL_RESULT_POLICY_TEMPLATE } from './invocation.js';

export interface QualityProviderContext {
  projectRoot: string; agentName: AgentName; cardId?: string; store: CardService;
  quality: QualityToolPort;
}
export const qualityToolBinders = qualityToolNames.map((name) => defineToolBinder({
  name,
  description: 'Analyze the operator-bound source scope using pinned native tooling. Findings and clean scoped coverage are evidence for ordinary assessment, not acceptance. Inspect reported coverage limits and linked mutable work artifacts; this tool neither fixes source nor accepts records.',
  inputSchema: () => qualityToolInputSchema,
  resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
  executor: (ctx: QualityProviderContext, _input, signal) => executeToolAction('none', async () => {
    const result = await ctx.quality.invoke(name, {
      resolveReadablePath(path) {
        // The finite owner selects exact work artifacts; use normal work-resource
        // admission rather than granting native reads of private .saivage paths.
        const resource = path.startsWith('.saivage/work/')
          ? buildScopedPathUrl('work', path.slice('.saivage/work/'.length).split('/')) : path;
        const selected = resolveAgentReadPath({ projectRoot: ctx.projectRoot, records: ctx.store,
          agent: { agentName: ctx.agentName, cardId: ctx.cardId },
          fail: () => new Error('Quality input is not readable by this caller.'),
        }, resource, 'read');
        if (selected.kind === 'record') throw new Error('Quality input must be a workspace file.');
        return selected.absolutePath;
      },
    }, signal);
    return result.outcome === 'clean' || result.outcome === 'findings'
      ? toolSucceeded(result) : toolFailed(result.summary, result);
  }),
}));
