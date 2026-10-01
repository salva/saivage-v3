import type { z } from 'zod';
import { consumeGrowingRows, readCanonicalBytes } from '../../src/persistence/growing-file.js';

export function readGrowingRows<Row>(path: string, schema: z.ZodType<Row>): Row[] {
  return consumeGrowingRows(path, readCanonicalBytes(path), schema, (rows) => rows);
}
