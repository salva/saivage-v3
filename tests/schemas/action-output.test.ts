import { describe, expect, it } from '@jest/globals';
import { recordAuthorSchema } from '../../src/schemas/record-author.js';
import { operationIdSchema } from '../../src/schemas/operation-id.js';
import { sha256Hex } from '../../src/schemas/sha256.js';
import { authoredRecordVersionArtifactSchema } from '../../src/persistence/canonical-record-artifacts.js';

const id = '11111111-1111-4111-8111-111111111111';
const content = '\uFEFFliteral report\r\n';
const author = {
  kind: 'action-output', operation: 'shell.run', contract_version: 1,
  provider: { kind: 'builtin', name: 'shell' }, activation_id: id, invocation_id: id,
  node_id: 'check', ordinal: 0, process_id: 'proc-0123456789ab',
  output: { source: 'command-stdout', size_bytes: Buffer.byteLength(content), sha256: sha256Hex(content) },
  outcome: 'failed', leader_exit: { exit_code: 3, signal: null },
};

describe('action output source contract', () => {
  it('accepts qualified identities without permitting shorthand or normalization', () => {
    expect(operationIdSchema.parse('code-quality.typescript.eslint')).toBe('code-quality.typescript.eslint');
    for (const input of ['eslint', 'Code-quality.typescript.eslint', 'x..y', 'x.y.', '.x.y'])
      expect(operationIdSchema.safeParse(input).success).toBe(false);
  });
  it('retains actual shell failure facts and permits returned text without a fabricated process', () => {
    expect(recordAuthorSchema.parse(author)).toEqual(author);
    expect(recordAuthorSchema.parse({
      ...author, operation: 'example.analysis.report', provider: { kind: 'plugin', name: 'example' },
      process_id: null, leader_exit: null, output: { ...author.output, source: 'returned-text' },
      outcome: 'findings',
    })).toMatchObject({ process_id: null, outcome: 'findings' });
    for (const change of [
      { contract_version: 2 },
      { outcome: 'passed' }, { process_id: null },
      { provider: { kind: 'plugin', name: 'example' } },
      { output: { ...author.output, source: 'returned-text' } },
      { leader_exit: { exit_code: 3, signal: 'SIGTERM' } },
      { leader_exit: { exit_code: null, signal: null } },
    ]) expect(recordAuthorSchema.safeParse({ ...author, ...change }).success).toBe(false);
    expect(recordAuthorSchema.safeParse({ ...author, kind: 'shell-stdout' }).success).toBe(false);
  });
  it('binds the output descriptor to the literal accepted body in strict artifact reads', () => {
    const stamp = '2026-10-24T00:00:00.000Z';
    const artifact = {
      format_version: 5, kind: 'accepted-record', card_id: 'project', record_name: 'report.md',
      record_format: 'markdown', schema: 'report', entry_id: id, version: 1,
      published_at: stamp, predecessor: null,
      accepted: {
        source_version: 1, source_entry_id: id, committed_at: stamp, author,
        card_version_seq: 1, card_history: { entry_id: id, version: 1 }, content,
        content_sha256: sha256Hex(content), size_bytes: Buffer.byteLength(content),
      },
    };
    expect(authoredRecordVersionArtifactSchema.parse(artifact).accepted.content).toBe(content);
    const returnedAuthor = {
      ...author, operation: 'example.analysis.report', contract_version: 2,
      provider: { kind: 'plugin', name: 'example' }, process_id: null, leader_exit: null,
      output: { ...author.output, source: 'returned-text' }, outcome: 'findings',
    };
    const returnedArtifact = { ...artifact, accepted: { ...artifact.accepted, author: returnedAuthor } };
    expect(authoredRecordVersionArtifactSchema.parse(JSON.parse(JSON.stringify(returnedArtifact))))
      .toEqual(returnedArtifact);
    for (const contract_version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(recordAuthorSchema.safeParse({ ...returnedAuthor, contract_version }).success).toBe(false);
    expect(authoredRecordVersionArtifactSchema.safeParse({
      ...artifact, accepted: { ...artifact.accepted, author: { ...author, contract_version: 2 } },
    }).success).toBe(false);
    for (const output of [
      { ...author.output, sha256: '0'.repeat(64) },
      { ...author.output, size_bytes: content.length },
    ]) expect(authoredRecordVersionArtifactSchema.safeParse({
      ...artifact, accepted: { ...artifact.accepted, author: { ...author, output } },
    }).success).toBe(false);
  });
});
