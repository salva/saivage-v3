import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createResolvedConfigAuthority, formatConfigWarning } from './config/index.js';
import {
  inspectRepairTarget,
  parseRepairTarget,
  replaceFile,
  resetOwnedGeneratedRoots,
  saivageLocksRoot,
  saivageRoot,
} from './persistence/index.js';
import { acquireRuntimeLifecycleLock, releaseRuntimeLifecycleLock } from './runtime/runtime-api.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from './contracts/index.js';

export interface RepairInputs {
  readonly target: string;
  readonly backup: string;
  readonly report: string;
  readonly discardCard?: boolean;
  readonly cardType?: string;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export async function handleRepair(
  inputs: RepairInputs,
  fatal: ApplicationFatalPort,
): Promise<void> {
  const target = parseRepairTarget(inputs.target);
  if (!isAbsolute(inputs.backup) || !isAbsolute(inputs.report))
    throw new Error('Repair backup and report paths must be absolute and outside generated state.');
  if (!process.stdin.isTTY)
    throw new Error(
      'Repair requires interactive typed backup acknowledgement and action consent; no unattended mode.',
    );
  const root = realpathSync(process.cwd());
  const generatedRoots = [
    ...resetOwnedGeneratedRoots(root),
    saivageLocksRoot(root),
    resolve(saivageRoot(root), 'repair-attic'),
  ];
  const resolvedGeneratedRoots = generatedRoots.map((path) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
      throw error;
    }
  });
  const backupPath = resolve(inputs.backup);
  const reportPath = resolve(inputs.report);
  const backup = realpathSync(inputs.backup);
  statSync(backup);
  const report = resolve(realpathSync(dirname(inputs.report)), inputs.report.split(sep).at(-1)!);
  if (
    generatedRoots.some((path) => within(path, backupPath) || within(path, reportPath)) ||
    resolvedGeneratedRoots.some((path) => within(path, backup) || within(path, report)) ||
    within(backupPath, reportPath) ||
    within(backup, report)
  )
    throw new Error(
      'Backup and report must be outside generated/lifecycle roots; report must also be outside the declared backup.',
    );
  try {
    lstatSync(report);
    throw new Error('Repair report must be a fresh absent file outside generated state.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Existing bound acquisition refuses every pre-existing canonical lock and publishes null control.
  let lock: ReturnType<typeof acquireRuntimeLifecycleLock>;
  try {
    lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) fatal.publicationOutcomeUnknown(error);
    throw error;
  }
  let prompt: ReturnType<typeof createInterface> | undefined;
  try {
    const authority = createResolvedConfigAuthority({
      path: resolve(root, '.saivage', 'saivage.yaml'),
      interpolationEnvironment: process.env,
      projectRoot: root,
    });
    const effective = authority.loadEffective();
    for (const warning of effective.warnings) console.error(formatConfigWarning(warning));
    prompt = createInterface({ input: process.stdin, output: process.stdout });
    const acknowledgement = `BACKUP COMPLETE ${inputs.target}`;
    console.log(
      `Exact project: ${JSON.stringify(root)}; declared backup: ${JSON.stringify(backup)}`,
    );
    console.log(
      'Verify the exact project service is stopped, restarts disabled and no owning process remains. The complete fresh stopped-project backup must have succeeded, remain unchanged, and the service must have stayed stopped. Path existence is not backup verification.',
    );
    if (
      (await prompt.question(
        `Type ${acknowledgement} to acknowledge those facts before inspection: `,
      )) !== acknowledgement
    )
      throw new Error('Backup acknowledgement refused; no repair inspection or effects.');
    const decision = inspectRepairTarget(root, effective.workflows, target, {
      discardCard: inputs.discardCard,
      cardType: inputs.cardType,
    });
    const lines = [
      '# Exact-target repair report',
      `Project: ${JSON.stringify(root)}`,
      `Backup path: ${JSON.stringify(backup)}`,
      `Target: ${inputs.target}`,
      'Backup: operator acknowledged a complete fresh preserved stopped-project backup; existence alone was not verified as completeness.',
      'No replay, semantic closings, provider invocation, automatic restart or lossless recovery is promised.',
      ...decision.summary,
      ...decision.steps.map((step, index) => `Proposed ${index + 1}: ${step.description}`),
    ];
    const publishReport = () => replaceFile(report, Buffer.from(`${lines.join('\n')}\n`));
    // Reports are external advisory files, not Saivage selectors or persisted continuation plans.
    publishReport();
    for (const line of lines) console.log(line);
    if (decision.steps.length > 0) {
      const consent = `REPAIR ${inputs.target}`;
      if (
        (await prompt.question(`Type ${consent} to consent to exactly these effects: `)) !== consent
      )
        throw new Error('Repair consent refused; inspected canonical bytes unchanged.');
      if (
        inputs.discardCard &&
        (await prompt.question(
          `Type DISCARD CARD ${inputs.target} to separately confirm total own-data and descendant-reachability loss: `,
        )) !== `DISCARD CARD ${inputs.target}`
      )
        throw new Error('Destructive discard consent refused; no repair effects.');
      decision.recheck();
      for (const step of decision.steps) {
        step.apply();
        lines.push(`Completed: ${step.description}`);
        publishReport();
      }
      decision.validate();
      lines.push(
        'Exact repaired owner validated. Restart separately; another independent error may still block startup.',
      );
      publishReport();
    }
  } catch (error) {
    // Never release descriptors/lock, update reports or log after publication uncertainty.
    if (error instanceof PublicationOutcomeUnknownError) fatal.publicationOutcomeUnknown(error);
    prompt?.close();
    releaseRuntimeLifecycleLock(lock);
    // Corrupt bytes and schema diagnostics must not escape through operator output.
    throw new Error(
      'Repair stopped without further effects. Check the external report for known completed steps; correct the exact unsupported condition before a separate attempt.',
    );
  }
  prompt?.close();
  try {
    releaseRuntimeLifecycleLock(lock);
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) fatal.publicationOutcomeUnknown(error);
    throw error;
  }
}
