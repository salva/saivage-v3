import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  compileMcpArgumentValidator,
  fingerprintMcpInputSchema,
  validateMcpArguments,
} from '../../src/mcp/mcp-argument-validator.js';

// Exact discovery from the pinned official package/engine, not a handwritten reduced schema.
// @playwright/mcp 0.0.83, playwright-core 1.64.0-alpha-1790635538000.
const screenshot = JSON.parse(readFileSync(new URL('../fixtures/mcp/playwright-0.0.83-screenshot.json', import.meta.url), 'utf8'));

describe('MCP external JSON Schema languages', () => {
  it('compiles the unchanged official screenshot schema without adding defaults or coercing arguments', () => {
    const schema = JSON.parse(JSON.stringify(screenshot.inputSchema));
    const compiled = compileMcpArgumentValidator(schema);
    expect(compiled.ok).toBe(true);
    for (const [args, ok] of [
      [{ scale: 'css', type: 'png' }, true],
      [{}, false],
      [{ scale: 'invalid' }, false],
      [{ scale: 'css', fullPage: 'true' }, false],
      [{ scale: 'css', extra: true }, false],
    ] as const) {
      const before = structuredClone(args);
      expect(validateMcpArguments(compiled, args).ok).toBe(ok);
      expect(args).toEqual(before);
    }
    expect(schema).toEqual(screenshot.inputSchema);
  });

  it.each([undefined, 'https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#'])(
    'uses 2020-12 semantics for declaration %s, with local references and boolean subschemas', ($schema) => {
      const schema = {
        ...($schema === undefined ? {} : { $schema }),
        type: 'object',
        $defs: { tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false } },
        allOf: [{ properties: { tuple: { $ref: '#/$defs/tuple' }, permitted: true, forbidden: false } }],
        required: ['tuple'],
        unevaluatedProperties: false,
        'x-external-annotation': { retained: true },
      };
      const before = structuredClone(schema);
      const compiled = compileMcpArgumentValidator(schema);
      expect(compiled.ok).toBe(true);
      expect(validateMcpArguments(compiled, { tuple: ['one', 2], permitted: null })).toEqual({ ok: true });
      for (const args of [{ tuple: [1, 2] }, { tuple: ['one', 2, 3] }, { tuple: [], extra: true }, { tuple: [], forbidden: true }]) {
        expect(validateMcpArguments(compiled, args).ok).toBe(false);
      }
      expect(schema).toEqual(before);
    },
  );

  it.each(['http://json-schema.org/draft-07/schema', 'http://json-schema.org/draft-07/schema#'])(
    'preserves explicitly declared draft-07 tuple semantics for %s', ($schema) => {
      const compiled = compileMcpArgumentValidator({
        $schema, type: 'object', properties: { tuple: { type: 'array', items: [{ type: 'string' }], additionalItems: false } },
      });
      expect(compiled.ok).toBe(true);
      expect(validateMcpArguments(compiled, { tuple: ['one'] })).toEqual({ ok: true });
      expect(validateMcpArguments(compiled, { tuple: [1] }).ok).toBe(false);
      expect(validateMcpArguments(compiled, { tuple: ['one', 'two'] }).ok).toBe(false);
    },
  );

  it('does not guess draft-07 for a dialect-less tuple schema', () => {
    expect(compileMcpArgumentValidator({ type: 'object', properties: { tuple: { items: [{ type: 'string' }] } } })).toMatchObject({ ok: false, type: 'schema_compile_error' });
  });

  it.each(['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft-07/schema', 'other'.repeat(300), null, 7, {}])(
    'rejects unsupported/malformed declaration %j before compilation with bounded diagnostics', ($schema) => {
      const result = compileMcpArgumentValidator({ $schema, type: 'object' });
      expect(result).toMatchObject({ ok: false, type: 'schema_unsupported' });
      expect(JSON.stringify(result).length).toBeLessThan(350);
    },
  );

  it.each([
    { type: 'object', required: 'invalid' },
    { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema' } } },
    { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } },
  ])('fails invalid schemas/unresolved references without fallback or loading: %j', (schema) => {
    const result = compileMcpArgumentValidator(schema);
    expect(result).toMatchObject({ ok: false, type: 'schema_compile_error' });
    expect(JSON.stringify(result).length).toBeLessThan(350);
  });

  it('keeps whole-schema stable fingerprints including dialect and arbitrary annotation changes', () => {
    const a = { type: 'object', properties: { allowed: true }, 'x-extra': { a: 1, b: 2 } };
    const reordered = { 'x-extra': { b: 2, a: 1 }, properties: { allowed: true }, type: 'object' };
    expect(fingerprintMcpInputSchema(a)).toBe(fingerprintMcpInputSchema(reordered));
    expect(compileMcpArgumentValidator(a).fingerprint).toBe(fingerprintMcpInputSchema(a));
    expect(fingerprintMcpInputSchema({ ...a, $schema: 'https://json-schema.org/draft/2020-12/schema' })).not.toBe(fingerprintMcpInputSchema(a));
    expect(fingerprintMcpInputSchema({ ...a, 'x-extra': { a: 2, b: 2 } })).not.toBe(fingerprintMcpInputSchema(a));
  });
});
