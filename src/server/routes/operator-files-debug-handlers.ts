import { WorkspaceFileReadModelService } from '../../application/index.js';
import type { CardService } from '../../cards/store-api.js';
import type { ResolvedConfigAuthority } from '../../config/index.js';
import { projectCompiledGraphs } from '../../runtime/runtime-api.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/runtime-api.js';
import {
  defineOperatorContractHandlers,
  type OperatorProjectContext,
} from './operator-handler-context.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';
import { CardExecutionsReadModel } from '../../application/index.js';

export function buildFilesDebugOperatorContractHandlers(
  options: OperatorProjectContext & {
    cardServiceProvider: () => CardService;
    configAuthority: ResolvedConfigAuthority;
    workflows: CompiledRuntimeWorkflows;
  },
) {
  const fileReadModel = new WorkspaceFileReadModelService(
    options.projectRoot,
    options.cardServiceProvider,
    options.configAuthority,
  );

  const executions = new CardExecutionsReadModel(options.projectRoot, fileReadModel);
  return defineOperatorContractHandlers({
    'cards.executions.list': ({ params, query }) =>
      executions.list(params.id, query.after, query.limit),
    'cards.executions.get': ({ params }) => executions.detail(params.id, params.invocationId),
    'cards.executions.file': ({ params }) =>
      executions.file(params.id, params.invocationId, params.fileKey),
    'cards.executions.download': async ({ params, reply }) => {
      const result = await executions.file(params.id, params.invocationId, params.fileKey);
      if (result.statusCode !== 200) return result;
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="execution-output.txt"');
      reply.header('Cache-Control', 'no-store');
      return { body: Buffer.from(result.body.content) };
    },
    'files.list': ({ query }) => fileReadModel.listFiles(query.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent(query.path),
    'files.image': async ({ query, reply }) => {
      const result = await fileReadModel.readFileImage(query.path);
      if (result.mime) reply.header('Content-Type', result.mime);
      return result;
    },
    'debug.graphs': () => ({ body: projectCompiledGraphs(options.workflows) }),
    'debug.doctor': ({ request }) => {
      try {
        options.cardServiceProvider().list();
        return {
          body: {
            status: 'ok' as const,
            checks: [
              {
                name: 'cards_loadable' as const,
                passed: true as const,
                details: 'Cards loaded successfully.' as const,
              },
            ],
            issues: [],
          },
        };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        request.log.error(
          { operation: 'debug.doctor', failureCode: 'cards_load_failed' },
          'Operator Doctor card check failed',
        );
        return {
          body: {
            status: 'issues_found' as const,
            checks: [
              {
                name: 'cards_loadable' as const,
                passed: false as const,
                details: 'Cards failed to load.' as const,
              },
            ],
            issues: [{ severity: 'error' as const, message: 'Cards failed to load.' as const }],
          },
        };
      }
    },
  });
}
