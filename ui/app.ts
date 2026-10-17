import type { DocumentView, Heading, WorkspaceInfo } from '../shared/model.js';
import type { ReviewView } from '../shared/review.js';

function required<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing application element: ${selector}`);
  return value;
}

const frame = required<HTMLIFrameElement>('#document-frame');
const saveButton = required<HTMLButtonElement>('#save');
const readButton = required<HTMLButtonElement>('#read');
const editButton = required<HTMLButtonElement>('#edit');
const reviewButton = required<HTMLButtonElement>('#review');
const reloadButton = required<HTMLButtonElement>('#reload');
const filter = required<HTMLInputElement>('#filter');
const rootInput = required<HTMLInputElement>('#root');
const dialog = required<HTMLDialogElement>('#unsaved');
const tokenParameter = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenParameter) {
  sessionStorage.setItem('accord-token', tokenParameter);
  history.replaceState(null, '', location.pathname + location.search);
}
const token = sessionStorage.getItem('accord-token') ?? '';
let workspace: WorkspaceInfo | undefined;
let current: DocumentView | undefined;
let editing = false;
let reviewing = false;
let reviews: ReviewView | undefined;
let reviewLoadError = '';
let selectedAnchor: { blockId: string | null; quote: string; documentVersion: string } | undefined;
let replyTo: string | undefined;
const commentBody = required<HTMLTextAreaElement>('#comment-body');
const authorInput = required<HTMLInputElement>('#review-author');
authorInput.value = sessionStorage.getItem('accord-review-author') ?? '';
let busy = false;
let dirty = false;
let activeSection = '';
let pendingNavigation: (() => Promise<void>) | undefined;

function isElement(target: EventTarget | null): target is Element {
  return target !== null && 'nodeType' in target && target.nodeType === 1;
}

function message(text: string, error = false): void {
  const box = required('#message');
  box.hidden = !text;
  box.classList.toggle('error', error);
  box.textContent = text;
}

async function api<T>(route: string, input?: object): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (workspace) headers['X-Accord-Workspace'] = workspace.id;
  if (input) headers['Content-Type'] = 'application/json';
  const response = await fetch(route, { method: input ? 'POST' : 'GET', headers, ...(input ? { body: JSON.stringify(input) } : {}) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Companion returned HTTP ${response.status}`);
  return result;
}

function updateControls(): void {
  saveButton.disabled = busy || !dirty || !current?.editable;
  editButton.disabled = busy || !current?.editable;
  reviewButton.disabled = busy || !current;
  readButton.disabled = busy || !current;
  reloadButton.disabled = busy || !current;
  required<HTMLButtonElement>('#open').disabled = busy;
  readButton.setAttribute('aria-pressed', String(!editing && !reviewing));
  editButton.setAttribute('aria-pressed', String(editing));
  reviewButton.setAttribute('aria-pressed', String(reviewing));
  const state = required('#save-state');
  state.textContent = busy ? 'Working…' : !current ? 'No document open' : dirty ? 'Unsaved changes · this tab only' : 'On disk · local working draft';
  state.classList.toggle('dirty', dirty);
  required('#editing-help').hidden = !editing;
  required('#review-panel').hidden = !reviewing;
  document.querySelector('.document-stage')?.classList.toggle('with-review', reviewing);
  frame.contentDocument?.body.classList.toggle('reviewing', reviewing);
  for (const block of frame.contentDocument?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],p[id],li[id],dt[id],dd[id],th[id],td[id],caption[id],figcaption[id],blockquote[id],pre[id]') ?? []) {
    if (reviewing && !busy) {
      block.tabIndex = 0;
      block.dataset.accordReviewBlock = '';
    } else {
      block.removeAttribute('tabindex');
      block.removeAttribute('data-accord-review-block');
    }
  }
  required<HTMLFieldSetElement>('#comment-fields').disabled = busy;
  required<HTMLButtonElement>('#refresh-reviews').disabled = busy;
  required<HTMLButtonElement>('#save-comment').disabled = busy || !reviews || !commentBody.value.trim() || !authorInput.value.trim();
  for (const button of document.querySelectorAll<HTMLButtonElement>('#review-threads button')) button.disabled = busy;
  required('#comment-state').textContent = commentDirty() ? 'Unsaved review draft · this tab only' : 'No unsaved comment';
  for (const node of textNodes()) {
    const canEdit = editing && !busy;
    node.contentEditable = canEdit ? 'plaintext-only' : 'false';
    if (canEdit) {
      node.setAttribute('role', 'textbox');
      node.setAttribute('aria-label', 'Editable document text');
      node.setAttribute('aria-multiline', 'false');
    } else {
      node.removeAttribute('role');
      node.removeAttribute('aria-label');
      node.removeAttribute('aria-multiline');
    }
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateControls();
  try { await action(); }
  catch (error) { message(error instanceof Error ? error.message : 'Unexpected browser error.', true); }
  finally { busy = false; updateControls(); }
}

