import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages, removeReviewRecords } from '../scripts/build-pages.mjs';

test('Pages publishes only selected readable documents and relative assets, without reviews or companion APIs', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'accord-pages-test-'));
  try {
    await buildPages(output);
    const files = [];
    async function list(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await list(path.join(directory, entry.name), relative);
        else files.push(relative);
      }
    }
    await list(output);
    assert.deepEqual(files.sort(), [
      '.nojekyll', 'docs/PRD.html', 'examples/assets/workflow.png', 'examples/handbook.html',
      'examples/notes/decisions.html', 'index.html', 'ui/styles.css'
    ]);
    const handbook = await readFile(path.join(output, 'examples', 'handbook.html'), 'utf8');
    assert.ok(!handbook.includes('review-demo-1'));
    assert.ok(!handbook.includes('application/json'));
    assert.ok(handbook.includes('href="notes/decisions.html#save-contract"'));
    assert.ok(handbook.includes('src="assets/workflow.png"'));
    const prd = await readFile(path.join(output, 'docs', 'PRD.html'), 'utf8');
    assert.ok(prd.includes('Product requirements: Accord'));
    assert.ok(prd.includes('href="../ui/styles.css"'));
    assert.ok((await readFile(path.join(output, 'index.html'), 'utf8')).includes('url=docs/PRD.html'));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('redaction removes inert JSON but preserves unrelated source and standalone theme script', () => {
  const source = '<!doctype html><html><head><script type="application/json">{"private":"review"}</script><script>theme()</script></head><body><p id="stable">Text</p></body></html>';
  assert.equal(removeReviewRecords(source), source.replace('<script type="application/json">{"private":"review"}</script>', ''));
});
