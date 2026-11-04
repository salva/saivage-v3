import { fileURLToPath } from 'node:url';
import { CLASSIC_TYPED_TEMPLATE } from '../classic-typed/template.js';

export const NEWLOOP_TEMPLATE = Object.freeze({
  name: 'newloop',
  config: CLASSIC_TYPED_TEMPLATE.config,
  promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)),
});
