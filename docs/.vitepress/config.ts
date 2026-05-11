import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/docs/',
  title: 'Saivage v3',
  description: 'Documentation for Saivage v3 — an autonomous multi-agent system',

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Install', link: '/install' },
      { text: 'Reference', link: '/configuration' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Install', link: '/install' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/configuration' },
            { text: 'Operation', link: '/operation' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Operator Runbook', link: '/operator-runbook' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
          ],
        },
        {
          text: 'Release',
          items: [
            { text: 'Release Checklist', link: '/release-checklist' },
          ],
        },
      ],
    },
  },
});
