import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/docs/',
  title: 'Saivage v3',
  description: 'Documentation for Saivage v3 — an autonomous multi-agent system',

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Runbook', link: '/operator-runbook' },
      { text: 'Analyst Guide', link: '/analyst' },
      { text: 'Docs Policy', link: '/documentation-inventory' },
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
          text: 'Operate Saivage',
          items: [
            { text: 'Operator Runbook', link: '/operator-runbook' },
            { text: 'Analyst Operator Guide', link: '/analyst' },
            { text: 'Operation Guide', link: '/operation' },
            { text: 'Goal Planning Runtime', link: '/goal-planning-runtime' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
          ],
        },
        {
          text: 'Release and Governance',
          items: [
            { text: 'Release Checklist', link: '/release-checklist' },
            { text: 'Documentation Inventory', link: '/documentation-inventory' },
            { text: 'Historical Artifacts', link: '/historical-artifacts' },
          ],
        },
      ],
    },
  },
});
