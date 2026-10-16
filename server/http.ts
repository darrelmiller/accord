import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SaveRequest } from '../shared/model.js';
import { AccordError, requireValue } from './errors.js';
import { Workspace } from './workspace.js';

export async function startCompanion(port = 0) {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let workspace: Workspace | undefined;
  let pending: Promise<void> = Promise.resolve();
  const index = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const themeScript = index.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  requireValue(themeScript, 500, 'Missing theme bootstrap.');
  const themeHash = createHash('sha256').update(themeScript).digest('base64');
  const publicFiles = new Map([
    ['/', [new URL('../ui/index.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/styles.css', [new URL('../ui/styles.css', import.meta.url), 'text/css; charset=utf-8']],
    ['/app.js', [new URL('../browser/ui/app.js', import.meta.url), 'text/javascript; charset=utf-8']]
  ] as const);

  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    requireValue(request.headers['content-type'] === 'application/json', 415, 'Use application/json.');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) {
        request.resume();
        throw new AccordError(413, 'Request exceeds the 3 MiB limit.');
      }
      chunks.push(chunk);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AccordError(400, 'Invalid JSON request.'); }
    requireValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'JSON object required.');
    return parsed as Record<string, unknown>;
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'sha256-${themeHash}'; style-src 'self'; connect-src 'self'; frame-src 'self' about:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    try {
      requireValue(request.headers.host === new URL(origin).host, 403, 'Unrecognized loopback host.');
      const url = new URL(request.url ?? '/', origin);
      const file = publicFiles.get(url.pathname as '/');
      if (file && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': file[1] });
        response.end(await readFile(file[0]));
        return;
      }
      requireValue(url.pathname.startsWith('/api/'), 404, 'Not found.');
      const supplied = request.headers.authorization?.replace(/^Bearer /u, '') ?? '';
      requireValue(/^[a-f0-9]{64}$/u.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token)), 401,
        'Open the launch URL printed by the companion to authorize this browser tab.');
      requireValue(!request.headers.origin || request.headers.origin === origin, 403, 'Cross-site requests are not allowed.');
      if (request.method === 'POST') {
        requireValue(request.headers.origin === origin, 403, 'Modifying requests require the companion origin.');
      }
      if (url.pathname === '/api/workspace' && request.method === 'POST') {
        const input = await body(request);
        const opened = await Workspace.open(input.root);
        workspace = opened;
        json(response, 200, workspace.info);
        return;
      }
      requireValue(workspace, 409, 'Open a local workspace first.');
      requireValue(request.headers['x-accord-workspace'] === workspace.id, 409,
        'The workspace was switched in another tab. Reopen your intended workspace before continuing.');
      if (url.pathname === '/api/document' && request.method === 'GET') {
        json(response, 200, await workspace.load(url.searchParams.get('path') ?? ''));
      } else if (url.pathname === '/api/save' && request.method === 'POST') {
        const input = await body(request);
        requireValue(typeof input.path === 'string' && typeof input.version === 'string' && Array.isArray(input.edits),
          400, 'Save requires path, version, and edits.');
        const edits: SaveRequest['edits'] = input.edits.map((edit: unknown) => {
          requireValue(edit && typeof edit === 'object' && 'id' in edit && 'text' in edit &&
            typeof edit.id === 'string' && typeof edit.text === 'string', 400, 'Each edit requires a text target and plain text.');
          return { id: edit.id, text: edit.text };
        });
        json(response, 200, await workspace.save({ path: input.path, version: input.version, edits }));
      } else {
        throw new AccordError(404, 'Unknown API or method.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown companion error';
      const status = error instanceof AccordError ? error.status : 500;
      if (status >= 500) console.error('Accord request failed:', error);
      if (!response.headersSent) json(response, status, { error: message });
      else response.destroy();
    }
  };
  const server = createServer((request, response) => {
    // Serialize workspace switching and saves, including requests from multiple tabs.
    pending = pending.then(() => handle(request, response));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, token };
}
