import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { DocumentView, Heading, TextEdit } from '../shared/model.js';
import { requireValue } from './errors.js';
import { resolveReference } from './paths.js';
import { themeBootstrap } from '../shared/theme.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];
const tags = new Set('html head body title meta link style script article section header footer main aside nav div span h1 h2 h3 h4 h5 h6 p a strong em b i u s small sub sup mark abbr time code pre blockquote ul ol li dl dt dd table caption thead tbody tfoot tr th td figure figcaption img br hr'.split(' '));
const blocks = new Set('h1 h2 h3 h4 h5 h6 p li dt dd th td caption figcaption blockquote pre'.split(' '));
const voidTags = new Set(['meta', 'link', 'img', 'br', 'hr']);
const omitted = new Set(['head', 'script', 'style', 'meta', 'link', 'title']);
const safeAttributes = new Set('id class title lang dir href src alt width height colspan rowspan scope start reversed type datetime cite rel target name content charset http-equiv media style role'.split(' '));
const maxTextLength = 100_000;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function versionOf(source: string | Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function element(node: Node): node is Element {
  return 'tagName' in node;
}

function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function attr(node: Element, name: string): string | undefined {
  return node.attrs.find(attribute => attribute.name === name)?.value;
}

function textContent(node: Node): string {
  return node.nodeName === '#text' ? (node as TextNode).value : children(node).map(textContent).join('');
}

interface Patch { start: number; end: number; text: string }

export class HtmlDocument {
  readonly view: DocumentView;
  readonly images = new Map<string, string>();
  private readonly textRanges = new Map<string, { start: number; end: number; text: string }>();
  private readonly identityPatches: Patch[] = [];

  constructor(readonly source: string, readonly path: string, knownDocuments: Set<string>) {
    const warnings = new Set<string>();
    const sourceOffset = source.startsWith('\uFEFF') ? 1 : 0;
    const tree = parse(source.slice(sourceOffset), {
      sourceCodeLocationInfo: true,
      onParseError: error => warnings.add(`HTML parser: ${error.code}. Repair the source to enable editing.`)
    });
    const ids = new Set<string>();
    const headings: Heading[] = [];
    let title = path;
    let reviewRecords = 0;
    const visit = (node: Node, inspect: (value: Node) => void): void => {
      inspect(node);
      children(node).forEach(child => visit(child, inspect));
    };
    visit(tree, node => {
      let lastEnd = -1;
      for (const child of children(node)) {
        const location = child.sourceCodeLocation;
        if (!location) continue;
        if (location.startOffset < lastEnd) {
          warnings.add('Browser-repaired source ordering is unsupported. Repair the HTML before editing.');
        }
        lastEnd = location.endOffset;
      }
      if (!element(node)) return;
      const id = attr(node, 'id');
      if (id) {
        if (ids.has(id)) warnings.add('Duplicate IDs must be repaired before editing.');
        ids.add(id);
      }
      if (!tags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        warnings.add(`Unsupported <${node.tagName}> markup: read-only preview.`);
      }
      if (node.tagName === 'title') title = textContent(node);
      if (node.tagName === 'script') {
        if (attr(node, 'type') === 'application/json' && !attr(node, 'src')) reviewRecords++;
        else if (!attr(node, 'src') && textContent(node).trim() === themeBootstrap) {
          // Preserve the standalone document theme initializer, but never render scripts.
        }
        else warnings.add('Active scripts are disabled. This document is read-only.');
      }
      if (node.tagName === 'meta' && attr(node, 'http-equiv')) {
        warnings.add('HTTP-equivalent metadata is disabled. This document is read-only.');
      }
      if (node.tagName === 'meta' && attr(node, 'charset') &&
          !/^utf-?8$/iu.test(attr(node, 'charset')!)) {
        warnings.add('Only UTF-8 encoding declarations are supported. This document is read-only.');
      }
      for (const attribute of node.attrs) {
        if (!safeAttributes.has(attribute.name) && !/^(data-|aria-)/u.test(attribute.name)) {
          warnings.add(`Unsupported attribute "${attribute.name}": read-only preview.`);
        }
        if (attribute.name.startsWith('on') || attribute.namespace) {
          warnings.add('Active attributes are disabled. This document is read-only.');
        }
      }
      if (node.tagName === 'html' || node.tagName === 'body') {
        if (!node.sourceCodeLocation?.startTag || !node.sourceCodeLocation.endTag) {
          warnings.add('Editing requires explicit <html> and <body> start and end tags.');
        }
      }
    });
    const identity = new Map<Element, string>();
    visit(tree, node => {
      if (!element(node) || !blocks.has(node.tagName)) return;
      let id = attr(node, 'id');
      const startTag = node.sourceCodeLocation?.startTag;
      if (!id && startTag) {
        const base = `accord-${(startTag.startOffset + sourceOffset).toString(36)}`;
        id = base;
        let suffix = 1;
        while (ids.has(id)) id = `${base}-${suffix++}`;
        ids.add(id);
        this.identityPatches.push({ start: startTag.endOffset - 1 + sourceOffset, end: startTag.endOffset - 1 + sourceOffset, text: ` id="${id}"` });
      }
      if (id) identity.set(node, id);
      if (/^h[1-6]$/u.test(node.tagName) && id) {
        headings.push({ id, level: Number(node.tagName.slice(1)), text: textContent(node).trim() });
      }
    });
    const render = (node: Node, inBody: boolean): string => {
      if (node.nodeName === '#text') {
        const value = (node as TextNode).value;
        const range = node.sourceCodeLocation;
        if (inBody && value.trim() && range) {
          const id = `text-${range.startOffset + sourceOffset}`;
          this.textRanges.set(id, { start: range.startOffset + sourceOffset, end: range.endOffset + sourceOffset, text: value });
          return `<span data-accord-text="${id}">${escapeHtml(value)}</span>`;
        }
        return escapeHtml(value);
      }
      if (!element(node)) return children(node).map(child => render(child, inBody)).join('');
      if (omitted.has(node.tagName)) return '';
      if (node.tagName === 'html' || node.tagName === 'body') {
        return children(node).map(child => render(child, inBody || node.tagName === 'body')).join('');
      }
      // Unknown markup is never installed as live DOM, even in read-only mode.
      if (!tags.has(node.tagName)) return escapeHtml(textContent(node));
      const attributes: string[] = [];
      const id = identity.get(node) ?? attr(node, 'id');
      if (id) attributes.push(`id="${escapeHtml(id)}"`);
      for (const name of ['title', 'lang', 'dir', 'alt', 'width', 'height', 'colspan', 'rowspan', 'scope', 'start']) {
        const value = attr(node, name);
        if (value !== undefined) attributes.push(`${name}="${escapeHtml(value)}"`);
      }
      if (node.tagName === 'a') {
        const href = attr(node, 'href') ?? '';
        const reference = resolveReference(path, href);
        if (reference && knownDocuments.has(reference.path)) {
          attributes.push(`href="#${escapeHtml(reference.hash)}"`, `data-accord-link="${escapeHtml(reference.path)}"`,
            `data-accord-hash="${escapeHtml(reference.hash)}"`);
        } else {
          attributes.push('data-accord-unavailable="true"', `title="${escapeHtml(`Unavailable or external link: ${href}`)}"`);
        }
      }
      if (node.tagName === 'img') {
        const src = attr(node, 'src') ?? '';
        const reference = resolveReference(path, src);
        if (reference && /\.(png|jpe?g|gif|webp)$/iu.test(reference.path)) {
          const imageId = `image-${this.images.size}`;
          this.images.set(imageId, reference.path);
          attributes.push(`data-accord-image="${imageId}"`);
        } else {
          attributes.push('data-accord-unavailable="true"');
        }
      }
      const open = `<${node.tagName}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
      return open + (voidTags.has(node.tagName) ? '' : children(node).map(child => render(child, inBody)).join('') + `</${node.tagName}>`);
    };
    const html = render(tree, false);
    this.view = {
      path, title, version: versionOf(source), editable: warnings.size === 0,
      warnings: [...warnings], html, headings,
      text: Object.fromEntries([...this.textRanges].map(([id, range]) => [id, range.text])),
      reviewRecords
    };
  }

  apply(edits: TextEdit[]): string {
    requireValue(this.view.editable, 422, 'Unsupported HTML is read-only. No changes were written.');
    requireValue(Array.isArray(edits) && edits.length <= this.textRanges.size, 400, 'Invalid text edit list.');
    const seen = new Set<string>();
    const patches: Patch[] = [];
    for (const edit of edits) {
      requireValue(edit && typeof edit.id === 'string' && typeof edit.text === 'string' &&
        edit.text.length <= maxTextLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\r]/u.test(edit.text),
      400, 'Invalid text replacement. Use plain text without control characters.');
      const range = this.textRanges.get(edit.id);
      requireValue(range && !seen.has(edit.id), 400, 'Unknown or duplicate text target.');
      seen.add(edit.id);
      if (edit.text !== range.text) {
        patches.push({ start: range.start, end: range.end, text: escapeHtml(edit.text) });
      }
    }
    if (!patches.length) return this.source;
    patches.push(...this.identityPatches);
    let result = this.source;
    for (const patch of patches.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
    }
    return result;
  }
}
