import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function copyInventoryFixture(root) {
  const repo = process.cwd();
  const inputs = ['src', 'scripts', 'docs', 'README.md', 'package.json', 'tsconfig.json', 'web/src'];
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs],
    { cwd: repo, encoding: 'utf8' }).split('\0').filter(path => path && !path.startsWith('docs/working/'));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
}
