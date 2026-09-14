import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { AnalystToolOutcome, ToolContext } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';
import {
  reconfigureParamsSchema,
  type ReconfigureParams,
} from '../config/reconfigure-contract.js';
import type { ConfigMutation } from '../config/resolved-config-authority.js';
import { redactForOutbound } from '../redaction/index.js';
import { toolFailed, toolSucceeded } from '../contracts/tool-result.js';
import type { QueueNotificationToolInput } from './notification-tool.js';

export async function queue_notification(
  ctx: ToolContext,
  params: QueueNotificationToolInput,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(
    ctx,
    params,
    {
      action: 'notification.queue',
      safety_class: 'low',
      target_kind: 'card',
      getTargetId: () => params.card_id,
      lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
      mutate: (_prepared, input, mutation) =>
        mutation.services.notifications.queue(input.card_id, input.kind, input.body, input.urgency, signal),
    },
    signal,
  );
}

export async function show_config(
  ctx: ToolContext,
  _params: Record<string, never> = {},
): Promise<AnalystToolOutcome> {
  try {
    const result = ctx.configAuthority.loadEffective();
    return toolSucceeded({ config: redactForOutbound({ source: 'config', value: result.config }) });
  } catch (err) {
    return toolFailureFromError(err);
  }
}

async function reconfigure(
  ctx: ToolContext,
  params: ReconfigureParams,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<'none'>> {
  const actionName = `reconfigure.${params.action}`;
  return runAuditedAnalystTool(
    ctx,
    params as ReconfigureParams & Record<string, unknown>,
    {
      action: actionName,
      safety_class: 'low',
      target_kind: 'config',
      getTargetId: () => targetId(params),
      lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
      mutate: (_prepared, input, mutation) => {
        const change = reconfigureMutation(input);
        return mutation.services.config.apply(change);
      },
    },
    signal,
  );
}

function reconfigureMutation(input: ReconfigureParams): ConfigMutation {
  switch (input.action) {
    case 'set_agent_model_route':
      return { kind: 'set_agent_model_route', agent: input.agent, modelRoute: input.model_route };
    case 'set_model_failover':
      return {
        kind: 'set_model_failover',
        forModel: input.for_model,
        orderedFailoverModels: input.ordered_failover_models,
      };
    case 'set_server_setting':
      switch (input.key) {
        case 'port':
          return { kind: 'set_server_setting', key: input.key, value: input.value };
        case 'host':
          return { kind: 'set_server_setting', key: input.key, value: input.value };
      }
  }
}

function targetId(input: ReconfigureParams): string {
  switch (input.action) {
    case 'set_agent_model_route':
      return input.agent;
    case 'set_model_failover':
      return input.for_model;
    case 'set_server_setting':
      return input.key;
  }
}

async function mcp_reconcile(
  ctx: ToolContext,
  _params: Record<string, never> = {},
): Promise<AnalystToolOutcome> {
  return toolFailed('MCP reconciliation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
}

export const analystMiscToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
    defineToolBinder({
      name: 'show_config',
      description: 'Show the current project configuration with secrets redacted.',
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => emptyInput,
      executor: (ctx, args) => executeToolAction('observational_query', () => show_config(ctx, args)),
    }),
    defineToolBinder({
      name: 'reconfigure',
      description:
        'Replace one named-agent model route, model failover chain, or server host/port in the next-start configuration. Every successful mutation requires restart.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => reconfigureParamsSchema,
      executor: (ctx, args, signal) => reconfigure(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'mcp_reconcile',
      description:
        'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => emptyInput,
      executor: (ctx, args) => executeToolAction('none', () => mcp_reconcile(ctx, args)),
    }),
]);
