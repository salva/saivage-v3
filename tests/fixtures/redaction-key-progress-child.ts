import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  redactRecordPromptForOutbound,
  redactTextForOutbound,
  redactTextWithStablePrefixesForOutbound,
} from '../../src/redaction/text.js';
import { prepareRecordPromptContent } from '../../src/runtime/records/record-prompt-content.js';

const warmup = [
  'sk-syntheticvalue', JSON.stringify('ghp_syntheticvalue'),
  JSON.stringify('Bearer syntheticvalue'), JSON.stringify('{"api_key":"synthetic"}'),
  JSON.stringify('api_key: synthetic'), JSON.stringify('api_key="one two"'),
  JSON.stringify('\u001bapi_key="one two"'), JSON.stringify('api_key=[REDACTED]'),
  'note=x token=synthetic', JSON.stringify('\\sk-syntheticvalue'),
  JSON.stringify('?token=synthetic&note=x'), JSON.stringify('password=${SYNTHETIC}'),
];
if (process.argv[2] === 'warm')
  for (const input of warmup) redactRecordPromptForOutbound(input);

const start = performance.now();
const n = 32772;
for (const raw of ['e'.repeat(n), 'a0_-'.repeat(n / 4), ' '.repeat(n) + 'e', '\\'.repeat(n)]) {
  assert.equal(redactRecordPromptForOutbound(JSON.stringify(raw)), JSON.stringify(raw));
}
for (const raw of [
  `${'e'.repeat(n)}_api_key=synthetic`,
  `token=synthetic ${'a0_-'.repeat(n / 4)} api_key="one two"`,
  `token=synthetic ${'\\'.repeat(n)} auth=synthetic`,
]) {
  const expected = raw.replace(/=synthetic|="one two"/g, '=[REDACTED]');
  assert.equal(redactRecordPromptForOutbound(JSON.stringify(raw)), JSON.stringify(expected));
}
const mixed = 'a0_-'.repeat(n / 4);
assert.equal(redactTextForOutbound(mixed), mixed);
assert.deepEqual(redactTextWithStablePrefixesForOutbound(mixed), {
  text: mixed, maxPrefixEnd: mixed.length, indivisibleSpans: [],
});
const assignment = `${mixed}note=x`;
assert.deepEqual(redactTextWithStablePrefixesForOutbound(assignment), {
  text: assignment, maxPrefixEnd: assignment.length,
  indivisibleSpans: [{ start: 0, end: assignment.length }],
});
// Hashes retain the complete unchanged baseline framing, not just the visible ends.
for (const [size, hash] of [
  [32768, 'a5a21674a3631af541e22cf375c4671517c59342979bd342afdd00b6b308ba3c'],
  [32769, '8cc679cda14bef0c8c2ab1e348dba52f766dee971b80b0a49274fe18547e5d15'],
] as const) {
  const output = prepareRecordPromptContent('e'.repeat(size), 'record:///status.md?card=project');
  assert.equal(createHash('sha256').update(output).digest('hex'), hash);
}
const elapsedMs = performance.now() - start;
assert.ok(elapsedMs < 5000, `Finite actual-owner group took ${elapsedMs} ms`);
console.log(JSON.stringify({ condition: process.argv[2], elapsedMs }));
