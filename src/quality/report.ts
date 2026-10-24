import { z } from 'zod';
import { qualityHelperResultSchema } from './helper-contract.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { buildScopedPathUrl } from '../contracts/index.js';

/** The full normalized/native artifacts remain authoritative when this view omits rows. */
export function renderQualityReport(args: {
  operation: string;
  invocation: string;
  outcome: string;
  result: z.infer<typeof qualityHelperResultSchema>;
  files: readonly string[];
  skipped: readonly { path: string; reason: string }[];
  artifactRoot: string;
}) {
  const findings = args.result.findings;
  const link = (file: string) =>
    `[${file}](${buildScopedPathUrl('work', ['quality', args.invocation, file])})`;
  const counts = {
    errors: findings.filter((item) => item.severity === 'error').length,
    warnings: findings.filter((item) => item.severity === 'warning').length,
    info: findings.filter((item) => item.severity === 'info').length,
  };
  const header = [
    `# ${args.operation} — ${args.outcome}`,
    '',
    `Invocation: ${args.invocation}. Contract:1. This is analysis evidence, not product acceptance.`,
    `Findings: ${findings.length}; errors:${counts.errors}; warnings:${counts.warnings}; info:${counts.info}.`,
    `Selected source files:${args.files.length}; retained coverage rows:${args.result.coverage.length}; scope exclusions/skips:${args.skipped.length}.`,
    `Native disposition: ${args.result.native_exit ?? 'not established'}.`,
    args.result.diagnostic ?? '',
    'Full mutable work artifacts (may change/disappear; not immutable accepted history):',
    ...['native.json', 'findings.json', 'metadata.json'].map(
      (file) => `- ${link(file)} (${args.artifactRoot}/${file})`,
    ),
    '',
    '## Findings (bounded view)',
  ];
  const rows: string[] = [];
  let bytes = 0;
  for (const finding of findings) {
    const row = redactTextForOutbound(
      `- ${finding.severity} ${finding.file}:${finding.start?.line ?? '?'}:${finding.start?.column ?? '?'} ${finding.rule ?? '(native)'} — ${finding.message}`,
    );
    if (bytes + Buffer.byteLength(row) > 24000) break;
    rows.push(row);
    bytes += Buffer.byteLength(row);
  }
  const footer = [
    '',
    `Shown findings:${rows.length}; omitted findings:${findings.length - rows.length}. Full details, ranges and native suggestions are in the linked artifacts.`,
    '## Coverage and attribution limits',
    ...args.result.limitations.map((text) => `- ${text}`),
    '- Source/config observations are not frozen. Git HEAD does not identify dirty/untracked bytes.',
    '- Native configuration dependency closure is not certified hermetic.',
    '- Configured exclusions, skipped paths and complete typed-rule observations are retained in metadata.json.',
  ];
  // Metadata/diagnostics can also be large; cap the display without pretending it is complete.
  const text = redactTextForOutbound([...header, ...rows, ...footer].join('\n'));
  if (Buffer.byteLength(text) <= 48000) return `${text}\n`;
  return `${redactTextForOutbound(header.slice(0, 6).join('\n'))}\n\nReport details omitted because display metadata exceeded48000 bytes. Full findings:${findings.length}; omitted from this view:${findings.length}.\nFull mutable artifacts: ${link('native.json')}, ${link('findings.json')}, ${link('metadata.json')}\nNot product acceptance; coverage and attribution limitations remain in metadata.json.\n`;
}
