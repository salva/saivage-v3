import { z } from 'zod';

export const processIdSchema = z.string().regex(/^proc-[0-9a-f]{12}$/u);
