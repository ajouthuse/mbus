import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Bus, BusError, type BusOptions } from './bus.js';
import { createTools } from './tools.js';

export interface ServerOptions {
  port?: number;
  databasePath?: string;
  bus?: Omit<BusOptions, 'databasePath'>;
  maxSessions?: number;
  sessionIdleMs?: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function fail(res: ServerResponse, status: number, message: string) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  } else if (!res.writableEnded) res.end();
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the socket on rejection: leave it usable for the error response.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = (err: Error) => { cleanup(); reject(err); };
    const aborted = () => error(new HttpError(400, 'Request aborted'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup(); req.resume(); reject(new HttpError(413, 'Request body exceeds 64 KiB')); return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

export async function startServer(options: ServerOptions = {}) {
  const maxSessions = options.maxSessions ?? 64;
  const sessionIdleMs = options.sessionIdleMs ?? 12 * 60 * 60 * 1000;
  if (![maxSessions, sessionIdleMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Session limits must be positive integers.');
  }
  const viewerFiles = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('../../public/viewer.html', import.meta.url)) }],
    ['/viewer.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('../../public/viewer.js', import.meta.url)) }],
    ['/viewer.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('../../public/viewer.css', import.meta.url)) }],
    ['/reviews', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('../../public/reviews.html', import.meta.url)) }],
    ['/reviews.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('../../public/reviews.js', import.meta.url)) }],
    ['/reviews.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('../../public/reviews.css', import.meta.url)) }],
  ]);
  const databasePath = options.databasePath ?? resolve('.mbus/history.sqlite');
  const bus = new Bus({ ...options.bus, databasePath });
  const context = new AsyncLocalStorage<AbortSignal>();
  const sessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createTools>;
    lastSeen: number;
  }>();
  let stopping = false;
  let port = 0;
  const http = createServer((req, res) => {
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableFinished) abort.abort(); });
    void context.run(abort.signal, async () => {
      try {
        if (stopping) throw new HttpError(503, 'Server shutting down');
        const authorities = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!authorities.includes(req.headers.host ?? '')) throw new HttpError(403, 'Invalid Host');
        const origin = req.headers.origin;
        if (origin !== undefined && !authorities.map(host => `http://${host}`).includes(origin)) {
          throw new HttpError(403, 'Invalid Origin');
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        const asset = viewerFiles.get(url.pathname);
        if (req.method === 'GET' && asset) {
          res.writeHead(200, {
            'Content-Type': asset.type, 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          });
          res.end(asset.body);
          return;
        }
        if (url.pathname === '/api/reviews' || url.pathname.startsWith('/api/reviews/')) {
          const parts = url.pathname.split('/');
          const id = parts[3];
          const action = parts[4];
          let result: unknown;
          const number = (key: string, fallback: number) => {
            const raw = url.searchParams.get(key);
            if (raw !== null && !/^\d+$/.test(raw)) throw new HttpError(400, `Invalid ${key}`);
            const value = raw === null ? fallback : Number(raw);
            if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `Invalid ${key}`);
            return value;
          };
          if (!id && url.pathname === '/api/reviews') {
            if (req.method !== 'GET') throw new HttpError(405, 'Use the submit_visual MCP tool to submit media');
            result = bus.visuals(url.searchParams.get('room') ?? '', number('before', Number.MAX_SAFE_INTEGER));
          } else {
            if (!id || !/^[0-9a-f-]{36}$/i.test(id) || parts.length > 5) throw new HttpError(404, 'Visual not found');
            const visual = bus.visual(id);
            if (!visual) throw new HttpError(404, 'Visual not found');
            if (action === 'media') {
              if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET or HEAD');
              let start = 0, end = visual.bytes - 1;
              const range = req.headers.range;
              if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (!match[1] && !match[2])) {
                  res.setHeader('Content-Range', `bytes */${visual.bytes}`);
                  throw new HttpError(416, 'Invalid byte range');
                }
                if (!match[1]) start = Math.max(0, visual.bytes - Number(match[2]));
                else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= visual.bytes) {
                  res.setHeader('Content-Range', `bytes */${visual.bytes}`);
                  throw new HttpError(416, 'Invalid byte range');
                }
              }
              res.writeHead(range ? 206 : 200, { 'Content-Type': visual.mime, 'Content-Length': end - start + 1,
                'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${visual.bytes}` } : {}) });
              res.end(req.method === 'HEAD' ? undefined : bus.visualMedia(id, start, end - start + 1));
              return;
            }
            if (action === 'comments') {
              if (req.method === 'POST') result = bus.commentVisual(id, await readBody(req));
              else if (req.method === 'GET') result = bus.visualComments(id, number('after', 0));
              else throw new HttpError(405, 'Use GET or POST');
            } else if (!action && req.method === 'GET') result = { visual };
            else throw new HttpError(404, 'Not found');
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(JSON.stringify(result));
          return;
        }
        if (['/api/rooms', '/api/room', '/api/events', '/api/broadcast', '/api/user-messages'].includes(url.pathname)) {
          let result: unknown;
          if (url.pathname === '/api/broadcast') {
            if (req.method !== 'POST') throw new HttpError(405, 'Use POST to publish a user message');
            result = bus.broadcast(await readBody(req));
          } else if (url.pathname === '/api/rooms' && req.method === 'PUT') {
            // Room prompts have no application-imposed size cap. MCP requests
            // retain their normal limit independently of this editor endpoint.
            result = { room: bus.configureRoom(await readBody(req, Infinity)) };
          } else if (req.method !== 'GET') {
            throw new HttpError(405, 'Use GET to read; PUT /api/rooms to save a room brief');
          } else if (url.pathname === '/api/room') {
            result = { room: bus.getRoom(url.searchParams.get('name') ?? '') };
          } else if (url.pathname === '/api/rooms') {
            result = { rooms: bus.archiveRooms() };
          } else {
            const roomId = url.searchParams.get('room') ?? '';
            const afterText = url.searchParams.get('after') ?? '0';
            const limitText = url.searchParams.get('limit') ?? '100';
            const after = Number(afterText);
            const limit = Number(limitText);
            if (!/^[0-9a-f-]{36}$/i.test(roomId) || !/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)
              || !Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
              throw new HttpError(400, 'Invalid room, cursor, or limit');
            }
            result = url.pathname === '/api/user-messages'
              ? bus.userMessages(roomId, after, limit) : bus.archiveEvents(roomId, after, limit);
            if (!result) throw new HttpError(404, 'Room not found');
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url !== '/mcp') throw new HttpError(404, 'Not found');
        if (req.method !== 'POST' && req.method !== 'DELETE') {
          res.setHeader('Allow', 'POST, DELETE');
          throw new HttpError(405, 'Use MCP tool calls over POST; unsolicited event streams are not supported');
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const id = req.headers['mcp-session-id'];
        if (id !== undefined && typeof id !== 'string') throw new HttpError(400, 'Invalid session header');
        let entry = id ? sessions.get(id) : undefined;
        if (id && !entry) throw new HttpError(404, 'Session expired or server restarted; reconnect and join');
        if (!entry) {
          if (!isInitializeRequest(body)) throw new HttpError(400, 'Initialize an MCP session first');
          if (sessions.size >= maxSessions) throw new HttpError(503, 'Session limit reached');
          const session = randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => session,
          });
          const server = createTools(bus, session, () => context.getStore(),
            (id, result) => transport.send({ jsonrpc: '2.0', id, result }));
          entry = { transport, server, lastSeen: Date.now() };
          sessions.set(session, entry);
          server.server.onclose = () => { sessions.delete(session); bus.leave(session); };
          try {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
          } finally {
            if (!transport.sessionId) {
              sessions.delete(session);
              await server.close();
            }
          }
          return;
        }
        entry.lastSeen = Date.now();
        res.setHeader('Cache-Control', 'no-store');
        await entry.transport.handleRequest(req, res, body);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof BusError
          ? ['ROOM_CONFLICT', 'MESSAGE_ID_CONFLICT'].includes(error.code) ? 409 : error.code === 'UNKNOWN_ROOM' ? 404 : 400 : 500;
        fail(res, status, error instanceof HttpError || error instanceof BusError ? error.message : 'Internal server error');
        if (!(error instanceof HttpError) && !(error instanceof BusError)) console.error('mbus request failed:', error instanceof Error ? error.message : 'unknown error');
      }
    });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  http.maxConnections = 128;
  const sweep = setInterval(() => {
    for (const entry of sessions.values()) {
      if (Date.now() - entry.lastSeen > sessionIdleMs) void entry.server.close().catch(() => {});
    }
  }, Math.min(60_000, sessionIdleMs));
  sweep.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 7331, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
  } catch (error) {
    clearInterval(sweep);
    bus.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/mcp`, viewerUrl: `http://127.0.0.1:${port}/`, bus, databasePath,
    close(): Promise<void> {
      return closing ??= (async () => {
        stopping = true;
        clearInterval(sweep);
        bus.close();
        // Let awakened receives send SHUTDOWN before the SDK aborts their
        // handlers. Bound draining so a slow request body cannot delay exit.
        const drained = new Promise<void>((resolve, reject) => {
          http.close(error => error ? reject(error) : resolve());
        });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([drained, new Promise<void>(resolve => {
          deadline = setTimeout(resolve, 1000);
        })]);
        clearTimeout(deadline);
        await Promise.allSettled([...sessions.values()].map(entry => entry.server.close()));
        http.closeAllConnections();
        await drained;
      })();
    },
  };
}
