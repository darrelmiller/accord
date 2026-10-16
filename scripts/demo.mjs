import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await mkdtemp(path.join(tmpdir(), 'accord-demo-'));
execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
for (const directory of ['examples', 'docs', 'ui']) {
  await cp(new URL(`../${directory}`, import.meta.url), path.join(root, directory), { recursive: true });
}
console.log(`Disposable demo Git workspace (not your source checkout):\n${root}`);
console.log('Start Accord with npm start, open its private launch URL, then enter the path above.');
console.log('Select examples/handbook.html for editing or docs/PRD.html for the canonical product requirements.');
console.log('The demo directory is intentionally retained so saved edits survive companion restarts.');
