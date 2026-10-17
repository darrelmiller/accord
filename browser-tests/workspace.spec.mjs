import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCompanion } from '../dist/server/http.js';

let companion;
let root;
const recoveryDirectories = new Set();

test.beforeAll(async () => { companion = await startCompanion(); });
test.afterAll(async () => {
  await new Promise((resolve, reject) => companion.server.close(error => error ? reject(error) : resolve()));
  for (const directory of recoveryDirectories) await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  root = await mkdtemp(path.join(tmpdir(), 'accord-browser-test-'));
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  for (const directory of ['examples', 'docs', 'ui']) {
    await cp(new URL(`../${directory}`, import.meta.url), path.join(root, directory), { recursive: true });
  }
  await page.goto(`${companion.origin}/#token=${companion.token}`);
  await page.getByLabel('Existing Git repository root').fill(root);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'examples/handbook.html', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const message = await page.locator('#message').textContent();
  const recovery = message?.split('Previous bytes are recoverable at: ')[1];
  if (recovery) recoveryDirectories.add(path.dirname(recovery));
  await page.close();
  await rm(root, { recursive: true, force: true });
});

async function handbook(page) {
  await page.getByRole('button', { name: 'examples/handbook.html', exact: true }).click();
  const frame = page.frameLocator('#document-frame');
  await expect(frame.locator('h1')).toHaveText('A local-first handbook');
  return frame;
}