function textNodes(): HTMLElement[] {
  return [...(frame.contentDocument?.querySelectorAll<HTMLElement>('[data-accord-text]') ?? [])];
}

function collectEdits(): { id: string; text: string }[] {
  if (!current) return [];
  return textNodes().map(node => ({ id: node.dataset.accordText!, text: node.textContent ?? '' }))
    .filter(edit => current?.text[edit.id] !== edit.text);
}

function setMode(value: boolean): void {
  editing = value && !!current?.editable;
  reviewing = false;
  clearCommentDraft();
  highlightAnchors();
  updateControls();
}

function commentDirty(): boolean {
  return !!commentBody.value;
}

function clearCommentDraft(): void {
  commentBody.value = '';
  replyTo = undefined;
  selectedAnchor = undefined;
  updateCommentTarget();
}

function updateCommentTarget(): void {
  required('#comment-target').textContent = replyTo ? 'Reply to existing thread' :
    selectedAnchor?.blockId ? `Passage in #${selectedAnchor.blockId}` : 'Whole document';
  const quote = required('#comment-quote');
  quote.hidden = !selectedAnchor?.quote;
  quote.textContent = selectedAnchor?.quote ?? '';
  required('#comment-label').textContent = replyTo ? 'Your reply' : 'New comment';
  required<HTMLButtonElement>('#save-comment').textContent = replyTo ? 'Save reply locally' : 'Save comment locally';
  required('#cancel-reply').hidden = !replyTo;
  required<HTMLButtonElement>('#document-comment').disabled = !!replyTo;
  highlightAnchors();
}

function highlightAnchors(): void {
  const content = frame.contentDocument;
  if (!content) return;
  for (const node of content.querySelectorAll('[data-accord-anchored],[data-accord-selected]')) {
    node.removeAttribute('data-accord-anchored');
    node.removeAttribute('data-accord-selected');
  }
  if (!reviewing) return;
  for (const thread of reviews?.threads ?? []) {
    if (thread.anchor.blockId && thread.anchorState === 'current' && thread.status === 'open') {
      content.getElementById(thread.anchor.blockId)?.setAttribute('data-accord-anchored', '');
    }
  }
  if (selectedAnchor?.blockId) content.getElementById(selectedAnchor.blockId)?.setAttribute('data-accord-selected', '');
}

