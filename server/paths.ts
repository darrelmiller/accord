import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AccordError, requireValue } from './errors.js';

const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

export function allowedSegment(segment: string): boolean {
  return !!segment && !segment.startsWith('.') && !excluded.has(segment.toLowerCase()) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) &&
    !/[\\/:*?"<>|\u0000-\u001f]/u.test(segment) && !/[. ]$/u.test(segment);
}

export function relativePath(value: unknown): string {
  requireValue(typeof value === 'string' && value.length <= 1024, 400, 'A workspace-relative path is required.');
  const segments = value.split('/');
  requireValue(segments.every(allowedSegment), 403, 'Hidden, excluded, or unsafe paths are not accessible.');
  return segments.join('/');
}

export async function containedPath(root: string, value: unknown): Promise<string> {
  const relative = relativePath(value);
  requireValue(await realpath(root) === root, 409, 'Workspace location changed. Reopen the workspace.');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current);
    requireValue(!info.isSymbolicLink(), 403, 'Symbolic links and junctions are not accessible.');
    requireValue(await realpath(current) === current, 403, 'Path resolves outside its expected location.');
  }
  return current;
}

export function resolveReference(document: string, reference: string): { path: string; hash: string } | null {
  if (!reference || /^[a-z][a-z\d+.-]*:/iu.test(reference) || /^[\\/]/u.test(reference) ||
      reference.includes('?') || reference.includes('\\')) return null;
  try {
    const hashIndex = reference.indexOf('#');
    const name = decodeURIComponent(hashIndex < 0 ? reference : reference.slice(0, hashIndex));
    const hash = hashIndex < 0 ? '' : decodeURIComponent(reference.slice(hashIndex + 1));
    if (name.includes('\\') || name.includes('\0')) return null;
    const target = name ? path.posix.normalize(path.posix.join(path.posix.dirname(document), name)) : document;
    return { path: relativePath(target), hash };
  } catch (error) {
    if (error instanceof AccordError || error instanceof URIError) return null;
    throw error;
  }
}
