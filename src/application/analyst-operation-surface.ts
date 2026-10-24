import type { OperationAuthor } from '../schemas/index.js';
import { bindQualityToolExecution } from '../runtime/runtime-api.js';
import { operationActor } from '../schemas/index.js';
import type { OutboundHttpEmitter } from '../contracts/index.js';
import type {
  CompiledProjectWorkflows,
  RuntimeApi,
  ProcessPosition,
} from '../runtime/runtime-api.js';
import { BoundAgentToolSet, queue_notification } from '../tools/tool-api.js';
import type { ToolContext } from '../tools/execution-api.js';
import { createAnalystMutationServices } from './analyst-mutation-services.js';

/** One policy-bound operation surface; no conversation or model actor is constructed here. */
export function createAnalystOperationSurface(input: {
  workflows: CompiledProjectWorkflows;
  author: OperationAuthor;
  allowedTools: readonly string[];
  context: Omit<ToolContext, 'actor' | 'surface' | 'policyAgentName' | 'analystMutations'>;
  submitNotification: RuntimeApi['submitNotification'];
  cancelCard: RuntimeApi['cancelCard'];
  currentProcessPosition(cardId: string): ProcessPosition | null;
  outboundHttp?: OutboundHttpEmitter;
}) {
  const { workflows, allowedTools } = input;
  const selected = workflows.analyst.tools.filter(({ name }) => allowedTools.includes(name));
  if (new Set(allowedTools).size !== allowedTools.length || selected.length !== allowedTools.length)
    throw new Error('Analyst operation tools must be unique configured canonical tool names.');
  const context: ToolContext = {
    ...input.context,
    policyAgentName: workflows.analyst.name,
    actor: operationActor(input.author),
    surface: input.author.kind === 'external-agent' ? 'mcp' : 'web-chat',
    analystMutations: createAnalystMutationServices({
      store: input.context.store,
      configAuthority: input.context.configAuthority,
      notifyCard: input.context.runtime.notifyCard,
      submitNotification: input.submitNotification,
      cancelCard: input.cancelCard,
      author: input.author,
      allowedTools,
    }),
  };
  if (workflows.analyst.qualityTools && !context.qualityProcessParentScope)
    throw new Error('Analyst quality tools require the owner container scope.');
  return new BoundAgentToolSet(selected).bind({
    ...(workflows.analyst.qualityTools ? { quality: bindQualityToolExecution({
      projectRoot: context.projectRoot, bindings: workflows.analyst.qualityTools,
      operations: workflows.operations, processRunner: context.processRunner,
      parentScope: context.qualityProcessParentScope!,
      ownerId: operationActor(input.author),
      sessionId: context.sessionId,
    }) } : {}),
    outboundHttp: input.outboundHttp,
    scope: 'global',
    agentName: workflows.analyst.name,
    projectRoot: context.projectRoot,
    store: context.store,
    processRunner: context.processRunner,
    processScope: context.processScope,
    processOwnerId:
      input.author.kind === 'external-agent' ? operationActor(input.author) : context.sessionId,
    mcpToolInvocation: context.mcpToolInvocation,
    retrieval: context.retrieval,
    analystToolContext: context,
    observationToolContext: {
      agentName: workflows.analyst.name,
      projectRoot: context.projectRoot,
      store: context.store,
      processRunner: context.processRunner,
      eventQueries: context.eventQueries,
      runtime: { getStatus: context.runtime.getStatus },
      queueNotification: (args, signal) => queue_notification(context, args, signal),
      captureExecutingLlmSnapshots: context.captureExecutingLlmSnapshots,
      currentProcessPosition: input.currentProcessPosition,
    },
    cardTypeVocabulary: workflows.cardTypeVocabulary,
  });
}
