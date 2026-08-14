import { describe, expect, it } from '@jest/globals';

import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';
import { AuthoredRecordHistoricalUnavailableError } from '../../src/persistence/authored-record-files.js';

describe('Workspace historical-unavailability responses', () => {
  it('preserves canonical-card and record URI response bodies with classified statuses', () => {
    const records = {
      definition: () => ({}),
      historical: () => { throw new AuthoredRecordHistoricalUnavailableError(3, 'io_error'); },
      readCardVersion: () => ({ kind: 'historical-unavailable' as const, version: 2, reason: 'corrupt' as const }),
    };
    const service = new WorkspaceFileReadModelService('/work', () => records as never, { path: '/config' } as never);
    const cardPath = '.saivage/cards/project/card.json?v=2';
    const recordPath = 'record:///brief.md?card=project&v=3';

    expect(service.readFileContent(cardPath)).toEqual({ statusCode: 409, body: { error: 'workspace_historical_version_unavailable', path: cardPath, historical: { error: 'historical_version_content_unavailable', resource: 'card', owner_id: 'project', version: 2, reason: 'corrupt' } } });
    expect(service.readFileContent(recordPath)).toEqual({ statusCode: 503, body: { error: 'workspace_historical_version_unavailable', path: recordPath, historical: { error: 'historical_version_content_unavailable', resource: 'authored_record', owner_id: 'project/brief.md', version: 3, reason: 'io_error' } } });
  });
});
