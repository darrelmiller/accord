import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Workspace } from '../server/workspace.js';
import { startCompanion } from '../server/http.js';
import { AccordError } from '../server/errors.js';
import { validateReviewFile } from '../server/reviews.js';
import type { ReviewFile, ReviewRequest, ReviewView } from '../shared/review.js';
import type { WorkspaceInfo } from '../shared/model.js';

const exec = promisify(execFile);
const documentPath = 'docs/a.html';
const source = '\uFEFF<!doctype html><html><head><title>Review</title><script type="application/json">{"existing":{"review":"untouched"}}</script></head><body><p id="p">Hello <em>world</em> &amp; friends</p><p id="gone">Remove me</p><p>No source ID</p></body></html>';

async function fixture() {
  // Keep all generated fixture files inside the checkout, not a shared OS temporary directory.
  const root = await mkdtemp(path.join(process.cwd(), '.accord-review-test-'));
  await exec('git', ['init', '--quiet', root]);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'a.html'), source);
  await writeFile(path.join(root, 'unrelated.ts'), 'leave this alone');
  return {
    root,
    document: path.join(root, 'docs', 'a.html'),
    sidecar: path.join(root, 'docs', 'a.html.accord-review.json'),
    workspace: await Workspace.open(root)
  };
}

async function comment(workspace: Workspace, version: string | null = null, blockId: string | null = 'p', quote = 'world'): Promise<ReviewRequest> {
  return {
    path: documentPath, version, action: 'comment', author: 'Local reviewer', body: 'Please clarify.',
    anchor: { blockId, quote, documentVersion: (await workspace.load(documentPath)).version }
  };
}

function status(code: number) {
  return (error: unknown) => error instanceof AccordError && error.status === code;
}

