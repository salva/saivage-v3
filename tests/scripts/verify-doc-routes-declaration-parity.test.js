import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'scripts');
const JS = readFileSync(join(SCRIPTS, 'verify-doc-routes.js'), 'utf8');
const DTS = readFileSync(join(SCRIPTS, 'verify-doc-routes.d.ts'), 'utf8');

function interfaceBody(name, source) {
  const re = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`);
  const match = source.match(re);
  if (!match) throw new Error(`interface ${name} not declared in .d.ts`);
  return match[1];
}

describe('verify-doc-routes.d.ts declaration parity', () => {
  it('RouteVerificationResult mirrors the verifyDocRoutes return shape', () => {
    const body = interfaceBody('RouteVerificationResult', DTS);
    expect(body).toContain('internalDebugRows: RouteInventoryRow[]');
    expect(body).toContain('routeInventoryRows: RouteInventoryRow[]');
    expect(body).toContain('checkedDocs: string[]');
  });

  it('VerifyDocRoutesOptions declares every option verifyDocRoutes reads', () => {
    const body = interfaceBody('VerifyDocRoutesOptions', DTS);
    expect(body).toContain('internalDebugRows?: RouteInventoryRow[]');
    expect(body).toContain('routeInventoryRows?: RouteInventoryRow[]');
  });

  it('configResult is typed by a config-result interface carrying checkedDocs', () => {
    const match = DTS.match(/configResult:\s*([A-Za-z0-9_]+)/);
    expect(match).not.toBeNull();
    const typeName = match[1];
    expect(typeName).not.toBe('GenericVerificationResult');
    expect(interfaceBody(typeName, DTS)).toContain('checkedDocs: string[]');
  });

  it('every exported function in the .js is declared in the .d.ts', () => {
    const exported = [...JS.matchAll(/^export function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(new RegExp(`export function ${name}\\b`).test(DTS)).toBe(true);
    }
  });

  it('removed runtime-control declarations are absent from the .d.ts', () => {
    for (const token of ['runtimeControlResult', 'verifyRuntimeControlDocs', 'RuntimeControlDocRow', 'RuntimeControlVerificationOptions']) {
      expect(DTS).not.toContain(token);
    }
  });
});
