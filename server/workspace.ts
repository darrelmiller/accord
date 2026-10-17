import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { DocumentView, SaveRequest, WorkspaceInfo } from '../shared/model.js';
import { HtmlDocument, versionOf } from './document.js';
import { AccordError, requireValue } from './errors.js';
import { allowedSegment, containedPath, relativePath } from './paths.js';
import { validateReviewFile, validateReviewRequest, maxReviewBytes } from './reviews.js';
import type { AnchorState, ReviewAnchor, ReviewFile, ReviewRequest, ReviewView } from './reviews.js';

const exec = promisify(execFile);
const maxDocumentBytes = 2 * 1024 * 1024;
const maxAssetBytes = 2 * 1024 * 1024;
const maxDocuments = 2000;
const maxEntries = 30_000;

type ReviewSnapshot = { file: ReviewFile; version: string | null; ino: number | null; dev: number | null; mode: number };

function reviewBlocks(source: string, persistedOnly = false): Map<string, string | null> {
  type Node = DefaultTreeAdapterMap['node'];
  type Element = DefaultTreeAdapterMap['element'];
  const tree = parse(source.startsWith('\uFEFF') ? source.slice(1) : source, { sourceCodeLocationInfo: true });
  const offset = source.startsWith('\uFEFF') ? 1 : 0;
  const elements: Element[] = [];
  const ids = new Map<string, number>();
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      elements.push(node);
      const id = node.attrs.find(attribute => attribute.name === 'id')?.value;
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(tree);
  const text = (node: Node): string => {
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    if (['script', 'style', 'template'].includes(node.nodeName)) return '';
    return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  };
  const result = new Map<string, string | null>();
  const blocks = new Set('h1 h2 h3 h4 h5 h6 p li dt dd th td caption figcaption blockquote pre'.split(' '));
  for (const node of elements) {
    if (!blocks.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
        !node.sourceCodeLocation?.startTag) continue;
    let id = node.attrs.find(attribute => attribute.name === 'id')?.value;
    if (!id) {
      if (persistedOnly) continue;
      // Match the preview's source-location identities without ever inserting IDs into the HTML.
      const base = `accord-${(node.sourceCodeLocation.startTag.startOffset + offset).toString(36)}`;
      id = base;
      let suffix = 1;
      while (ids.has(id)) id = `${base}-${suffix++}`;
      ids.set(id, 1);
    }
    result.set(id, ids.get(id) === 1 ? text(node) : null);
  }
  return result;
}

function anchorState(anchor: ReviewAnchor, blocks: Map<string, string | null>): AnchorState {
  if (anchor.blockId === null) return 'document';
  if (!blocks.has(anchor.blockId)) return 'missing';
  const block = blocks.get(anchor.blockId);
  if (typeof block !== 'string') return 'stale';
  const first = block.indexOf(anchor.quote);
  return first >= 0 && block.indexOf(anchor.quote, first + 1) < 0 ? 'current' : 'stale';
}

