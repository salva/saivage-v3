import { defineConfig } from 'vitepress';

// `docs/working/` is local scratch (gitignored) and must not affect the docs build.
// Exclude it so scratch files never introduce dead links or appear in the built site.
export default defineConfig({
  srcExclude: ['working/**'],
});
