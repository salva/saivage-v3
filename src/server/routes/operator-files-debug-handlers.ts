import { WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import { EventQueryService } from '../../application/event-query-service.js';
import type { CardService } from '../../cards/card-api.js';
import type { ResolvedConfigAuthority } from '../../config/index.js';
import { projectCompiledGraphs } from '../../runtime/card-process/compiled-graphs-projection.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/card-process/card-process-config.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardServiceProvider: () => CardService; configAuthority: ResolvedConfigAuthority; workflows: CompiledRuntimeWorkflows }) {
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => {
    const cards = options.cardServiceProvider();
    return {
      current: cards.recordReader.current,
      historical: cards.recordReader.historical,
      definition: cards.recordReader.definition,
      definitions: cards.recordReader.definitions,
      getCanonicalCard: (cardId: string) => cards.getCanonicalCard(cardId),
      getCanonicalCardChildren: (cardId: string) => cards.getCanonicalCardChildren(cardId),
      getCanonicalCardFilesMetadata: (cardId: string) => cards.getCanonicalCardFilesMetadata(cardId),
      getCanonicalCardFileContent: (cardId, slot, maximumBytes) => cards.getCanonicalCardFileContent(cardId, slot, maximumBytes),
      readCardVersion: (cardId, version) => cards.readCardVersion(cardId, version),
    };
  }, options.configAuthority);
  const eventQueries = new EventQueryService(options.projectRoot);

  return defineOperatorContractHandlers({
    'files.list': ({ query }) => fileReadModel.listFiles(query.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent(query.path),
    'debug.errors': () => ({ body: eventQueries.queryErrors() }),
    'debug.graphs': () => ({ body: projectCompiledGraphs(options.workflows) }),
    'debug.doctor': ({ request }) => {
      try {
        options.cardServiceProvider().list();
        return {
          body: {
            status: 'ok' as const,
            checks: [{ name: 'cards_loadable' as const, passed: true as const, details: 'Cards loaded successfully.' as const }],
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
            checks: [{ name: 'cards_loadable' as const, passed: false as const, details: 'Cards failed to load.' as const }],
            issues: [{ severity: 'error' as const, message: 'Cards failed to load.' as const }],
          },
        };
      }
    },
  });
}
