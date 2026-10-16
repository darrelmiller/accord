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