test('visual heading/table edit, dynamic hierarchical TOC, real save, preserved source and isolation', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const original = await readFile(path.join(root, 'examples', 'handbook.html'), 'utf8');
  const frame = await handbook(page);
  await expect(frame.locator('img')).toHaveJSProperty('naturalWidth', 720);
  expect(await page.locator('#document-frame').getAttribute('sandbox')).toBe('allow-same-origin');
  expect(await frame.locator('script,style,iframe,form').count()).toBe(0);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await frame.locator('#try-it > [data-accord-text]').fill('2. Human-edited heading');
  await frame.locator('#available > [data-accord-text]').fill('Edited table cell');
  await expect(page.locator('#toc')).toContainText('2. Human-edited heading');
  await expect(page.locator('#toc > ul > li > ul')).toHaveCount(1);
  await expect(page.locator('#save-state')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Saved locally.');
  const message = await page.locator('#message').textContent();
  recoveryDirectories.add(path.dirname(message.split('Previous bytes are recoverable at: ')[1]));
  const saved = await readFile(path.join(root, 'examples', 'handbook.html'), 'utf8');
  expect(saved).toBe(original.replace('2. Try a real edit', '2. Human-edited heading').replace('Available locally', 'Edited table cell'));
  expect(saved).not.toContain('data-accord-text');
  expect(await frame.locator('#try-it').getAttribute('id')).toBe('try-it');
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText('On disk · local working draft');
  await expect(frame.locator('#try-it')).toHaveText('2. Human-edited heading');
  await expect(frame.locator('h1')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('native undo, plain-text paste, and request-time editing freeze preserve the supported profile', async ({ page, context }) => {
  const frame = await handbook(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  const heading = frame.locator('#try-it > [data-accord-text]');
  await heading.click();
  await heading.press('End');
  await page.keyboard.type(' revised');
  await expect(heading).toHaveText('2. Try a real edit revised');
  await heading.press('ControlOrMeta+z');
  await expect(heading).toHaveText('2. Try a real edit');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('<b>Plain pasted text</b>'));
  await heading.press('ControlOrMeta+a');
  await heading.press('ControlOrMeta+v');
  await expect(heading).toHaveText('<b>Plain pasted text</b>');
  await expect(heading.locator('b')).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText('First line\nSecond line'));
  await heading.press('ControlOrMeta+v');
  await expect(page.locator('#message')).toContainText('Multi-line paste');
  await expect(heading).toHaveText('<b>Plain pasted text</b>');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/save', async route => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await expect(heading).toHaveAttribute('contenteditable', 'false');
  release();
  await expect(page.locator('#message')).toContainText('Saved locally.');
  expect(await readFile(path.join(root, 'examples', 'handbook.html'), 'utf8')).toContain('&lt;b&gt;Plain pasted text&lt;/b&gt;');
});

test('relative document links and unsaved navigation guard work across the iframe boundary', async ({ page }) => {
  const frame = await handbook(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await frame.locator('#category > [data-accord-text]').fill('UNSAVED LOCAL CHANGE');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await frame.getByRole('link', { name: 'save contract', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(frame.locator('#category')).toHaveText('UNSAVED LOCAL CHANGE');
  await frame.getByRole('link', { name: 'save contract', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('Companion notes');
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText('Save contract');
  await frame.getByRole('link', { name: 'handbook editing exercise', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('A local-first handbook');
  await expect(frame.locator('#category')).not.toHaveText('UNSAVED LOCAL CHANGE');
});

test('stale save keeps the draft; explicit discard/reload is required; unsupported HTML remains inert', async ({ page }) => {
  const frame = await handbook(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await frame.locator('#category > [data-accord-text]').fill('Browser draft');
  const filename = path.join(root, 'examples', 'handbook.html');
  const original = await readFile(filename, 'utf8');
  await writeFile(filename, original.replace('ACCORD FIELD NOTES', 'AGENT FIELD NOTES'));
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Disk content changed');
  await expect(frame.locator('#category')).toHaveText('Browser draft');
  await expect(page.locator('#save-state')).toContainText('Unsaved');
  expect(await readFile(filename, 'utf8')).toContain('AGENT FIELD NOTES');
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(frame.locator('#category')).toContainText('AGENT FIELD NOTES');
  await page.getByRole('button', { name: 'examples/unsupported.html', exact: true }).click();
  await expect(page.locator('#warnings')).toContainText('READ-ONLY');
  await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toBeDisabled();
  await expect(frame.locator('script,custom-review-widget')).toHaveCount(0);
  expect(await frame.locator('body').getAttribute('data-executed')).toBeNull();
});

test('canonical semantic HTML PRD is editable dogfood with explicit Open issues and retained implementation distinction', async ({ page }) => {
  await page.getByRole('button', { name: 'docs/PRD.html', exact: true }).click();
  const frame = page.frameLocator('#document-frame');
  await expect(frame.locator('h1')).toHaveText('Product requirements: Accord');
  await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled();
  await expect(frame.locator('h3').filter({ hasText: /^OI-\d\d:/ })).toHaveCount(11);
  await expect(frame.locator('h2').filter({ hasText: '14. What belongs outside this PRD' })).toHaveCount(1);
  await expect(frame.locator('body')).toContainText('trusted baseline');
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await frame.locator('h1 > [data-accord-text]').fill('Product requirements: Accord dogfood');
  await expect(page.locator('#toc')).toContainText('Product requirements: Accord dogfood');
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Saved locally.');
  expect(await readFile(path.join(root, 'docs', 'PRD.html'), 'utf8')).toContain('Product requirements: Accord dogfood');
});

test('theme, text size, path filtering and section navigation remain application-only preferences', async ({ page }, testInfo) => {
  const frame = await handbook(page);
  const filename = path.join(root, 'examples', 'handbook.html');
  const before = await readFile(filename);
  await page.getByRole('button', { name: 'Switch theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Text size', { exact: true }).fill('22');
  await expect(frame.locator('body')).toHaveCSS('font-size', '22px');
  await page.getByLabel('Filter documents by path', { exact: true }).fill('notes/');
  await expect(page.locator('#documents button')).toHaveCount(1);
  await page.locator('#toc a').filter({ hasText: '2. Try a real edit' }).click();
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText('2. Try a real edit');
  expect(await readFile(filename)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('dark-workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 520, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function reviewHandbook(page) {
  const frame = await handbook(page);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#review-panel')).toBeVisible();
  await expect(page.locator('#review-threads')).toContainText('No comments yet');
  await page.getByLabel('Your display name (unverified)', { exact: true }).fill('Local reviewer');
  return frame;
}

test('reviewing saves anchored sidecar threads, replies and resolution without changing HTML', async ({ page }, testInfo) => {
  const filename = path.join(root, 'examples', 'handbook.html');
  const before = await readFile(filename);
  const frame = await reviewHandbook(page);
  await frame.locator('#open-format').click();
  await expect(page.locator('#comment-target')).toHaveText('Passage in #open-format');
  await page.getByLabel('New comment', { exact: true }).fill('Can we clarify the source-preservation guarantee? <script>not code</script>');
  await page.getByRole('button', { name: 'Save comment locally', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('source-preservation guarantee? <script>not code</script>');
  await expect(page.locator('#review-threads script')).toHaveCount(0);
  await expect(page.locator('#review-count')).toHaveText('(1 open)');
  await expect(frame.locator('#open-format')).toHaveAttribute('data-accord-anchored', '');
  await expect(frame.locator('#open-format > span')).toHaveAttribute('contenteditable', 'false');
  let sidecar = JSON.parse(await readFile(`${filename}.accord-review.json`, 'utf8'));
  expect(sidecar.schemaVersion).toBe(1);
  expect(sidecar.document).toBe('examples/handbook.html');
  expect(sidecar.threads[0].anchor.blockId).toBe('open-format');
  expect(sidecar.threads[0].anchor.documentVersion).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Your reply', { exact: true }).fill('Yes. Only source text ranges are replaced.');
  await page.getByRole('button', { name: 'Save reply locally', exact: true }).click();
  await expect(page.locator('#review-threads .reply')).toContainText('Only source text ranges');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('#review-count')).toHaveText('(0 open)');
  await page.getByLabel('Show resolved threads', { exact: true }).uncheck();
  await expect(page.locator('#review-threads')).toContainText('Resolved threads are hidden');
  await page.getByLabel('Show resolved threads', { exact: true }).check();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.locator('#review-count')).toHaveText('(1 open)');
  await page.getByRole('button', { name: 'Refresh comments', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('Only source text ranges');
  sidecar = JSON.parse(await readFile(`${filename}.accord-review.json`, 'utf8'));
  expect(sidecar.threads[0].status).toBe('open');
  expect(sidecar.threads[0].replies).toHaveLength(1);
  expect(await readFile(filename)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('review-workspace.png'), fullPage: true });
});

test('review passage selection and unsaved comment navigation support save-and-continue', async ({ page }) => {
  const frame = await reviewHandbook(page);
  const text = frame.locator('#open-format > [data-accord-text]');
  await text.evaluate(node => {
    const range = node.ownerDocument.createRange();
    range.setStart(node.firstChild, 0);
    range.setEnd(node.firstChild, 8);
    const selection = node.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator('#comment-quote')).toHaveText('The file');
  await page.getByLabel('New comment', { exact: true }).fill('A selected passage comment');
  await page.getByRole('button', { name: 'examples/notes/decisions.html', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('New comment', { exact: true })).toHaveValue('A selected passage comment');
  await page.getByRole('button', { name: 'examples/notes/decisions.html', exact: true }).click();
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('Companion notes');
  const sidecar = JSON.parse(await readFile(path.join(root, 'examples', 'handbook.html.accord-review.json'), 'utf8'));
  expect(sidecar.threads[0].anchor.quote).toBe('The file');
  await page.getByRole('button', { name: 'examples/handbook.html', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('A selected passage comment');
});

test('changed sidecar retains draft until refresh; changed document rejects new anchors and marks stale saved threads', async ({ page }) => {
  const filename = path.join(root, 'examples', 'handbook.html');
  const frame = await reviewHandbook(page);
  await frame.locator('#open-format').click();
  await page.getByLabel('New comment', { exact: true }).fill('First comment');
  await page.getByRole('button', { name: 'Save comment locally', exact: true }).click();
  await expect(page.locator('#review-count')).toHaveText('(1 open)');
  const sidecarName = `${filename}.accord-review.json`;
  const other = JSON.parse(await readFile(sidecarName, 'utf8'));
  other.threads[0].body = 'Changed in another tab';
  await writeFile(sidecarName, JSON.stringify(other));
  await page.getByLabel('New comment', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Save comment locally', exact: true }).click();
  await expect(page.locator('#message')).toHaveClass('error');
  await expect(page.getByLabel('New comment', { exact: true })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Refresh comments', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('Changed in another tab');
  await expect(page.getByLabel('New comment', { exact: true })).toHaveValue('Keep this draft');
  const original = await readFile(filename, 'utf8');
  await writeFile(filename, original.replace('The file on disk is the document.', 'Disk changed under review.'));
  await page.getByRole('button', { name: 'Save comment locally', exact: true }).click();
  await expect(page.locator('#message')).toHaveClass('error');
  await expect(page.getByLabel('New comment', { exact: true })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('Stale');
  await expect(page.getByRole('button', { name: 'Go to passage', exact: true })).toHaveCount(0);
  expect(JSON.parse(await readFile(sidecarName, 'utf8')).threads).toHaveLength(1);
});

test('whole-document comments work on read-only previews and malformed sidecars fail visibly', async ({ page }) => {
  await handbook(page);
  await page.getByRole('button', { name: 'examples/unsupported.html', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('No comments yet');
  await page.getByLabel('Your display name (unverified)', { exact: true }).fill('Reader');
  await page.getByLabel('New comment', { exact: true }).fill('The custom content needs a source-editor review.');
  await page.getByRole('button', { name: 'Save comment locally', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('Whole document');
  const filename = path.join(root, 'examples', 'unsupported.html.accord-review.json');
  await writeFile(filename, '{"schemaVersion":999,"keep":"do not replace"}');
  await page.getByRole('button', { name: 'Refresh comments', exact: true }).click();
  await expect(page.locator('#review-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save comment locally', exact: true })).toBeDisabled();
  expect(await readFile(filename, 'utf8')).toBe('{"schemaVersion":999,"keep":"do not replace"}');
});

test('review transition settles unsaved HTML and keyboard anchors; leaving a review draft requires consent', async ({ page }) => {
  const frame = await handbook(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await frame.locator('#category > span').fill('Saved before reviewing');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.locator('#review-threads')).toContainText('No comments yet');
  await expect(frame.locator('#category')).toHaveText('Saved before reviewing');
  await frame.locator('#open-format').press('Enter');
  await expect(page.getByLabel('New comment', { exact: true })).toBeFocused();
  await expect(page.locator('#comment-target')).toHaveText('Passage in #open-format');
  await page.getByLabel('New comment', { exact: true }).fill('A draft not yet saved');
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.locator('#review-panel')).toBeVisible();
  await expect(page.getByLabel('New comment', { exact: true })).toHaveValue('A draft not yet saved');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('#review-panel')).toBeHidden();
  await expect(frame.locator('#open-format')).not.toHaveAttribute('tabindex', '0');
});
