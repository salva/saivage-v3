import {
  projectWorkflowPresentation,
  type CompiledRuntimeWorkflows,
} from '../../runtime/runtime-api.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';

export function buildWorkflowOperatorContractHandlers(workflows: CompiledRuntimeWorkflows) {
  return defineOperatorContractHandlers({
    'workflows.presentation': ({ params }) => {
      const workflow = workflows.cardTypes.get(params.cardType);
      return workflow
        ? { body: projectWorkflowPresentation(workflow) }
        : {
            statusCode: 404,
            body: { error: 'workflow_type_not_found', card_type: params.cardType },
          };
    },
  });
}
