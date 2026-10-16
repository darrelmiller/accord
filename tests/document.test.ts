import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlDocument } from '../server/document.js';
import { resolveReference } from '../server/paths.js';

const html = '<!doctype html>\r\n<html lang="en"><head><meta charset="UTF-8"><title>Notes</title><script type="application/json" id="reviews">{"comment":"preserve <this>"}</script><style>p { color: red }</style></head><body><!-- keep --><h1 id="stable">Heading &amp; title</h1><p data-review="r1">Text <em>emphasis</em> after.</p><table><tbody><tr><td id="cell">A cell</td></tr></tbody></table><a href="other.html#section">Next</a><img src="assets/figure.png" alt="Local"></body></html>';
const known = new Set(['docs/main.html', 'docs/other.html']);

test('source ranges preserve all untouched bytes, links, review metadata, and IDs', () => {
  const model = new HtmlDocument(html, 'docs/main.html', known);
  assert.equal(model.view.editable, true, model.view.warnings.join('\n'));
  assert.equal(model.apply([]), html, 'no-op must not assign IDs or normalize whitespace');
  const heading = Object.entries(model.view.text).find(([, text]) => text === 'Heading & title')!;
  const cell = Object.entries(model.view.text).find(([, text]) => text === 'A cell')!;
  const updated = model.apply([{ id: heading[0], text: '<New> & "heading"' }, { id: cell[0], text: 'Changed cell' }]);
  assert.ok(updated.includes('<h1 id="stable">&lt;New&gt; &amp; &quot;heading&quot;</h1>'));
  assert.ok(updated.includes('<td id="cell">Changed cell</td>'));
  assert.ok(updated.includes('<!-- keep -->'));
  assert.ok(updated.includes('<script type="application/json" id="reviews">{"comment":"preserve <this>"}</script>'));
  assert.ok(updated.includes('<style>p { color: red }</style>'));
  assert.ok(updated.includes('href="other.html#section"'));
  assert.ok(updated.includes('src="assets/figure.png"'));
  assert.ok(updated.includes('\r\n'));
  assert.ok(!updated.includes('data-accord-text'));
  const reopened = new HtmlDocument(updated, 'docs/main.html', known);
  assert.equal(reopened.view.headings[0]?.id, 'stable');
  assert.equal(reopened.view.headings[0]?.text, '<New> & "heading"');
});

test('missing block IDs are persisted on meaningful save and remain stable across later edits', () => {
  const source = '<!doctype html><html><head><title>IDs</title></head><body><h1>First</h1><h2>Second</h2><p>Words</p></body></html>';
  const first = new HtmlDocument(source, 'main.html', new Set(['main.html']));
  const target = Object.entries(first.view.text).find(([, text]) => text === 'First')!;
  const saved = first.apply([{ id: target[0], text: 'Renamed' }]);
  const second = new HtmlDocument(saved, 'main.html', new Set(['main.html']));
  assert.deepEqual(second.view.headings.map(value => value.id), first.view.headings.map(value => value.id));
  assert.equal(second.apply([]), saved);
  assert.match(saved, /<p id="accord-[a-z0-9-]+">Words<\/p>/u);
});

test('UTF-8 BOM and CRLF are preserved with correctly shifted source ranges', () => {
  const source = '\uFEFF<!doctype html>\r\n<html><head><meta charset="UTF-8"></head><body><h1>Heading</h1><p id="text">Café</p></body></html>';
  const model = new HtmlDocument(source, 'a.html', new Set(['a.html']));
  assert.equal(model.view.editable, true);
  assert.equal(model.apply([]), source);
  const text = Object.entries(model.view.text).find(([, value]) => value === 'Café')!;
  const saved = model.apply([{ id: text[0], text: 'Café edited' }]);
  assert.ok(saved.startsWith('\uFEFF<!doctype html>\r\n'));
  assert.ok(saved.includes('<p id="text">Café edited</p>'));
  const reopened = new HtmlDocument(saved, 'a.html', new Set(['a.html']));
  assert.equal(reopened.view.editable, true);
  assert.equal(reopened.view.headings[0]?.id, model.view.headings[0]?.id);
});
test('active and unknown markup is read-only and is not installed into the preview', () => {
  for (const unsafe of [
    '<script>fetch("/api/save")</script>', '<p onclick="alert(1)">Text</p>',
    '<iframe src="/api/document"></iframe>', '<svg onload="alert(1)"></svg>',
    '<custom-element>Unknown</custom-element>', '<form action="/api/save"><input></form>'
  ]) {
    const model = new HtmlDocument(`<!doctype html><html><head><title>Unsafe</title></head><body><h1>Title</h1>${unsafe}</body></html>`, 'a.html', new Set(['a.html']));
    assert.equal(model.view.editable, false, unsafe);
    assert.throws(() => model.apply([]), /read-only/u);
    assert.doesNotMatch(model.view.html, /<(script|iframe|svg|custom-element|form)|onclick|onload/u);
  }
});

test('malformed HTML, duplicate IDs and omitted body boundaries are read-only', () => {
  for (const source of ['<h1>Fragment</h1>', '<!doctype html><html><head></head><body><h1 id="x">A</h1><p id="x">B</p></body></html>',
    '<!doctype html><html><head><meta charset="windows-1252"></head><body><h1>Encoding mismatch</h1></body></html>',
    '<!doctype html><html><body><table><p>Fostered text</p></table></body></html>']) {
    const model = new HtmlDocument(source, 'a.html', new Set(['a.html']));
    assert.equal(model.view.editable, false);
  }
});

test('invalid, duplicate and source-injecting edits cannot introduce markup', () => {
  const model = new HtmlDocument(html, 'docs/main.html', known);
  const id = Object.keys(model.view.text)[0]!;
  assert.throws(() => model.apply([{ id: 'not-a-target', text: 'X' }]), /Unknown/u);
  assert.throws(() => model.apply([{ id, text: 'X' }, { id, text: 'Y' }]), /duplicate/u);
  assert.throws(() => model.apply([{ id, text: 'bad\u0000text' }]), /Invalid/u);
  const injected = model.apply([{ id, text: '</h1><script>alert(1)</script>' }]);
  assert.ok(injected.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('references are workspace relative, normalize parents, and never permit hidden or system paths', () => {
  assert.deepEqual(resolveReference('docs/main.html', '../other.html#part%202'), { path: 'other.html', hash: 'part 2' });
  assert.deepEqual(resolveReference('docs/main.html', '#top'), { path: 'docs/main.html', hash: 'top' });
  for (const reference of ['../../escape.html', '../.git/config', '/etc/passwd', '//evil.test/x', 'https://evil.test',
    'javascript:alert(1)', '%2e%2e/%2e%2e/escape.html', '..\\secret', 'a%5cb.html', '../node_modules/a.html', 'file:///C:/secret']) {
    assert.equal(resolveReference('docs/main.html', reference), null, reference);
  }
});
