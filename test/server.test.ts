import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type ServerOptions } from '../src/server.js';

async function fixture(t: TestContext, options: Partial<ServerOptions> = {}) {
  const server = await startServer({ port: 0, databasePath: ':memory:', ...options });
  const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
  t.after(async () => {
    for (const { client, transport } of clients) {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }
    await server.close();
  });
  return {
    ...server,
    async connect(name: string) {
      const client = new Client({ name, version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      clients.push({ client, transport });
      await client.connect(transport);
      return { client, transport };
    },
    async raw(init: RequestInit = {}) {
      return fetch(server.url, init);
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent as any;
}
const join = (client: Client, name: string, room = 'demo') => call(client, 'join', { name, room });

test('operator broadcasts reach every room, wake polling agents, and retry without duplicates', async t => {
  const f = await fixture(t);
  const a = (await f.connect('a')).client;
  const b = (await f.connect('b')).client;
  const ja = await join(a, 'a', 'alpha');
  const jb = await join(b, 'b', 'beta');
  const waiting = call(a, 'receive', { after: ja.cursor, wait_ms: 1000 });
  const input = { text: 'Focus on animations now.', message_id: '883523ae-f4a7-48f0-b393-899633c9cc25' };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(f.viewerUrl + 'api/broadcast', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  const response = await post(input);
  assert.equal(response.status, 200);
  const receipt = await response.json() as any;
  assert.equal(receipt.rooms.length, 2);
  assert.equal(receipt.duplicate, false);
  for (const batch of [await waiting, await call(b, 'receive', { after: jb.cursor })]) {
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].from, 'the user');
    assert.equal(batch.events[0].to, '*');
    assert.equal(batch.events[0].text, input.text);
  }
  const retry = await (await post(input)).json() as any;
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.rooms, receipt.rooms);
  assert.equal((await call(b, 'receive', { after: jb.cursor })).events.length, 1);
  assert.equal((await post({ ...input, text: 'different' })).status, 409);
  assert.equal((await post({ ...input, text: '   ' })).status, 400);
  assert.equal((await post({ ...input, text: 'x'.repeat(4097) })).status, 400);
  assert.equal((await post({ ...input, from: 'forged' })).status, 400);
  assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await fetch(f.viewerUrl + 'api/broadcast')).status, 405);
  const later = (await f.connect('later')).client;
  assert.ok((await join(later, 'later', 'alpha')).history.some((event: any) => event.from === 'the user'));
});

test('large room prompts save intact and reach joining peers, updates, and archive readers', async t => {
  const f = await fixture(t);
  const prompt = 'Detailed brief: \u03bb\n'.repeat(20_000) + 'End of brief.';
  assert.ok(Buffer.byteLength(prompt) > 256 * 1024);
  const brief = { name: 'large-brief', purpose: 'Exercise a long brief', prompt, expected_revision: 0 };
  const save = (value: typeof brief) => fetch(f.viewerUrl + 'api/rooms', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await save(brief)).status, 200);
  const saved = await (await fetch(f.viewerUrl + 'api/room?name=large-brief')).json() as any;
  assert.equal(saved.room.prompt, prompt);
  const a = (await f.connect('reader')).client;
  const joined = await join(a, 'reader', brief.name);
  assert.equal(joined.welcome.prompt, prompt);

  const updated = prompt + '\nUpdated ending.';
  assert.equal((await save({ ...brief, prompt: updated, expected_revision: 1 })).status, 200);
  await call(a, 'send', { to: '*', text: 'After the update', message_id: 'after-brief' });
  const batch = await call(a, 'receive', { after: joined.cursor });
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].brief.prompt, updated);
  assert.equal(batch.has_more, true);
  const next = await call(a, 'receive', { after: batch.cursor });
  assert.equal(next.events[0].message_id, 'after-brief');
  assert.equal(next.has_more, false);

  const archive = await (await fetch(f.viewerUrl + `api/events?room=${joined.room.id}&after=${joined.cursor.seq}`)).json() as any;
  assert.equal(archive.events.length, 1);
  assert.equal(archive.events[0].brief.prompt, updated);
  assert.equal(archive.has_more, true);
  const archiveNext = await (await fetch(f.viewerUrl + `api/events?room=${joined.room.id}&after=${archive.cursor}`)).json() as any;
  assert.equal(archiveNext.events[0].message_id, 'after-brief');
  assert.equal(archiveNext.has_more, false);
});

