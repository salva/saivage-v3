export interface FindingDossierCheckError {
  dossier: string;
  kind: string;
  file: string;
  line?: number;
  message: string;
}

export interface FindingDossierResult {
  name: string;
  dir: string;
  checkedFiles: number;
  fixedFindingIds: string[];
  errors: Omit<FindingDossierCheckError, 'dossier'>[];
}

export interface FindingDossierCheckOptions {
  root?: string;
  auditDir?: string | null;
  uiDir?: string | null;
}

export interface FindingDossierCheckResult {
  ok: boolean;
  dossierResults: FindingDossierResult[];
  errors: FindingDossierCheckError[];
  checkedFiles: number;
  fixedFindingIds: string[];
}

export function checkFindingDossiers(options?: FindingDossierCheckOptions): FindingDossierCheckResult;
