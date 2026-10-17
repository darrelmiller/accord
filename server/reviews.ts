import { requireValue } from './errors.js';
import type { ReviewAnchor, ReviewFile, ReviewRequest } from '../shared/review.js';
export type { AnchorState, ReviewAnchor, ReviewFile, ReviewReply, ReviewRequest, ReviewThread, ReviewView } from '../shared/review.js';

export const maxReviewBytes = 2 * 1024 * 1024;
export const maxReviewThreads = 500;
export const maxReviewReplies = 200;
export const maxReviewMessages = 2000;

function object(value: unknown, keys: string[], status: number): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)), status, 'Invalid review object or unknown fields.');
}

function text(value: unknown, max: number, empty: boolean, status: number): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), status, 'Invalid or oversized review text.');
}

function version(value: unknown, status: number): asserts value is string {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), status, 'Invalid review or document version.');
}

function anchor(value: unknown, status: number): asserts value is ReviewAnchor {
  object(value, ['blockId', 'quote', 'documentVersion'], status);
  if (value.blockId !== null) text(value.blockId, 1024, false, status);
  text(value.quote, 100_000, true, status);
  version(value.documentVersion, status);
  requireValue(value.blockId === null ? value.quote === '' : value.quote.trim().length > 0,
    status, 'A block anchor requires a quote; a document anchor requires null blockId and an empty quote.');
}

function message(value: Record<string, unknown>, status: number): void {
  text(value.id, 200, false, status);
  text(value.author, 200, false, status);
  text(value.body, 10_000, false, status);
  requireValue(typeof value.createdAt === 'string' && value.createdAt.length === 24 &&
    Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt,
  status, 'Invalid review timestamp.');
}

export function validateReviewFile(value: unknown, document: string): asserts value is ReviewFile {
  const status = 422;
  object(value, ['schemaVersion', 'document', 'threads'], status);
  requireValue(value.schemaVersion === 1, status, 'Unsupported review schemaVersion. Sidecar was not changed.');
  requireValue(value.document === document, status, 'Review sidecar belongs to a different document.');
  requireValue(Array.isArray(value.threads) && value.threads.length <= maxReviewThreads, status, 'Invalid review thread list.');
  const ids = new Set<string>();
  let messages = value.threads.length;
  for (const thread of value.threads) {
    object(thread, ['id', 'author', 'body', 'createdAt', 'status', 'anchor', 'replies'], status);
    message(thread, status);
    requireValue(!ids.has(thread.id as string), status, 'Duplicate review ID.');
    ids.add(thread.id as string);
    requireValue(thread.status === 'open' || thread.status === 'resolved', status, 'Invalid review status.');
    anchor(thread.anchor, status);
    requireValue(Array.isArray(thread.replies) && thread.replies.length <= maxReviewReplies, status, 'Invalid review replies.');
    messages += thread.replies.length;
    for (const reply of thread.replies) {
      object(reply, ['id', 'author', 'body', 'createdAt'], status);
      message(reply, status);
      requireValue(!ids.has(reply.id as string), status, 'Duplicate review ID.');
      ids.add(reply.id as string);
    }
  }
  requireValue(messages <= maxReviewMessages, status, 'Review message limit exceeded.');
}

export function validateReviewRequest(value: unknown): asserts value is ReviewRequest {
  object(value, ['path', 'version', 'action', 'author', 'body', 'threadId', 'anchor'], 400);
  text(value.path, 1024, false, 400);
  if (value.version !== null) version(value.version, 400);
  text(value.author, 200, false, 400);
  requireValue(['comment', 'reply', 'resolve', 'reopen'].includes(value.action as string), 400, 'Unknown review action.');
  if (value.action === 'comment') {
    text(value.body, 10_000, false, 400);
    anchor(value.anchor, 400);
    requireValue(!('threadId' in value), 400, 'Comments cannot specify a threadId.');
  } else {
    text(value.threadId, 200, false, 400);
    requireValue(!('anchor' in value), 400, 'Only new comments can specify an anchor.');
    if (value.action === 'reply') text(value.body, 10_000, false, 400);
    else requireValue(!('body' in value), 400, 'Status changes cannot specify a body.');
  }
}