test('sidecar add/reload/reply/resolve/reopen preserves HTML, embedded records and Git state', async () => {
  const f = await fixture();
  try {
    const htmlBefore = await readFile(f.document);
    const gitBefore = await readFile(path.join(f.root, '.git', 'HEAD'));
    const beforeEntries = await readdir(path.join(f.root, '.git'));
    assert.deepEqual(await f.workspace.loadReviews(documentPath), { version: null, threads: [] });
    const added = await f.workspace.review(await comment(f.workspace));
    assert.match(added.version!, /^[a-f0-9]{64}$/u);
    assert.equal(added.threads.length, 1);
    const thread = added.threads[0]!;
    assert.equal(thread.anchorState, 'current');
    assert.equal(thread.author, 'Local reviewer');
    assert.equal(thread.status, 'open');
    assert.ok(thread.id && thread.createdAt);
    const raw = JSON.parse(await readFile(f.sidecar, 'utf8')) as ReviewFile;
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.document, documentPath);
    assert.ok(!('anchorState' in raw.threads[0]!));
    const reopened = await Workspace.open(f.root);
    assert.deepEqual(await reopened.loadReviews(documentPath), added);
    const reply = await reopened.review({
      path: documentPath, version: added.version, action: 'reply', threadId: thread.id,
      author: 'Another locally declared name', body: 'Here is more context.'
    });
    assert.equal(reply.threads[0]!.replies[0]!.body, 'Here is more context.');
    assert.notEqual(reply.version, added.version);
    assert.notEqual(reply.threads[0]!.replies[0]!.id, thread.id);
    const resolved = await reopened.review({ path: documentPath, version: reply.version, action: 'resolve', threadId: thread.id, author: 'Anyone local' });
    assert.equal(resolved.threads[0]!.status, 'resolved');
    const open = await reopened.review({ path: documentPath, version: resolved.version, action: 'reopen', threadId: thread.id, author: 'Anyone local' });
    assert.equal(open.threads[0]!.status, 'open');
    assert.equal(open.threads[0]!.replies.length, 1);
    assert.deepEqual(await readFile(f.document), htmlBefore);
    assert.equal(await readFile(path.join(f.root, 'unrelated.ts'), 'utf8'), 'leave this alone');
    assert.deepEqual(await readFile(path.join(f.root, '.git', 'HEAD')), gitBefore);
    assert.deepEqual(await readdir(path.join(f.root, '.git')), beforeEntries);
    assert.deepEqual((await readdir(path.dirname(f.document))).sort(), ['a.html', 'a.html.accord-review.json']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('anchors use decoded exact block text, stay current across unrelated changes, and report stale/missing/document', async () => {
  const f = await fixture();
  try {
    const first = await f.workspace.review(await comment(f.workspace, null, 'p', 'Hello world & friends'));
    const second = await f.workspace.review(await comment(f.workspace, first.version, 'gone', 'Remove'));
    const third = await f.workspace.review(await comment(f.workspace, second.version, null, ''));
    await writeFile(f.document, source.replace('<title>Review</title>', '<title>Different</title>'));
    assert.deepEqual((await f.workspace.loadReviews(documentPath)).threads.map(thread => thread.anchorState), ['current', 'current', 'document']);
    await writeFile(f.document, source.replace('world', 'everyone').replace('<p id="gone">Remove me</p>', ''));
    const changed = await f.workspace.loadReviews(documentPath);
    assert.deepEqual(changed.threads.map(thread => thread.anchorState), ['stale', 'missing', 'document']);
    assert.equal(changed.version, third.version);
    // A duplicate ID is not a unique anchor, even if one copy contains the old quote.
    await writeFile(f.document, source.replace('</body>', '<div id="p">Duplicate</div></body>'));
    assert.equal((await f.workspace.loadReviews(documentPath)).threads[0]!.anchorState, 'stale');
    await assert.rejects(f.workspace.review(await comment(f.workspace, third.version)), status(422));
    await writeFile(f.document, source);
    const preview = await f.workspace.load(documentPath);
    const generated = /<p id="(accord-[^"]+)">/u.exec(preview.html)?.[1];
    assert.ok(generated);
    await assert.rejects(f.workspace.review(await comment(f.workspace, third.version, generated, 'No source ID')),
      /existing source block ID/u);
    assert.equal(await readFile(f.document, 'utf8'), source);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('duplicate quotes are stale, while whole blocks remain unambiguous; read-only previews retain writable local history', async () => {
  const f = await fixture();
  try {
    const first = await f.workspace.review(await comment(f.workspace));
    await writeFile(f.document, source.replace('world</em>', 'world world</em>'));
    assert.equal((await f.workspace.loadReviews(documentPath)).threads[0]!.anchorState, 'stale');
    await assert.rejects(f.workspace.review(await comment(f.workspace, first.version)), /exactly one occurrence/u);
    const whole = await f.workspace.review(await comment(f.workspace, first.version, 'p', 'Hello world world & friends'));
    assert.equal(whole.threads[1]!.anchorState, 'current');
    await writeFile(f.document, source.replace('world</em>', 'aaa</em>'));
    await assert.rejects(f.workspace.review(await comment(f.workspace, whole.version, 'p', 'aa')), /exactly one occurrence/u);
    const readOnlySource = source.replace('</head>', '<script>throw new Error("must not execute")</script></head>');
    await writeFile(f.document, readOnlySource);
    assert.equal((await f.workspace.load(documentPath)).editable, false);
    const documentComment = await f.workspace.review(await comment(f.workspace, whole.version, null, ''));
    assert.equal(documentComment.threads.at(-1)!.anchorState, 'document');
    const reply = await f.workspace.review({
      path: documentPath, version: documentComment.version, action: 'reply',
      threadId: first.threads[0]!.id, author: 'Local', body: 'Read-only HTML does not prevent discussion.'
    });
    const resolved = await f.workspace.review({
      path: documentPath, version: reply.version, action: 'resolve', threadId: first.threads[0]!.id, author: 'Local'
    });
    assert.equal(resolved.threads[0]!.status, 'resolved');
    assert.equal(resolved.threads[0]!.replies.length, 1);
    assert.equal(await readFile(f.document, 'utf8'), readOnlySource);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('sidecar and document optimistic versions reject stale writes and companion instances share the document lock', async () => {
  const f = await fixture();
  try {
    const request = await comment(f.workspace);
    const other = await Workspace.open(f.root);
    const results = await Promise.allSettled([f.workspace.review(request), other.review(request)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected');
    assert.ok(failed?.status === 'rejected' && status(409)(failed.reason));
    const before = await readFile(f.sidecar);
    await assert.rejects(f.workspace.review(request), status(409));
    assert.deepEqual(await readFile(f.sidecar), before);
    const current = await f.workspace.loadReviews(documentPath);
    const staleDocument = await comment(f.workspace, current.version);
    await writeFile(f.document, source.replace('world', 'new content'));
    await assert.rejects(f.workspace.review(staleDocument), status(409));
    assert.deepEqual(await readFile(f.sidecar), before);
    // Whitespace-only external sidecar changes also invalidate the byte fingerprint.
    const fresh = await comment(f.workspace, current.version, null, '');
    await writeFile(f.sidecar, Buffer.concat([before, Buffer.from('\n')]));
    await assert.rejects(f.workspace.review(fresh), status(409));
    await writeFile(path.join(f.root, 'docs', `.accord-${(await import('../server/document.js')).versionOf(documentPath).slice(0, 24)}.lock`), 'interrupted');
    await assert.rejects(f.workspace.review(await comment(f.workspace, null)), /save is already in progress/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('invalid sidecars are never reset or silently migrated', async () => {
  const f = await fixture();
  try {
    const added = await f.workspace.review(await comment(f.workspace));
    const valid = JSON.parse(await readFile(f.sidecar, 'utf8')) as ReviewFile;
    const invalid = [
      '{not JSON', 'null', '[]',
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, document: 'another.html' }),
      JSON.stringify({ ...valid, futureField: true }),
      JSON.stringify({ ...valid, threads: [{ ...valid.threads[0], replies: null }] }),
      JSON.stringify({ ...valid, threads: [valid.threads[0], valid.threads[0]] }),
      JSON.stringify({ ...valid, threads: [{ ...valid.threads[0], createdAt: 'yesterday' }] }),
      JSON.stringify({ ...valid, threads: [{ ...valid.threads[0], anchor: { blockId: 'p', quote: 'world' } }] }),
      Buffer.from([0xff, 0xfe]),
      ' '.repeat(2 * 1024 * 1024 + 1)
    ];
    for (const bytes of invalid) {
      await writeFile(f.sidecar, bytes);
      const before = await readFile(f.sidecar);
      await assert.rejects(f.workspace.loadReviews(documentPath));
      await assert.rejects(f.workspace.review(await comment(f.workspace, added.version)));
      assert.deepEqual(await readFile(f.sidecar), before);
      assert.equal(await readFile(f.document, 'utf8'), source);
    }
    assert.throws(() => validateReviewFile({ ...valid, threads: Array.from({ length: 501 }, () => valid.threads[0]) }, documentPath), status(422));
    assert.throws(() => validateReviewFile({
      ...valid, threads: [{ ...valid.threads[0], replies: Array.from({ length: 201 }, () => ({ id: 'x', author: 'x', body: 'x', createdAt: new Date().toISOString() })) }]
    }, documentPath), status(422));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('malformed actions, oversized strings, arbitrary files and invalid anchors fail without creating a sidecar', async () => {
  const f = await fixture();
  try {
    const valid = await comment(f.workspace);
    const invalid: unknown[] = [
      null, [], {}, { ...valid, version: undefined }, { ...valid, version: 'bogus' },
      { ...valid, author: '' }, { ...valid, author: 'a'.repeat(201) },
      { ...valid, body: '' }, { ...valid, body: 'b'.repeat(10_001) }, { ...valid, body: '\0' },
      { ...valid, action: 'apply' }, { ...valid, extra: 'unknown' }, { ...valid, threadId: 'not allowed' },
      { ...valid, anchor: null }, { ...valid, anchor: { ...valid.anchor, blockId: null } },
      { ...valid, anchor: { ...valid.anchor, quote: '' } },
      { ...valid, anchor: { ...valid.anchor, quote: 'not found' } },
      { ...valid, anchor: { ...valid.anchor, blockId: 'absent' } },
      { ...valid, anchor: { ...valid.anchor, blockId: 'p', quote: 'world Remove' } },
      { ...valid, action: 'reply' }, { path: documentPath, version: null, author: 'x', action: 'reply', threadId: 'none', body: 'reply' },
      { path: documentPath, version: null, author: 'x', action: 'resolve', threadId: 'none', body: 'not allowed' },
      { ...valid, path: '../escape.html' }, { ...valid, path: 'unrelated.ts' }, { ...valid, path: '.git/HEAD' },
      { ...valid, path: 'docs/a.html.accord-review.json' }
    ];
    for (const input of invalid) await assert.rejects(f.workspace.review(input));
    for (const name of ['../escape.html', 'unrelated.ts', '.git/HEAD', 'docs/a.html.accord-review.json']) {
      await assert.rejects(f.workspace.loadReviews(name));
    }
    await assert.rejects(readFile(f.sidecar), { code: 'ENOENT' });
    assert.equal(await readFile(f.document, 'utf8'), source);
    assert.deepEqual(await readdir(path.dirname(f.document)), ['a.html']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('sidecar hardlinks, directory junctions, and linked/replaced HTML cannot escape the workspace', async t => {
  const f = await fixture();
  const outside = await mkdtemp(path.join(process.cwd(), '.accord-review-outside-'));
  try {
    const added = await f.workspace.review(await comment(f.workspace));
    const original = await readFile(f.sidecar);
    const target = path.join(outside, 'outside.json');
    await writeFile(target, original);
    await rm(f.sidecar);
    await link(target, f.sidecar);
    await assert.rejects(f.workspace.loadReviews(documentPath), status(403));
    await assert.rejects(f.workspace.review(await comment(f.workspace, added.version)), status(403));
    assert.deepEqual(await readFile(target), original);
    await rm(f.sidecar);
    await mkdir(f.sidecar);
    await assert.rejects(f.workspace.loadReviews(documentPath), status(403));
    await assert.rejects(f.workspace.review(await comment(f.workspace, added.version)), status(403));
    await rm(f.sidecar, { recursive: true });
    await t.test('file symbolic links are rejected when supported by this host', async inner => {
      try { await symlink(target, f.sidecar, 'file'); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') { inner.skip('File symlinks require host privileges.'); return; }
        throw error;
      }
      await assert.rejects(f.workspace.loadReviews(documentPath), status(403));
      await assert.rejects(f.workspace.review(await comment(f.workspace, added.version)), status(403));
      await rm(f.sidecar);
    });
    const hardlinkRequest = await comment(f.workspace, null);
    await writeFile(path.join(outside, 'a.html'), source);
    await rm(f.document);
    await link(path.join(outside, 'a.html'), f.document);
    await assert.rejects(f.workspace.loadReviews(documentPath), status(403));
    await assert.rejects(f.workspace.review(hardlinkRequest), status(403));
    await rm(path.join(f.root, 'docs'), { recursive: true });
    await symlink(outside, path.join(f.root, 'docs'), 'junction');
    await assert.rejects(f.workspace.loadReviews(documentPath), status(403));
    const request = { path: documentPath, version: null, action: 'comment', author: 'x', body: 'x', anchor: { blockId: null, quote: '', documentVersion: 'a'.repeat(64) } };
    await assert.rejects(f.workspace.review(request), status(403));
    assert.equal(await readFile(path.join(outside, 'a.html'), 'utf8'), source);
    assert.deepEqual(await readFile(target), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review HTTP routes require capability, same origin and current workspace and expose explicit conflicts', async () => {
  const f = await fixture();
  const companion = await startCompanion();
  const headers = { Authorization: `Bearer ${companion.token}`, Origin: companion.origin, 'Content-Type': 'application/json' };
  const endpoint = `${companion.origin}/api/reviews?path=${encodeURIComponent(documentPath)}`;
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers })).status, 409);
    const opened = await fetch(`${companion.origin}/api/workspace`, { method: 'POST', headers, body: JSON.stringify({ root: f.root }) });
    assert.equal(opened.status, 200);
    const info = await opened.json() as WorkspaceInfo;
    const authorized = { ...headers, 'X-Accord-Workspace': info.id };
    assert.equal((await fetch(endpoint, { headers })).status, 409);
    assert.equal((await fetch(endpoint, { headers: { ...authorized, Origin: 'https://evil.invalid' } })).status, 403);
    assert.deepEqual(await (await fetch(endpoint, { headers: authorized })).json(), { version: null, threads: [] });
    const request = await comment(f.workspace);
    const post = (input: unknown, extra = {}) => fetch(endpoint, { method: 'POST', headers: { ...authorized, ...extra }, body: JSON.stringify(input) });
    const noOrigin = { ...authorized } as Record<string, string>;
    delete noOrigin.Origin;
    assert.equal((await fetch(endpoint, { method: 'POST', headers: noOrigin, body: JSON.stringify(request) })).status, 403);
    assert.equal((await post(request, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...request, action: 'apply' })).status, 400);
    const response = await post(request);
    assert.equal(response.status, 200);
    const view = await response.json() as ReviewView;
    assert.equal(view.threads[0]!.anchorState, 'current');
    assert.equal((await post(request)).status, 409);
    assert.equal((await post({ path: documentPath, version: view.version, action: 'resolve', threadId: 'absent', author: 'x' })).status, 404);
    assert.equal((await fetch(`${companion.origin}/api/reviews?path=unrelated.ts`, { headers: authorized })).status, 404);
    assert.equal(await readFile(f.document, 'utf8'), source);
  } finally {
    companion.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => companion.server.close(error => error ? reject(error) : resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});
