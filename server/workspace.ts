import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentView, SaveRequest, WorkspaceInfo } from '../shared/model.js';
import { HtmlDocument, versionOf } from './document.js';
import { AccordError, requireValue } from './errors.js';
import { allowedSegment, containedPath, relativePath } from './paths.js';

const exec = promisify(execFile);
const maxDocumentBytes = 2 * 1024 * 1024;
const maxAssetBytes = 2 * 1024 * 1024;
const maxDocuments = 2000;
const maxEntries = 30_000;

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
    const filename = await containedPath(this.root, relative);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      requireValue(stat.isFile() && stat.nlink === 1, 403, 'Only regular, non-hard-linked files are accessible.');
      requireValue(stat.size <= limit, 413, `File exceeds the ${limit / 1024 / 1024} MiB limit.`);
      const verified = await lstat(await containedPath(this.root, relative));
      requireValue(stat.ino === verified.ino && stat.dev === verified.dev, 409, 'File changed while opening. Retry.');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      requireValue(bytes.length <= limit && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs &&
        after.size === stat.size, 409, 'File changed while reading. Retry.');
      await containedPath(this.root, relative);
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
    const filename = await containedPath(this.root, request.path);
    const lockPath = path.join(path.dirname(filename), `.accord-${versionOf(request.path).slice(0, 24)}.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new AccordError(409, `A save is already in progress or a previous save was interrupted. Nothing was written. Lock: ${lockPath}`);
      }
      throw error;
    }
    try {
      return await this.saveLocked(request);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
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