async function waitUntilReceiving(client: Client, cursor: unknown) {
  for (let i = 0; i < 30; i++) {
    const result = await client.callTool({ name: 'receive', arguments: { after: cursor } });
    if (result.isError) {
      assert.match(JSON.stringify(result), /ALREADY_WAITING/);
      return;
    }
  }
  assert.fail('Long poll did not start');
}

test('real HTTP MCP clients discover tools and cooperate with a third arrival', async t => {
  const f = await fixture(t);
  const a = (await f.connect('codex-test')).client;
  const b = (await f.connect('claude-test')).client;
  assert.deepEqual((await a.listTools()).tools.map(tool => tool.name).sort(), ['join', 'leave', 'list_peers', 'list_rooms', 'receive', 'send', 'submit_visual']);
  assert.ok(a.getInstructions()?.includes('equal peers'));
  const aj = await join(a, 'codex');
  const bj = await join(b, 'claude');
  assert.equal(bj.peers.length, 2);
  const before = await call(a, 'receive', { after: aj.cursor });
  const pending = call(a, 'receive', { after: before.cursor, wait_ms: 20_000 });
  await call(b, 'send', { to: aj.peer_id, message_id: 'offer', text: 'I can write tests.' });
  const received = await pending;
  assert.equal(received.events[0].text, 'I can write tests.');
  await call(a, 'send', { to: '*', message_id: 'agreement', text: 'Agreed. I implement; Claude tests.' });
  const c = (await f.connect('third-test')).client;
  const cj = await join(c, 'reviewer');
  assert.equal(cj.peers.length, 3);
  assert.ok(cj.history.some((e: any) => e.message_id === 'agreement'));
  assert.ok(!cj.history.some((e: any) => e.message_id === 'offer'));
  await call(c, 'send', { to: '*', message_id: 'review', text: 'I can review edge cases.' });
  const messages = await call(b, 'receive', { after: bj.cursor });
  assert.ok(messages.events.some((e: any) => e.type === 'peer_joined' && e.from === cj.peer_id));
  assert.ok(messages.events.some((e: any) => e.message_id === 'review'));
});