function renderReviews(): void {
  const list = required('#review-threads');
  list.replaceChildren();
  const error = required('#review-error');
  error.hidden = !reviewLoadError;
  error.textContent = reviewLoadError;
  required('#review-baseline').textContent = current ? `Document baseline ${current.version.slice(0, 12)} · local working draft` : '';
  const threads = reviews?.threads ?? [];
  required('#review-count').textContent = `(${threads.filter(thread => thread.status === 'open').length} open)`;
  const showResolved = required<HTMLInputElement>('#show-resolved').checked;
  for (const thread of threads.filter(thread => showResolved || thread.status === 'open')) {
    const card = document.createElement('article');
    card.className = 'review-thread';
    card.dataset.threadId = thread.id;
    const state = document.createElement('span');
    state.className = 'thread-state';
    const anchorLabel = { current: 'Passage matched', stale: 'Stale / ambiguous passage · check source', missing: 'Target missing · check source', document: 'Whole document' };
    state.textContent = `${thread.status === 'open' ? 'Open' : 'Resolved'} · ${anchorLabel[thread.anchorState]}`;
    card.append(state);
    const appendMessage = (entry: { author: string; body: string; createdAt: string }, reply = false) => {
      const container = document.createElement('div');
      if (reply) container.className = 'reply';
      const name = document.createElement('h3');
      name.textContent = `${entry.author} · unverified`;
      const time = document.createElement('time');
      time.dateTime = entry.createdAt;
      time.textContent = new Date(entry.createdAt).toLocaleString();
      const body = document.createElement('p');
      body.textContent = entry.body;
      container.append(name, time, body);
      card.append(container);
    };
    if (thread.anchor.quote) {
      const quote = document.createElement('blockquote');
      quote.textContent = thread.anchor.quote;
      card.append(quote);
    }
    appendMessage(thread);
    thread.replies.forEach(reply => appendMessage(reply, true));
    const actions = document.createElement('div');
    actions.className = 'thread-actions';
    const button = (label: string, action: () => void) => {
      const value = document.createElement('button');
      value.type = 'button';
      value.className = 'quiet';
      value.textContent = label;
      value.disabled = busy;
      value.addEventListener('click', action);
      actions.append(value);
    };
    if (thread.anchor.blockId && thread.anchorState === 'current') {
      button('Go to passage', () => {
        scrollToSection(thread.anchor.blockId!);
      });
    }
    button('Reply', () => navigate(async () => {
      clearCommentDraft();
      replyTo = thread.id;
      selectedAnchor = thread.anchor;
      updateCommentTarget();
      commentBody.focus();
    }));
    button(thread.status === 'open' ? 'Resolve' : 'Reopen', () => {
      void run(async () => {
        if (!authorInput.value.trim()) throw new Error('Enter your unverified display name before updating a thread.');
        await mutateReview(thread.status === 'open' ? 'resolve' : 'reopen', { threadId: thread.id });
      });
    });
    card.append(actions);
    list.append(card);
  }
  if (reviews && !list.childElementCount) list.textContent = threads.length ? 'No open threads. Resolved threads are hidden.' : 'No comments yet. Start a local discussion.';
  highlightAnchors();
}

async function refreshReviews(): Promise<void> {
  if (!current) return;
  try {
    const loaded = await api<ReviewView>(`/api/reviews?path=${encodeURIComponent(current.path)}`);
    reviews = loaded;
    reviewLoadError = '';
  } catch (error) {
    reviews = undefined;
    reviewLoadError = error instanceof Error ? error.message : 'Could not load review sidecar.';
    throw error;
  } finally { renderReviews(); }
}

async function enterReview(): Promise<void> {
  if (!current) return;
  // Re-read disk before starting a review; navigation guard settles any local text draft first.
  await loadDocument(current.path);
  reviewing = true;
  editing = false;
  updateControls();
  await refreshReviews();
}

async function mutateReview(action: 'comment' | 'reply' | 'resolve' | 'reopen', details: object): Promise<void> {
  if (!current || !reviews) throw new Error('Refresh the review sidecar before saving.');
  reviews = await api<ReviewView>('/api/reviews', {
    path: current.path, version: reviews.version, action, author: authorInput.value.trim(), ...details
  });
  sessionStorage.setItem('accord-review-author', authorInput.value.trim());
  renderReviews();
  message('Review saved locally in the document’s .accord-review.json sidecar. Nothing was submitted or published.');
}

async function saveCommentDraft(): Promise<void> {
  if (!commentDirty()) return;
  if (!authorInput.value.trim()) throw new Error('Enter your unverified display name before saving a comment.');
  if (!commentBody.value.trim()) throw new Error('A comment cannot be only whitespace. Keep editing or explicitly discard it.');
  await mutateReview(replyTo ? 'reply' : 'comment', {
    body: commentBody.value,
    ...(replyTo ? { threadId: replyTo } : {
      anchor: selectedAnchor ?? { blockId: null, quote: '', documentVersion: current!.version }
    })
  });
  clearCommentDraft();
  highlightAnchors();
}

