import { defineConfig } from 'vitepress';

// `docs/working/` is local scratch (gitignored) and must not affect the docs build.
// Exclude it so scratch files never introduce dead links or appear in the built site.
//
// The same source builds for two serving prefixes: every running Saivage
// instance serves the site at /docs/, and GitHub Pages serves it at
// /<owner>.github.io/<repo>/. VitePress resolves asset and page URLs from
// `base`, so each host builds with its own explicit prefix through DOCS_BASE:
// unset (default '/docs/') for local, server, and release builds; set to
// '/<repo>/' by the GitHub Pages CI job.
const base = process.env.DOCS_BASE ?? '/docs/';

export default defineConfig({
  base,
  title: 'Saivage v3',
  description:
    'Autonomous multi-agent runtime for software-development work: card-centered planning, execution, review, and operator control.',
  srcExclude: ['working/**'],
  themeConfig: {
    nav: [
      { text: 'Overview', link: '/overview' },
      { text: 'Specifications', link: '/spec/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Runbook', link: '/runbook/' },
    ],
    sidebar: [
      {
        text: 'Overview',
        items: [{ text: 'What is Saivage', link: '/overview' }],
      },
      {
        text: 'Specifications',
        items: [
          { text: 'System specification', link: '/spec/system-specification' },
          { text: 'Operator UI specification', link: '/spec/operator-ui' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System architecture', link: '/architecture/system-architecture' },
          { text: 'Prompt handling', link: '/architecture/prompts' },
        ],
      },
      {
        text: 'Operations',
        items: [{ text: 'Operator runbook', link: '/runbook/' }],
      },
    ],
    search: { provider: 'local' },
  },
});
