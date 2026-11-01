import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const root = fileURLToPath(new URL('../', import.meta.url));
const documents = ['docs/PRD.html', 'examples/handbook.html', 'examples/notes/decisions.html'];
const assets = ['ui/styles.css', 'examples/assets/workflow.png'];

export function removeReviewRecords(source) {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const ranges = [];
  const visit = node => {
    if (node.tagName === 'script' && node.attrs.some(attr => attr.name === 'type' && attr.value === 'application/json')) {
      const location = node.sourceCodeLocation;
      if (!location) throw new Error('Cannot locate embedded review metadata for redaction.');
      ranges.push(location);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(tree);
  for (const range of ranges.sort((a, b) => b.startOffset - a.startOffset)) {
    source = source.slice(0, range.startOffset) + source.slice(range.endOffset);
  }
  return source;
}

export async function buildPages(output) {
  // An explicit allowlist prevents a new source file or review sidecar being published accidentally.
  for (const filename of [...documents, ...assets]) {
    const destination = path.join(output, ...filename.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    if (documents.includes(filename)) {
      const source = await readFile(path.join(root, ...filename.split('/')), 'utf8');
      await writeFile(destination, removeReviewRecords(source), 'utf8');
    } else {
      await copyFile(path.join(root, ...filename.split('/')), destination);
    }
  }
  await writeFile(path.join(output, '.nojekyll'), '');
  await writeFile(path.join(output, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=docs/PRD.html"><title>Accord documentation</title></head>
<body><p><a href="docs/PRD.html">Read the Accord product requirements</a></p>
<p><a href="examples/handbook.html">Read the sample handbook</a></p></body></html>
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPages(path.join(root, 'dist', 'pages'));
  console.log('Selected documentation published to dist/pages (review records excluded).');
}
