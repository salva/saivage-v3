const path = require('node:path');
const { jest: canonical } = require('../package.json');

const owners = {
  storage: ['cards', 'persistence', 'workspace'],
  execution: ['agents', 'runtime', 'notifications', 'observability'],
  interfaces: ['application', 'auth', 'boot', 'cli', 'mcp', 'permissions', 'server', 'tools'],
  configuration: ['config', 'contracts', 'schemas', 'quality', 'retrieval'],
  tooling: ['architecture', 'scripts', 'utils'],
};
const { workerGracefulExitTimeout, ...projectOptions } = canonical;
const rootDir = path.resolve(__dirname, '..');

module.exports = {
  rootDir,
  workerGracefulExitTimeout,
  projects: Object.entries(owners).map(([displayName, directories]) => ({
    ...projectOptions,
    rootDir,
    displayName,
    testMatch: [
      ...directories.flatMap((directory) => canonical.testMatch.map(
        (pattern) => `<rootDir>/tests/${directory}/${pattern}`,
      )),
      ...(displayName === 'tooling' ? canonical.testMatch.map(
        (pattern) => `<rootDir>/tests/${pattern.replace(/^\*\*\//, '')}`,
      ) : []),
    ],
  })),
};
