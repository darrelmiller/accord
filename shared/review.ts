/** Authors are locally declared display names, not authenticated identities. */
export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewAnchor {
  /** New block comments require a persisted, unique source ID; null means document-level. */
  blockId: string | null;
  /** Exact decoded block text or selection, occurring once in that block; empty for document-level. */
  quote: string;
  documentVersion: string;
}

export interface ReviewThread extends ReviewReply {
  status: 'open' | 'resolved';
  anchor: ReviewAnchor;
  replies: ReviewReply[];
}

/** Stored alongside the HTML as <document>.accord-review.json; never embedded. */
export interface ReviewFile {
  schemaVersion: 1;
  document: string;
  threads: ReviewThread[];
}

export type AnchorState = 'current' | 'stale' | 'missing' | 'document';

export interface ReviewView {
  /** SHA-256 of the sidecar bytes, or null when no sidecar exists. */
  version: string | null;
  threads: (ReviewThread & { anchorState: AnchorState })[];
}

export interface ReviewRequest {
  path: string;
  version: string | null;
  action: 'comment' | 'reply' | 'resolve' | 'reopen';
  author: string;
  body?: string;
  threadId?: string;
  anchor?: ReviewAnchor;
}
