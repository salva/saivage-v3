import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('runtime-state writer lifecycle inventory', () => {
  it('keeps raw persistence delivery-free and confines serving publication to its explicit owner', () => {
    const stateSource = readFileSync(join(process.cwd(), 'src/runtime/state.ts'), 'utf8');
    const mutationSource = readFileSync(join(process.cwd(), 'src/runtime/mutations.ts'), 'utf8');
    const supervisorSource = readFileSync(join(process.cwd(), 'src/runtime/actors/supervisor-runtime-api.ts'), 'utf8');

    expect(stateSource).not.toContain('ReadModelChanges');
    expect(stateSource).not.toContain('runtimeChanged');
    expect(mutationSource.match(/changes\.runtimeChanged\(\)/g)).toHaveLength(1);
    expect(supervisorSource).toContain('this.runtimeState.apply');
    expect(supervisorSource).toContain('this.servingRuntimeState.apply');
  });
});