test('wire schemas reject spoofed identity and oversized or invalid inputs', async t => {
  const f = await fixture(t);
  const a = (await f.connect('a')).client;
  const b = (await f.connect('b')).client;
  const aj = await join(a, 'a');
  const bj = await join(b, 'b', 'other');
  for (const [name, args] of [
    ['send', { to: '*', text: 'x', message_id: 'x', from: bj.peer_id }],
    ['send', { to: '*', text: 'x'.repeat(4097), message_id: 'big' }],
    ['receive', { after: aj.cursor, wait_ms: 20_001 }],
    ['receive', { after: aj.cursor, limit: 0 }],
    ['send', { to: bj.peer_id, text: 'cross room', message_id: 'cross' }],
  ] as const) {
    const result = await a.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  assert.equal((await call(b, 'receive', { after: bj.cursor })).events.length, 0);
});

test('HTTP boundary allows token-free access and enforces loopback host/origin, route and body limit', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url)).status, 405);
  const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(f.url, { headers: { Host: 'attacker.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal((await f.raw({ headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.raw({ headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.raw()).status, 405);
  assert.equal((await f.raw({ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await f.raw({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.raw({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(70_000) }) })).status, 413);
  assert.equal((await f.raw({ method: 'DELETE', headers: { 'mcp-session-id': 'missing' } })).status, 404);
  const badRoute = await fetch(f.url + '/other');
  assert.equal(badRoute.status, 404);
});

test('session termination publishes departure and reconnect creates a distinct peer', async t => {
  const f = await fixture(t);
  const a = await f.connect('a');
  const b = await f.connect('b');
  const aj = await join(a.client, 'a');
  const bj = await join(b.client, 'b');
  await a.transport.terminateSession();
  const events = await call(b.client, 'receive', { after: bj.cursor });
  assert.equal(events.events[0].type, 'peer_left');
  assert.equal(events.events[0].from, aj.peer_id);
  const reconnected = await f.connect('a-again');
  assert.notEqual((await join(reconnected.client, 'a')).peer_id, aj.peer_id);
});

test('MCP request cancellation releases a pending receive', async t => {
  const f = await fixture(t);
  const a = (await f.connect('a')).client;
  const aj = await join(a, 'a');
  const controller = new AbortController();
  const waiting = a.callTool({ name: 'receive', arguments: { after: aj.cursor, wait_ms: 20_000 } }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(waiting);
  await waitUntilReceiving(a, aj.cursor);
  controller.abort();
  await rejection;
  for (let i = 0; i < 30; i++) {
    const result = await a.callTool({ name: 'receive', arguments: { after: aj.cursor } });
    if (!result.isError) return;
    assert.ok(i < 29, 'Long poll was not cleaned up');
  }
});

test('raw HTTP disconnect releases a waiting tool without ending peer membership', async t => {
  const f = await fixture(t);
  const { client, transport } = await f.connect('a');
  const aj = await join(client, 'a');
  const controller = new AbortController();
  const request = fetch(f.url, {
    method: 'POST', signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'raw-disconnect', method: 'tools/call',
      params: { name: 'receive', arguments: { after: aj.cursor, wait_ms: 20_000 } } }),
  }).then(response => response.text());
  const rejection = assert.rejects(request);
  await waitUntilReceiving(client, aj.cursor);
  controller.abort();
  await rejection;
  for (let i = 0; i < 30; i++) {
    const result = await client.callTool({ name: 'receive', arguments: { after: aj.cursor } });
    if (!result.isError) {
      assert.equal((await call(client, 'list_peers')).peers[0].id, aj.peer_id);
      return;
    }
  }
  assert.fail('Disconnected receive was not cleaned up');
});

test('MCP cancellation settles the original HTTP response stream', async t => {
  const f = await fixture(t);
  const { client, transport } = await f.connect('a');
  const aj = await join(client, 'a');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId!,
  };
  const request = fetch(f.url, {
    method: 'POST', headers, signal: AbortSignal.timeout(3000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call',
      params: { name: 'receive', arguments: { after: aj.cursor, wait_ms: 20_000 } } }),
  }).then(response => response.text());
  await waitUntilReceiving(client, aj.cursor);
  const cancel = await fetch(f.url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } }),
  });
  assert.equal(cancel.status, 202);
  assert.match(await request, /CANCELLED/);
});

