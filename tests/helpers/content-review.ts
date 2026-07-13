import { quarantineContent as productionQuarantineContent, recordContentPass as productionRecordContentPass } from '../../src/workspace/quarantine.js';
import type { RiskLevel, SourceKind } from '../../src/schemas/index.js';
import { testAppLogAuthority, testAppLogs } from './app-logs.js';

export function quarantineContent(params: Omit<Parameters<typeof productionQuarantineContent>[0], 'appLogs' | 'mutationAuthority'>) {
  return productionQuarantineContent({ ...params, appLogs: testAppLogs(params.projectRoot), mutationAuthority: testAppLogAuthority(params.projectRoot) });
}

export function recordContentPass(projectRoot: string, sourceKind: SourceKind, sourceRef: string, summary: string, risk: RiskLevel = 'low') {
  return productionRecordContentPass(testAppLogs(projectRoot), testAppLogAuthority(projectRoot), sourceKind, sourceRef, summary, risk);
}
