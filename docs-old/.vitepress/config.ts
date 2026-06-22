import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/docs/',
  title: 'Saivage v3',
  description: 'Documentation for Saivage v3 — an autonomous multi-agent system',

  srcExclude: ['raw-llm-conversation-ui-plan.md'],

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Specs', link: '/specifications/' },
      { text: 'Design', link: '/design/' },
      { text: 'Runbook', link: '/runbook/' },
      { text: 'Analyst Guide', link: '/analyst' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Install', link: '/install' },
            { text: 'Configuration', link: '/configuration' },
          ],
        },
        {
          text: 'Functional Specifications',
          items: [
            { text: 'Specifications Index', link: '/specifications/' },
            { text: 'Analyst Control Surface', link: '/specifications/analyst-control-surface' },
          ],
        },
        {
          text: 'Architecture Reference',
          items: [
            { text: 'Agents and Runtime Architecture', link: '/agents' },
            { text: 'Goal Planning Runtime Summary', link: '/goal-planning-runtime' },
            { text: 'Operation Route Inventory', link: '/operation' },
          ],
        },
        {
          text: 'Design',
          items: [
            { text: 'Design Index', link: '/design/' },
            { text: 'Card Model', link: '/design/card-model' },
            { text: 'Card Lifecycle', link: '/design/card-lifecycle' },
            { text: 'Agents', link: '/design/agents' },
            { text: 'Runtime', link: '/design/runtime' },
            { text: 'Security', link: '/design/security' },
            { text: 'Configuration', link: '/design/configuration' },
            { text: 'Skills', link: '/design/skills' },
            { text: 'Server API', link: '/design/server-api' },
            { text: 'Data Model', link: '/design/data-model' },
            { text: 'UX Design', link: '/design/ux-design' },
            { text: 'Terminal Commit Layer', link: '/design/terminal-commit-layer' },
            { text: 'Decisions', link: '/design/decisions' },
            { text: 'Implementation Plan', link: '/design/implementation-plan' },
          ],
        },
        {
          text: 'Operate Saivage',
          items: [
            { text: 'Runbook Index', link: '/runbook/' },
            { text: 'Operations', link: '/runbook/operations' },
            { text: 'Incidents', link: '/runbook/incidents' },
            { text: 'Release', link: '/runbook/release' },
            { text: 'LXC Operations', link: '/runbook/lxc-operations' },
            { text: 'Analyst Operator Guide', link: '/analyst' },
          ],
        },
        {
          text: 'Release and Governance',
          items: [
            { text: 'Legacy Release Forwarder', link: '/release-checklist' },
          ],
        },
        {
          text: 'Provenance',
          items: [
            { text: 'Historical Documentation', link: '/historical/README' },
            { text: '2026 Pre-Consolidation Design', link: '/historical/2026-pre-consolidation/01-card-model' },
            { text: '2026-05 Remediation Dossiers', link: '/historical/2026-05-remediation-dossiers/historical-artifacts' },
          ],
        },
      ],
    },
  },
});
