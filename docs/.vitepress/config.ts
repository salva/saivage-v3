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
  title: 'Saivage',
  description:
    'Autonomous Software Development: set an objective, explicitly Run, and follow configured planning, implementation, review and evidenced outcomes.',
  srcExclude: ['working/**'],
  themeConfig: {
    nav: [
      { text: 'Get started', link: '/guides/getting-started' },
      { text: 'How it works', link: '/overview' },
      { text: 'Follow the work', link: '/guides/operating' },
      { text: 'Develop', link: '/guides/development' },
      { text: 'Reference', link: '/reference/' },
    ],
    outline: 'deep',
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Choose a path', link: '/' },
          { text: 'How it works', link: '/overview' },
        ],
      },
      {
        text: 'Work with Saivage',
        items: [
          { text: 'Getting started', link: '/guides/getting-started' },
          { text: 'Configuration', link: '/guides/configuration' },
          { text: 'Follow the work', link: '/guides/operating' },
          { text: 'Developing Saivage', link: '/guides/development' },
        ],
      },
      {
        text: 'Runbook',
        collapsed: true,
        items: [
          { text: 'Choose the safe next task', link: '/runbook/' },
          { text: 'Deployment and startup', link: '/runbook/deployment' },
          { text: 'Runtime control', link: '/runbook/runtime-control' },
          { text: 'Diagnosis', link: '/runbook/diagnosis' },
          { text: 'Inbound and outbound MCP', link: '/runbook/mcp' },
          { text: 'Evidence and provenance', link: '/runbook/evidence' },
          { text: 'Explicit work garbage collection', link: '/runbook/work-gc' },
          { text: 'State adoption, repair and reset', link: '/runbook/state-adoption' },
        ],
      },
      {
        text: 'Exact lookup',
        collapsed: false,
        items: [
          { text: 'Reference map', link: '/reference/' },
          { text: 'Configuration fields', link: '/reference/configuration' },
          { text: 'Agent navigation', link: '/reference/agent-navigation' },
          { text: 'Validation and CI', link: '/validation' },
          { text: 'Brand assets', link: '/brand' },
        ],
      },
      {
        text: 'Specifications',
        collapsed: true,
        items: [
          { text: 'Specification map', link: '/spec/' },
          { text: 'System specification', link: '/spec/system-specification' },
          { text: 'Operator UI needs', link: '/spec/operator-ui-needs' },
          { text: 'Operator UI contracts', link: '/spec/operator-ui-contracts' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: true,
        items: [
          { text: 'Find the owner', link: '/architecture/' },
          { text: 'System architecture', link: '/architecture/system-architecture' },
          { text: 'Durable format changes', link: '/architecture/durable-format-changes' },
          { text: 'Prompt handling', link: '/architecture/prompts' },
        ],
      },
    ],
    search: { provider: 'local' },
  },
});