test('simultaneous joins produce one ordered event per peer and preserve subsequent sends', async t => {
  const f = await fixture(t);
  const peers = await Promise.all(['a', 'b', 'c'].map(name => f.connect(name)));
  const joined = await Promise.all(peers.map(({ client }, i) => join(client, `peer-${i}`)));
  assert.equal(new Set(joined.map(j => j.cursor.seq)).size, 3);
  await Promise.all(peers.map(({ client }, i) => call(client, 'send', { to: '*', text: `${i}`, message_id: 'first' })));
  const events = await call(peers[0]!.client, 'receive', { after: { ...joined[0].cursor, seq: 0 } });
  assert.equal(events.events.length, 6);
  assert.deepEqual(events.events.map((e: any) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal((await call(peers[0]!.client, 'list_peers')).peers.length, 3);
});

test('idle sessions are reclaimed; server imposes a session cap', async t => {
  const f = await fixture(t, { maxSessions: 1, sessionIdleMs: 100 });
  const a = await f.connect('a');
  await join(a.client, 'a');
  await assert.rejects(f.connect('over-capacity'));
  await new Promise(resolve => setTimeout(resolve, 250));
  const b = await f.connect('b');
  assert.equal((await join(b.client, 'b')).peers.length, 1);
});

test('shutdown releases an active long poll and listening socket', async t => {
  const f = await fixture(t);
  const a = (await f.connect('a')).client;
  const aj = await join(a, 'a');
  const waiting = a.callTool({ name: 'receive', arguments: { after: aj.cursor, wait_ms: 20_000 } });
  const settled = waiting.catch(() => undefined);
  await waitUntilReceiving(a, aj.cursor);
  await f.close();
  await settled;
  await assert.rejects(fetch(f.url));
});

test('viewer serves the page and ordered archive including DMs without a token', async t => {
  const f = await fixture(t);
  const base = f.url.replace('/mcp', '');
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy')?.includes("script-src 'self'"));
  const html = await page.text();
  assert.ok(html.includes('Message traffic'));
  assert.ok(!html.includes('id="token"'));
  assert.equal((await fetch(base + '/api/rooms')).status, 200);
  assert.equal((await fetch(base + '/api/events')).status, 400);
  const a = (await f.connect('a')).client;
  const b = (await f.connect('b')).client;
  await join(a, 'Codex');
  const bj = await join(b, 'Claude');
  await call(a, 'send', { to: bj.peer_id, message_id: 'dm', text: '<script>not executable</script>' });
  await call(b, 'leave');
  const headers = {};
  const rooms = await (await fetch(base + '/api/rooms', { headers })).json() as any;
  assert.equal(rooms.rooms.length, 1);
  const id = rooms.rooms[0].id;
  const read = (suffix: string) => fetch(base + '/api/events?room=' + id + suffix, { headers });
  const first = await (await read('&after=0&limit=2')).json() as any;
  assert.deepEqual(first.events.map((e: any) => e.seq), [1, 2]);
  assert.equal(first.has_more, true);
  const next = await (await read('&after=' + first.cursor)).json() as any;
  assert.deepEqual(next.events.map((e: any) => e.seq), [3, 4]);
  assert.equal(next.events[0].text, '<script>not executable</script>');
  assert.equal(next.has_more, false);
  assert.equal((await read('&after=-1')).status, 400);
  assert.equal((await read('&limit=1000')).status, 400);
  assert.equal((await fetch(base + '/api/events', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base + '/api/rooms', { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
});

test('owner creates a room; an unjoined MCP client discovers it and receives its welcome prompt', async t => {
  const f = await fixture(t);
  const base = f.viewerUrl;
  const headers = { 'Content-Type': 'application/json' };
  const brief = {
    name: 'parser-fix', purpose: 'Fix parser edge cases', workspace: 'C:/project',
    prompt: 'Review the parser, fix empty input handling, add tests, and review each other’s results.', expected_revision: 0,
  };
  const created = await fetch(base + 'api/rooms', { method: 'PUT', headers, body: JSON.stringify(brief) });
  assert.equal(created.status, 200);
  const a = (await f.connect('new-agent')).client;
  const available = await call(a, 'list_rooms');
  assert.equal(available.rooms.length, 1);
  assert.equal(available.rooms[0].name, brief.name);
  assert.equal(available.rooms[0].purpose, brief.purpose);
  assert.equal(available.rooms[0].ready, true);
  assert.equal(available.rooms[0].peer_count, 0);
  assert.ok(!('prompt' in available.rooms[0]), 'Discovery should return compact summaries');
  const joined = await join(a, 'Codex', brief.name);
  assert.equal(joined.welcome.prompt, brief.prompt);
  assert.equal(joined.room.workspace, brief.workspace);
  assert.equal(joined.welcome.ready, true);
  assert.match(joined.welcome.next_action, /begin useful work/);
  assert.match(joined.welcome.instructions, /If alone, start/);
  assert.equal((await call(a, 'list_rooms')).rooms[0].peer_count, 1);
  const waiting = call(a, 'receive', { after: joined.cursor, wait_ms: 20000 });
  const updatedBrief = { ...brief, prompt: 'Review only. Do not edit files.', expected_revision: 1 };
  assert.equal((await fetch(base + 'api/rooms', { method: 'PUT', headers, body: JSON.stringify(updatedBrief) })).status, 200);
  const updates = await waiting;
  assert.equal(updates.events[0].type, 'room_updated');
  assert.equal(updates.events[0].brief.prompt, updatedBrief.prompt);
  assert.equal(updates.events[0].brief.revision, 2);
  const stale = await fetch(base + 'api/rooms', { method: 'PUT', headers, body: JSON.stringify(updatedBrief) });
  assert.equal(stale.status, 409);
  const saved = await (await fetch(base + 'api/room?name=parser-fix', { headers })).json() as any;
  assert.equal(saved.room.prompt, updatedBrief.prompt);
  assert.equal(saved.room.revision, 2);
  const again = await join(a, 'Codex', brief.name);
  assert.equal(again.welcome.prompt, updatedBrief.prompt);
  assert.deepEqual(again.cursor, joined.cursor);
  assert.equal((await fetch(base + 'api/rooms', { method: 'PUT', headers, body: JSON.stringify({ ...brief, name: 'invalid', prompt: '' }) })).status, 400);
  assert.equal((await fetch(base + 'api/room?name=invalid', { headers })).status, 404);
});
