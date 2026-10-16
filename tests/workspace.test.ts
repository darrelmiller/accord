import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { Workspace } from '../server/workspace.js';
import { startCompanion } from '../server/http.js';
import type { DocumentView, WorkspaceInfo } from '../shared/model.js';

const exec = promisify(execFile);
const source = '<!doctype html><html><head><title>Fixture</title><script type="application/json">{"review":"unchanged"}</script></head><body><h1 id="title">Fixture</h1><p id="paragraph">Original text</p><table><tbody><tr><td id="cell">Original cell</td></tr></tbody></table><a href="other.html#other">Other</a><img src="assets/pixel.png" alt="pixel"></body></html>';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'accord-test-'));
  await exec('git', ['init', '--quiet', root]);
  await mkdir(path.join(root, 'assets'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'main.html'), source);
  await writeFile(path.join(root, 'other.html'), source.replace('id="title"', 'id="other"'));
  await writeFile(path.join(root, 'code.ts'), 'export const doNotChange = true;\n');
  await writeFile(path.join(root, '.private.html'), 'secret');
  await writeFile(path.join(root, 'node_modules', 'hidden.html'), 'excluded');
  await writeFile(path.join(root, 'assets', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i0AAAAASUVORK5CYII=', 'base64'));
  return root;
}

function edit(view: DocumentView, before: string, after: string) {
  const entry = Object.entries(view.text).find(([, value]) => value === before);
  assert.ok(entry);
  return { id: entry[0], text: after };
}

test('mixed repository: open/edit/save/reopen, real relative image, recovery, and Git state untouched', async () => {
  const root = await fixture();
  let backupDirectory: string | undefined;
  try {
    await exec('git', ['-C', root, 'add', '--', 'main.html', 'other.html', 'code.ts', 'assets/pixel.png']);
    await exec('git', ['-C', root, '-c', `core.hooksPath=${path.join(root, '.git', 'no-hooks')}`, '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Accord fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Temporary fixture']);
    await writeFile(path.join(root, 'code.ts'), 'export const doNotChange = false;\n');
    await exec('git', ['-C', root, 'add', '--', 'code.ts']);
    const unrelatedCode = 'export const doNotChange = false;\n// Unstaged user code edit\n';
    await writeFile(path.join(root, 'code.ts'), unrelatedCode);
    const indexBefore = await readFile(path.join(root, '.git', 'index'));
    const revisionBefore = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout;
    const gitBefore = await readFile(path.join(root, '.git', 'HEAD'));
    const statusBefore = (await exec('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1'])).stdout;
    const workspace = await Workspace.open(root);
    assert.deepEqual(workspace.info.documents, ['main.html', 'other.html']);
    const view = await workspace.load('main.html');
    assert.equal(view.editable, true);
    assert.ok(view.html.includes('src="data:image/png;base64,'));
    const saved = await workspace.save({ path: view.path, version: view.version, edits: [
      edit(view, 'Original text', 'Human edited <text>'), edit(view, 'Original cell', 'Updated cell')
    ] });
    assert.ok(saved.recovery);
    backupDirectory = path.dirname(saved.recovery);
    assert.equal(await readFile(saved.recovery, 'utf8'), source);
    const reopened = await (await Workspace.open(root)).load('main.html');
    assert.ok(Object.values(reopened.text).includes('Human edited <text>'));
    const bytes = await readFile(path.join(root, 'main.html'), 'utf8');
    assert.equal(bytes, source.replace('Original text', 'Human edited &lt;text&gt;').replace('Original cell', 'Updated cell'));
    assert.equal(await readFile(path.join(root, 'code.ts'), 'utf8'), unrelatedCode);
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
    assert.equal((await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout, revisionBefore);
    assert.deepEqual(await readFile(path.join(root, '.git', 'HEAD')), gitBefore);
    const statusAfter = (await exec('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1'])).stdout;
    assert.ok(statusAfter.split('\n').includes(' M main.html'));
    assert.equal(statusAfter.split('\n').filter(line => line !== ' M main.html').join('\n'), statusBefore);
    assert.equal((await readdir(root)).some(name => name.startsWith('.accord-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true });
  }
});

test('external modification and stale second-tab save refuse to overwrite disk', async () => {
  const root = await fixture();
  let backupDirectory: string | undefined;
  try {
    const workspace = await Workspace.open(root);
    const firstTab = await workspace.load('main.html');
    await writeFile(path.join(root, 'main.html'), source.replace('Original text', 'Agent edit'));
    await assert.rejects(workspace.save({ path: 'main.html', version: firstTab.version, edits: [edit(firstTab, 'Original text', 'Stale edit')] }), /Disk content changed/u);
    assert.ok((await readFile(path.join(root, 'main.html'), 'utf8')).includes('Agent edit'));
    const next = await workspace.load('main.html');
    const saved = await workspace.save({ path: 'main.html', version: next.version, edits: [edit(next, 'Agent edit', 'First tab save')] });
    backupDirectory = path.dirname(saved.recovery!);
    await assert.rejects(workspace.save({ path: 'main.html', version: next.version, edits: [edit(next, 'Agent edit', 'Second tab save')] }), /Disk content changed/u);
    assert.ok((await readFile(path.join(root, 'main.html'), 'utf8')).includes('First tab save'));
  } finally {
    await rm(root, { recursive: true, force: true });
    if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true });
  }
});

test('traversal, hidden files, code, links and replacement symlinks are not accessible', async t => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'accord-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.html'), source);
    await symlink(outside, path.join(root, 'linked-directory'), 'junction');
    const workspace = await Workspace.open(root);
    assert.equal(workspace.info.documents.some(name => name.includes('linked')), false);
    for (const name of ['../secret.html', '.git/config', '.private.html', 'code.ts', 'node_modules/hidden.html', 'linked-directory/secret.html']) {
      await assert.rejects(workspace.load(name));
    }
    await link(path.join(outside, 'secret.html'), path.join(root, 'hard.html'));
    const withHardlink = await Workspace.open(root);
    await assert.rejects(withHardlink.load('hard.html'), /non-hard-linked/u);
    await rm(path.join(root, 'assets'), { recursive: true });
    await symlink(outside, path.join(root, 'assets'), 'junction');
    const view = await workspace.load('main.html');
    assert.ok(view.warnings.some(warning => warning.includes('Symbolic links')));
    assert.ok(!view.html.includes('src="data:'));
    await t.test('workspace root must be a Git root', async () => {
      await assert.rejects(Workspace.open(outside));
      await assert.rejects(Workspace.open(path.join(root, 'node_modules')), /repository root/u);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('invalid UTF-8 and oversized documents fail explicitly without writes', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'main.html'), Buffer.from([0xff, 0xfe, 0x00]));
    const workspace = await Workspace.open(root);
    await assert.rejects(workspace.load('main.html'), /valid UTF-8/u);
    await writeFile(path.join(root, 'main.html'), 'x'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(workspace.load('main.html'), /2 MiB/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('companion instances coordinate saves and never serve disguised non-image bytes', async () => {
  const root = await fixture();
  const recoveryDirectories: string[] = [];
  try {
    const [first, second] = await Promise.all([Workspace.open(root), Workspace.open(root)]);
    const view = await first.load('main.html');
    const results = await Promise.allSettled([first, second].map((workspace, index) => workspace.save({
      path: view.path, version: view.version, edits: [edit(view, 'Original text', `Companion ${index}`)]
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results) {
      if (result.status === 'fulfilled') recoveryDirectories.push(path.dirname(result.value.recovery!));
      else assert.match(String(result.reason), /save is already|Disk content changed/u);
    }
    await writeFile(path.join(root, 'assets', 'pixel.png'), 'source code disguised as an image');
    const preview = await first.load('main.html');
    assert.ok(preview.warnings.some(warning => warning.includes('supported raster')));
    assert.ok(!preview.html.includes('src="data:'));
    assert.ok(!preview.html.includes(Buffer.from('source code disguised as an image').toString('base64')));
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const directory of recoveryDirectories) await rm(directory, { recursive: true, force: true });
  }
});

test('loopback API requires capability, expected Host, Origin and current workspace; exposes no repo static root', async () => {
  const root = await fixture();
  const companion = await startCompanion();
  const headers = { Authorization: `Bearer ${companion.token}`, Origin: companion.origin, 'Content-Type': 'application/json' };
  try {
    assert.equal(companion.server.address() && typeof companion.server.address() === 'object' &&
      (companion.server.address() as { address: string }).address, '127.0.0.1');
    const home = await fetch(companion.origin);
    assert.equal(home.status, 200);
    assert.ok(home.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${companion.origin}/api/document?path=main.html`)).status, 401);
    assert.equal((await fetch(`${companion.origin}/api/workspace`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: JSON.stringify({ root }) })).status, 403);
    assert.equal((await fetch(`${companion.origin}/api/workspace`, { method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) })).status, 403);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(`${companion.origin}/api/workspace`, { method: 'POST', headers: { ...headers, Host: 'evil.test' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      call.on('error', reject);
      call.end(JSON.stringify({ root }));
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(`${companion.origin}/api/workspace`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } })).status, 401);
    const opened = await fetch(`${companion.origin}/api/workspace`, { method: 'POST', headers, body: JSON.stringify({ root }) });
    assert.equal(opened.status, 200);
    const info = await opened.json() as WorkspaceInfo;
    const workspaceHeaders = { ...headers, 'X-Accord-Workspace': info.id };
    const loaded = await fetch(`${companion.origin}/api/document?path=main.html`, { headers: workspaceHeaders });
    assert.equal(loaded.status, 200, await loaded.text());
    assert.equal((await fetch(`${companion.origin}/api/document?path=main.html`, { headers })).status, 409);
    assert.equal((await fetch(`${companion.origin}/main.html`)).status, 404);
    assert.equal((await fetch(`${companion.origin}/.git/HEAD`)).status, 404);
    assert.equal((await fetch(`${companion.origin}/api/document?path=code.ts`, { headers: workspaceHeaders })).status, 404);
    const before = await readFile(path.join(root, 'main.html'));
    assert.equal((await fetch(`${companion.origin}/api/save`, { method: 'POST', headers: workspaceHeaders,
      body: JSON.stringify({ path: 'main.html', version: 'stale', edits: [] }) })).status, 409);
    assert.equal((await fetch(`${companion.origin}/api/save`, { method: 'POST', headers: workspaceHeaders,
      body: JSON.stringify({ path: 'main.html', version: 'stale', edits: [null] }) })).status, 400);
    assert.equal((await fetch(`${companion.origin}/api/save`, { method: 'POST', headers: workspaceHeaders,
      body: JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) }) })).status, 413);
    const switched = await fetch(`${companion.origin}/api/workspace`, { method: 'POST', headers, body: JSON.stringify({ root }) });
    assert.equal(switched.status, 200);
    assert.equal((await fetch(`${companion.origin}/api/document?path=main.html`, { headers: workspaceHeaders })).status, 409);
    assert.deepEqual(await readFile(path.join(root, 'main.html')), before);
  } finally {
    await new Promise<void>((resolve, reject) => companion.server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