function captureAnchor(target: EventTarget | null, useSelection: boolean): void {
  if (!reviewing || busy || replyTo || !current) return;
  const content = frame.contentDocument;
  if (!content) return;
  const selection = content.getSelection();
  const selectionNode = selection?.anchorNode;
  const start = useSelection && selection && !selection.isCollapsed ?
    (selectionNode?.nodeType === 1 ? selectionNode as Element : selectionNode?.parentElement) :
    isElement(target) ? target : null;
  const block = start?.closest<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,caption,figcaption,blockquote,pre');
  if (!block?.id) return;
  if (useSelection && selection && !selection.isCollapsed && selection.focusNode && !block.contains(selection.focusNode)) {
    message('Select text within one existing block to anchor a comment.');
    return;
  }
  const quote = useSelection && selection && !selection.isCollapsed ? selection.toString() : block.textContent ?? '';
  if (!quote.trim() || quote.length > 10_000) { message('Select a passage of at most 10,000 characters.'); return; }
  selectedAnchor = { blockId: block.id, quote, documentVersion: current.version };
  updateCommentTarget();
}

function updateActiveSection(id: string): void {
  activeSection = id;
  for (const link of document.querySelectorAll<HTMLElement>('#toc a')) {
    if (link.dataset.section === id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function scrollToSection(id: string): void {
  const target = frame.contentDocument?.getElementById(id);
  if (target) {
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    updateActiveSection(id);
  } else if (id) message(`Section "${id}" is not available in this document.`, true);
}

function updateToc(): void {
  const toc = required('#toc');
  toc.replaceChildren();
  const headings: Heading[] = [...(frame.contentDocument?.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6') ?? [])]
    .map(node => ({ id: node.id, level: Number(node.tagName.slice(1)), text: node.textContent?.trim() || 'Untitled section' }));
  const list = document.createElement('ul');
  const stack: { level: number; list: HTMLUListElement; last?: HTMLLIElement }[] = [{ level: headings[0]?.level ?? 1, list }];
  for (const heading of headings) {
    while (stack.length > 1 && stack.at(-1)!.level > heading.level) stack.pop();
    let parent = stack.at(-1)!;
    if (heading.level > parent.level && parent.last) {
      const nested = document.createElement('ul');
      parent.last.append(nested);
      parent = { level: heading.level, list: nested };
      stack.push(parent);
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.dataset.section = heading.id;
    link.textContent = heading.text;
    link.addEventListener('click', event => { event.preventDefault(); scrollToSection(heading.id); });
    item.append(link);
    parent.list.append(item);
    parent.last = item;
  }
  if (headings.length) toc.append(list);
  else toc.textContent = 'No headings in this document.';
  updateActiveSection(activeSection || headings[0]?.id || '');
}

function showInfo(): void {
  if (!current) return;
  required('#info-section').hidden = false;
  required('#contents-section').hidden = false;
  const info = required('#info');
  info.replaceChildren();
  for (const [name, value] of [
    ['Title', current.title], ['Path', current.path], ['Context', 'Local working draft · not a review snapshot'],
    ['Disk fingerprint', current.version.slice(0, 12)], ['Editing profile', current.editable ? 'Text within existing HTML structure' : 'Read-only · unsupported HTML'],
    ['Embedded JSON records', `${current.reviewRecords} preserved (uninterpreted); new comments use a separate sidecar`]
  ]) {
    const term = document.createElement('dt');
    term.textContent = name!;
    const description = document.createElement('dd');
    description.textContent = value!;
    info.append(term, description);
  }
}

async function display(view: DocumentView, hash = ''): Promise<void> {
  reviewing = false;
  reviews = undefined;
  reviewLoadError = '';
  clearCommentDraft();
  current = view;
  dirty = false;
  activeSection = '';
  editing = false;
  required('#welcome').hidden = true;
  const warnings = required('#warnings');
  warnings.hidden = false;
  warnings.textContent = [
    ...(view.editable ? [] : ['READ-ONLY: unsupported content is preserved on disk, not made editable.']),
    ...view.warnings,
    'Safe reading layout: original CSS is preserved in source but not applied. Scripts, embedded pages, forms, remote resources, and active links are never executed.'
  ].join(' ');
  showInfo();
  frame.hidden = false;
  const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  frame.srcdoc = `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src ${location.origin}; img-src data:; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${location.origin}/styles.css"></head><body class="document">${view.html}</body></html>`;
  await loaded;
  const content = frame.contentDocument;
  if (!content) throw new Error('Isolated preview could not be opened.');
  content.body.style.fontSize = `${required<HTMLInputElement>('#font-size').value}px`;
  content.addEventListener('input', () => {
    dirty = collectEdits().length > 0;
    updateControls();
    updateToc();
  });
  content.addEventListener('beforeinput', event => {
    const input = event as InputEvent;
    if (input.inputType === 'insertParagraph' || input.inputType === 'insertLineBreak' || input.inputType.startsWith('format')) {
      event.preventDefault();
      message('This slice edits existing text only. New blocks and formatting changes require a source editor.');
    }
  });
  content.addEventListener('paste', event => {
    const plainText = event.clipboardData?.getData('text/plain');
    if (plainText === undefined || /[\r\n]/u.test(plainText)) {
      event.preventDefault();
      message('Multi-line paste is outside this text-run editing profile. Paste one line at a time or use a source editor.');
    }
  });
  content.addEventListener('drop', event => { event.preventDefault(); message('Drag and drop is disabled to preserve document structure.'); });
  content.addEventListener('mouseup', event => { captureAnchor(event.target, true); });
  content.addEventListener('keyup', event => {
    if (event.key.startsWith('Arrow') && event.shiftKey) captureAnchor(event.target, true);
  });
  content.addEventListener('keydown', event => {
    if (event.key === 'Enter' && reviewing && isElement(event.target) &&
        event.target.hasAttribute('data-accord-review-block')) {
      event.preventDefault();
      captureAnchor(event.target, false);
      commentBody.focus();
    }
  });
  content.addEventListener('click', event => {
    const target = isElement(event.target) ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a');
    if (!link) {
      if (content.getSelection()?.isCollapsed) captureAnchor(event.target, false);
      return;
    }
    event.preventDefault();
    if (editing || reviewing) return;
    const path = link.dataset.accordLink;
    if (!path) { message('External, missing, and non-document links are not opened by this local prototype.'); return; }
    const hash = link.dataset.accordHash ?? '';
    if (path === current?.path) scrollToSection(hash);
    else navigate(() => loadDocument(path, hash));
  });
  frame.contentWindow?.addEventListener('scroll', () => {
    const headings = [...content.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6')];
    const visible = headings.filter(node => node.getBoundingClientRect().top <= 120).at(-1) ?? headings[0];
    if (visible) updateActiveSection(visible.id);
  }, { passive: true });
  setMode(false);
  updateToc();
  if (hash) scrollToSection(hash);
  renderDocuments();
}

async function loadDocument(path: string, hash = ''): Promise<void> {
  const view = await api<DocumentView>(`/api/document?path=${encodeURIComponent(path)}`);
  await display(view, hash);
  message('');
}

async function save(): Promise<void> {
  if (!current || !dirty) return;
  const result = await api<{ document: DocumentView; recovery: string | null }>('/api/save', {
    path: current.path, version: current.version, edits: collectEdits()
  });
  const wasEditing = editing;
  await display(result.document);
  setMode(wasEditing);
  message(result.recovery ? `Saved locally. Previous bytes are recoverable at: ${result.recovery}` : 'Already up to date.');
}

function navigate(action: () => Promise<void>): void {
  if (busy) return;
  if (dirty || commentDirty()) {
    pendingNavigation = action;
    dialog.showModal();
  } else void run(action);
}

function renderDocuments(): void {
  const navigation = required('#documents');
  navigation.replaceChildren();
  const paths = workspace?.documents.filter(path => path.toLowerCase().includes(filter.value.toLowerCase())) ?? [];
  for (const path of paths) {
    const button = document.createElement('button');
    button.className = 'quiet';
    button.textContent = path;
    if (path === current?.path) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      if (path !== current?.path) navigate(() => loadDocument(path));
    });
    navigation.append(button);
  }
  if (!paths.length) navigation.textContent = 'No matching HTML documents.';
}

required<HTMLFormElement>('#open-form').addEventListener('submit', event => {
  event.preventDefault();
  navigate(async () => {
    const opened = await api<WorkspaceInfo>('/api/workspace', { root: rootInput.value });
    workspace = opened;
    current = undefined;
    dirty = false;
    editing = false;
    reviewing = false;
    reviews = undefined;
    reviewLoadError = '';
    clearCommentDraft();
    frame.hidden = true;
    frame.srcdoc = '';
    required('#welcome').hidden = false;
    required('#info-section').hidden = true;
    required('#contents-section').hidden = true;
    required('#warnings').hidden = true;
    required('#workspace-label').textContent = opened.root;
    required('#document-count').textContent = `(${opened.documents.length})`;
    filter.disabled = false;
    filter.value = '';
    renderDocuments();
    message(`Opened ${opened.documents.length} HTML documents. No Git state was changed.`);
  });
});
filter.addEventListener('input', renderDocuments);
readButton.addEventListener('click', () => {
  if (commentDirty()) navigate(async () => { setMode(false); });
  else setMode(false);
});
editButton.addEventListener('click', () => {
  const edit = async () => { setMode(true); textNodes()[0]?.focus(); };
  if (commentDirty()) navigate(edit);
  else void edit();
});
reviewButton.addEventListener('click', () => { navigate(enterReview); });
saveButton.addEventListener('click', () => { void run(save); });
reloadButton.addEventListener('click', () => { if (current) navigate(() => loadDocument(current!.path)); });
required('#stay').addEventListener('click', () => { pendingNavigation = undefined; dialog.close(); });
dialog.addEventListener('cancel', () => { pendingNavigation = undefined; });
required('#discard').addEventListener('click', () => {
  const action = pendingNavigation;
  pendingNavigation = undefined;
  dialog.close();
  if (action) void run(action);
});
required('#save-continue').addEventListener('click', () => {
  const action = pendingNavigation;
  pendingNavigation = undefined;
  dialog.close();
  void run(async () => { await save(); await saveCommentDraft(); if (action) await action(); });
});
required('#theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  if (frame.contentDocument) frame.contentDocument.documentElement.dataset.theme = theme;
});
required('#font-size').addEventListener('input', event => {
  if (frame.contentDocument) frame.contentDocument.body.style.fontSize = `${(event.target as HTMLInputElement).value}px`;
});
required('#copy-link').addEventListener('click', () => {
  if (!current) return;
  const params = new URLSearchParams({ document: current.path, section: activeSection });
  void run(async () => {
    await navigator.clipboard.writeText(`${location.origin}/#${params}`);
    message('Section link copied. It works in an authorized tab with this workspace open; it is not a sharing or publication link.');
  });
});
window.addEventListener('beforeunload', event => {
  if (dirty || commentDirty()) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const path = params.get('document');
  const hash = params.get('section') ?? '';
  if (path && workspace?.documents.includes(path)) navigate(() => loadDocument(path, hash));
});
if (!token) message('Open the private launch URL printed by npm start to authorize this tab.', true);
commentBody.addEventListener('input', updateControls);
authorInput.addEventListener('input', updateControls);
required<HTMLFormElement>('#comment-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(saveCommentDraft);
});
required('#refresh-reviews').addEventListener('click', () => { void run(refreshReviews); });
required('#document-comment').addEventListener('click', () => { selectedAnchor = undefined; updateCommentTarget(); });
required('#cancel-reply').addEventListener('click', () => {
  navigate(async () => { clearCommentDraft(); });
});
required('#show-resolved').addEventListener('change', renderReviews);
updateControls();
