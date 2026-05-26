// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(__dirname, '../utils/tool-presenters');
const index = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8');
const internal = new Set(['index.ts', 'types.ts', 'registry.ts', 'helpers.ts', 'registrations.ts', '__default__.ts']);

describe('tool presenter barrel integrity', () => {
  it('bare-imports every per-tool registration and imports __default__ last', () => {
    const toolFiles = fs.readdirSync(dir).filter((file) => file.endsWith('.ts') && !internal.has(file)).sort();
    for (const file of toolFiles) expect(index).toContain(`import './${file.replace(/\.ts$/, '')}';`);
    expect(index.match(/import '\.\/__default__';/g)).toHaveLength(1);
    expect(index.indexOf("import './__default__';")).toBeGreaterThan(index.indexOf(`import './${toolFiles.at(-1)!.replace(/\.ts$/, '')}';`));
  });
});
