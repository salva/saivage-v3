import { quarantineContent as productionQuarantineContent, recordContentPass as productionRecordContentPass } from '../../src/workspace/quarantine.js';
import type { RiskLevel, SourceKind } from '../../src/schemas/index.js';
import { testAppLogs } from './app-logs.js';

export function quarantineContent(params: Omit<Parameters<typeof productionQuarantineContent>[0], 'appLogs'>) {
  return productionQuarantineContent({ ...params, appLogs: testAppLogs(params.projectRoot) });
}

export function recordContentPass(projectRoot: string, sourceKind: SourceKind, sourceRef: string, summary: string, risk: RiskLevel = 'low') {
  return productionRecordContentPass(testAppLogs(projectRoot), sourceKind, sourceRef, summary, risk);
}