function imageMime(bytes: Buffer, filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (extension === '.gif' && /^(GIF87a|GIF89a)$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (extension === '.webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new AccordError(422, 'Image bytes do not match a supported raster format.');
}

export class Workspace {
  readonly id = randomUUID();
  private readonly documents = new Set<string>();
  private recoveryDirectory: string | undefined;
  private constructor(readonly root: string) {}

  static async open(directory: unknown): Promise<Workspace> {
    requireValue(typeof directory === 'string' && path.isAbsolute(directory), 400, 'Enter an absolute local repository path.');
    const selected = path.resolve(directory);
    requireValue(!(await lstat(selected)).isSymbolicLink(), 403, 'Select the repository itself, not a symbolic link or junction.');
    const root = await realpath(selected);
    const { stdout } = await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', '--show-toplevel'], {
      timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true
    });
    requireValue(await realpath(stdout.trim()) === root, 400, 'Select the Git repository root, not a subdirectory.');
    const workspace = new Workspace(root);
    let entriesSeen = 0;
    const discover = async (directoryPath: string, prefix: string, depth: number): Promise<void> => {
      requireValue(depth <= 32, 422, 'Workspace exceeds the 32-level discovery limit.');
      for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
        if (!allowedSegment(entry.name)) continue;
        requireValue(++entriesSeen <= maxEntries, 422, 'Workspace exceeds the 30,000-entry discovery limit.');
        if (entry.isSymbolicLink()) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const resolved = await containedPath(root, relative);
        if (entry.isDirectory()) await discover(resolved, relative, depth + 1);
        else if (entry.isFile() && /\.html?$/iu.test(entry.name)) {
          requireValue(workspace.documents.size < maxDocuments, 422, 'Workspace exceeds the 2,000-document discovery limit.');
          workspace.documents.add(relative);
        }
      }
    };
    await discover(root, '', 0);
    return workspace;
  }

  get info(): WorkspaceInfo {
    return { id: this.id, root: this.root, documents: [...this.documents].sort((a, b) => a.localeCompare(b)) };
  }

  private async read(relative: string, limit: number): Promise<{ bytes: Buffer; mode: number; ino: number; dev: number }> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.readStable(relative, limit); }
      catch (error) {
        // Local file scanners can change metadata after a read; retry the entire checked read, never relax its checks.
        if (attempt >= 2 || !(error instanceof AccordError) || error.status !== 409 ||
            !/^File changed while (opening|reading)\./u.test(error.message)) throw error;
        await delay(20);
      }
    }
  }

  private async readStable(relative: string, limit: number): Promise<{ bytes: Buffer; mode: number; ino: number; dev: number }> {
    const filename = await containedPath(this.root, relative);
    const before = await lstat(filename);
    requireValue(before.isFile() && before.nlink === 1, 403, 'Only regular, non-hard-linked files are accessible.');
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      requireValue(stat.isFile() && stat.nlink === 1, 403, 'Only regular, non-hard-linked files are accessible.');
      requireValue(stat.ino === before.ino && stat.dev === before.dev, 409, 'File changed while opening. Retry.');
      requireValue(stat.size <= limit, 413, `File exceeds the ${limit / 1024 / 1024} MiB limit.`);
      const verified = await lstat(await containedPath(this.root, relative));
      requireValue(stat.ino === verified.ino && stat.dev === verified.dev, 409, 'File changed while opening. Retry.');
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const bytes = buffer.subarray(0, size);
      const after = await handle.stat();
      requireValue(bytes.length <= limit && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs &&
        after.size === stat.size, 409, 'File changed while reading. Retry.');
      const current = await lstat(await containedPath(this.root, relative));
      requireValue(current.isFile() && current.nlink === 1 && current.ino === stat.ino && current.dev === stat.dev &&
        current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs && current.size === stat.size,
      409, 'File changed while reading. Retry.');
      return { bytes, mode: stat.mode, ino: stat.ino, dev: stat.dev };
    } finally {
      await handle.close();
    }
  }

  private async model(relative: string): Promise<HtmlDocument> {
    relativePath(relative);
    requireValue(this.documents.has(relative), 404, 'Document was not discovered in this workspace. Reopen to refresh the list.');
    const { bytes } = await this.read(relative, maxDocumentBytes);
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new AccordError(422, 'Only valid UTF-8 HTML is supported. No bytes were changed.');
    }
    return new HtmlDocument(source, relative, this.documents);
  }

  async load(relative: string): Promise<DocumentView> {
    const model = await this.model(relative);
    const warnings = [...model.view.warnings];
    let html = model.view.html;
    let total = 0;
    for (const [id, imagePath] of model.images) {
      try {
        const { bytes } = await this.read(imagePath, maxAssetBytes);
        total += bytes.length;
        requireValue(total <= 8 * 1024 * 1024, 413, 'Combined images exceed the 8 MiB preview limit.');
        const mime = imageMime(bytes, imagePath);
        html = html.replace(`data-accord-image="${id}"`, `src="data:${mime};base64,${bytes.toString('base64')}"`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown image error';
        warnings.push(`Image unavailable (${imagePath}): ${reason}`);
      }
    }
    return { ...model.view, html, warnings };
  }

  async save(request: SaveRequest): Promise<{ document: DocumentView; recovery: string | null }> {
    requireValue(typeof request.path === 'string' && typeof request.version === 'string', 400, 'Missing document path or version.');
    requireValue(this.documents.has(relativePath(request.path)), 404, 'Document was not discovered in this workspace.');
    return this.withDocumentLock(request.path, () => this.saveLocked(request));
  }

  private async withDocumentLock<T>(relative: string, action: () => Promise<T>): Promise<T> {
    const filename = await containedPath(this.root, relative);
    const lockPath = path.join(path.dirname(filename), `.accord-${versionOf(relative).slice(0, 24)}.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new AccordError(409, `A save is already in progress or a previous save was interrupted. Nothing was written. Lock: ${lockPath}`);
      }
      throw error;
    }
    const identity = await lock.stat();
    try {
      await containedPath(this.root, relative);
      requireValue(identity.isFile() && identity.nlink === 1, 403, 'Invalid document lock.');
      return await action();
    } finally {
      await lock.close();
      await containedPath(this.root, relative);
      const latest = await lstat(lockPath);
      requireValue(!latest.isSymbolicLink() && latest.ino === identity.ino && latest.dev === identity.dev &&
        latest.nlink === 1, 409, 'Document lock changed. Inspect the lock before retrying.');
      await unlink(lockPath);
    }
  }

  private async reviewFilename(relative: string): Promise<string> {
    relativePath(`${relative}.accord-review.json`);
    const document = await containedPath(this.root, relative);
    const filename = `${document}.accord-review.json`;
    try {
      await lstat(filename);
      return await containedPath(this.root, `${relative}.accord-review.json`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      // Only the final sidecar may be absent. All parents and the discovered document must exist.
      await containedPath(this.root, relative);
      return filename;
    }
  }

  private async reviewSnapshot(relative: string): Promise<ReviewSnapshot> {
    await this.reviewFilename(relative);
    let original;
    try {
      original = await this.read(`${relative}.accord-review.json`, maxReviewBytes);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await this.reviewFilename(relative);
      return { file: { schemaVersion: 1, document: relative, threads: [] }, version: null, ino: null, dev: null, mode: 0o600 };
    }
    let file: unknown;
    try {
      file = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original.bytes));
    } catch {
      throw new AccordError(422, 'Malformed review sidecar JSON or UTF-8. No bytes were changed.');
    }
    validateReviewFile(file, relative);
    return { file, version: versionOf(original.bytes), ino: original.ino, dev: original.dev, mode: original.mode };
  }

  private reviewView(snapshot: ReviewSnapshot, source: string): ReviewView {
    const blocks = reviewBlocks(source);
    return {
      version: snapshot.version,
      threads: snapshot.file.threads.map(thread => ({ ...thread, anchorState: anchorState(thread.anchor, blocks) }))
    };
  }

  async loadReviews(relative: string): Promise<ReviewView> {
    const model = await this.model(relative);
    return this.reviewView(await this.reviewSnapshot(relative), model.source);
  }

  async review(input: unknown): Promise<ReviewView> {
    validateReviewRequest(input);
    const request: ReviewRequest = structuredClone(input);
    requireValue(this.documents.has(relativePath(request.path)), 404, 'Document was not discovered in this workspace.');
    return this.withDocumentLock(request.path, async () => {
      const model = await this.model(request.path);
      const original = await this.reviewSnapshot(request.path);
      requireValue(original.version === request.version, 409, 'Review sidecar changed. Reload reviews before retrying.');
      const file = original.file;
      if (request.action === 'comment') {
        const anchor = request.anchor!;
        requireValue(anchor.documentVersion === model.view.version, 409, 'Document changed. Reload before commenting.');
        requireValue(anchor.blockId === null || reviewBlocks(model.source, true).has(anchor.blockId), 422,
          'Block comments require an existing source block ID. Save the document to persist provisional IDs, or use a document-level comment.');
        requireValue(['document', 'current'].includes(anchorState(anchor, reviewBlocks(model.source))), 422,
          'Anchor must identify a unique source block containing exactly one occurrence of the quote.');
        file.threads.push({
          id: randomUUID(), createdAt: new Date().toISOString(), author: request.author, body: request.body!,
          status: 'open', anchor, replies: []
        });
      } else {
        const thread = file.threads.find(value => value.id === request.threadId);
        requireValue(thread, 404, 'Review thread not found.');
        if (request.action === 'reply') {
          thread.replies.push({ id: randomUUID(), createdAt: new Date().toISOString(), author: request.author, body: request.body! });
        } else thread.status = request.action === 'resolve' ? 'resolved' : 'open';
      }
      validateReviewFile(file, request.path);
      const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
      requireValue(bytes.length <= maxReviewBytes, 413, 'Review sidecar exceeds the 2 MiB limit.');
      const filename = await this.reviewFilename(request.path);
      const temporary = path.join(path.dirname(filename), `.accord-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', original.mode & 0o777);
      const identity = await handle.stat();
      let created = true;
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        const latest = await this.reviewSnapshot(request.path);
        requireValue(latest.version === original.version && latest.ino === original.ino && latest.dev === original.dev,
          409, 'Review sidecar changed during saving. Nothing was replaced.');
        const document = await this.read(request.path, maxDocumentBytes);
        requireValue(versionOf(document.bytes) === model.view.version, 409, 'Document changed during reviewing. Nothing was replaced.');
        await this.reviewFilename(request.path);
        const current = await lstat(temporary);
        requireValue(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
          current.ino === identity.ino && current.dev === identity.dev, 409, 'Review staging file changed. Nothing was replaced.');
        await rename(temporary, filename);
        created = false;
      } finally {
        if (created) {
          await containedPath(this.root, request.path);
          const current = await lstat(temporary);
          if (current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink()) await unlink(temporary);
        }
      }
      const saved = await this.reviewSnapshot(request.path);
      requireValue(saved.version === versionOf(bytes), 409, 'Reviews changed immediately after saving. Reload to inspect disk.');
      return this.reviewView(saved, (await this.model(request.path)).source);
    });
  }

  private async saveLocked(request: SaveRequest): Promise<{ document: DocumentView; recovery: string | null }> {
    const model = await this.model(request.path);
    requireValue(model.view.version === request.version, 409, 'Disk content changed. Your edits are still in the browser. Copy them before reloading.');
    const updated = model.apply(request.edits);
    requireValue(Buffer.byteLength(updated) <= maxDocumentBytes, 413, 'Edited document exceeds the 2 MiB limit.');
    if (updated === model.source) return { document: await this.load(request.path), recovery: null };
    const original = await this.read(request.path, maxDocumentBytes);
    requireValue(versionOf(original.bytes) === request.version, 409, 'Disk content changed before saving. Nothing was written.');
    const filename = await containedPath(this.root, request.path);
    const temporary = path.join(path.dirname(filename), `.accord-${randomUUID()}.tmp`);
    let created = false;
    let recovery: string | null = null;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, original.mode & 0o777);
      created = true;
      try {
        await handle.writeFile(updated, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.recoveryDirectory ??= await mkdtemp(path.join(tmpdir(), 'accord-recovery-'));
      await mkdir(this.recoveryDirectory, { recursive: true });
      recovery = path.join(this.recoveryDirectory, `${randomUUID()}.html`);
      const backup = await open(recovery, 'wx', 0o600);
      try {
        await backup.writeFile(original.bytes);
        await backup.sync();
      } finally {
        await backup.close();
      }
      const latest = await this.read(request.path, maxDocumentBytes);
      requireValue(latest.ino === original.ino && latest.dev === original.dev &&
        versionOf(latest.bytes) === request.version, 409, 'Disk content changed during saving. Nothing was replaced.');
      await containedPath(this.root, request.path);
      await rename(temporary, filename);
      created = false;
    } finally {
      if (created) await unlink(temporary);
    }
    // Re-read rather than treating a successful rename as proof of the current disk state.
    const document = await this.load(request.path);
    requireValue(document.version === versionOf(updated), 409, 'Another writer changed the file immediately after saving. Reload to inspect disk.');
    return { document, recovery };
  }
}
