import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

test('visual review snapshots survive restart; feedback is room scoped, durable, and retry safe', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mbus-visuals-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0R8AAAAASUVORK5CYII=', 'base64');
  const path = join(dir, 'frame.png'); writeFileSync(path, png);
  const databasePath = join(dir, 'history.sqlite');
  let server = await startServer({ port: 0, databasePath });
  const client = new Client({ name: 'visual-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent as any;
  };
  const peer = await call('join', { room: 'art', name: 'artist' });
  const other = server.bus.join('other', { room: 'other', name: 'other', about: '', status: '' });
  const input = { path, title: '<b>Frame</b>', description: 'Review lighting', message_id: 'frame-1' };
  const submitted = await call('submit_visual', input);
  const id = submitted.visual.id;
  assert.equal((await call('submit_visual', input)).duplicate, true);
  assert.equal((await client.callTool({ name: 'submit_visual', arguments: { ...input, title: 'changed' } })).isError, true);
  const base = () => server.viewerUrl + `api/reviews/${id}`;
  assert.deepEqual(Buffer.from(await (await fetch(base() + '/media')).arrayBuffer()), png);
  writeFileSync(path, 'overwritten');
  assert.deepEqual(Buffer.from(await (await fetch(base() + '/media')).arrayBuffer()), png);
  const range = await fetch(base() + '/media', { headers: { Range: 'bytes=2-7' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 2-7/${png.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(2, 8));
  assert.equal((await fetch(base() + '/media', { headers: { Range: 'bytes=99999-' } })).status, 416);
  assert.equal((await fetch(base() + '/media', { method: 'HEAD' })).headers.get('content-length'), String(png.length));
  const afterSubmit = await call('receive', { after: peer.cursor });
  const waiting = call('receive', { after: afterSubmit.cursor, wait_ms: 1000 });
  const feedback = { text: 'Make the shadows softer.', message_id: randomUUID() };
  const post = (body: unknown, origin?: string) => fetch(base() + '/comments', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(feedback, 'https://evil.example')).status, 403);
  assert.equal((await post({ ...feedback, time_seconds: 1 })).status, 400);
  const receipt = await (await post(feedback)).json() as any;
  assert.equal(receipt.duplicate, false);
  const delivered = (await waiting).events[0];
  assert.equal(delivered.from, 'the user'); assert.equal(delivered.review_id, id);
  assert.ok(delivered.text.includes(feedback.text));
  assert.equal((await server.bus.receive('other', other.cursor, 0, 20)).events.length, 0);
  assert.equal((server.bus.userMessages(peer.room.id, 0, 100)!.events).length, 1);
  assert.equal((await (await post(feedback)).json() as any).duplicate, true);
  assert.equal((await post({ ...feedback, text: 'changed' })).status, 409);
  await client.close(); await server.close();
  server = await startServer({ port: 0, databasePath });
  assert.equal((await (await fetch(server.viewerUrl + 'api/reviews')).json() as any).visuals[0].id, id);
  assert.equal((await (await post(feedback)).json() as any).duplicate, true);
  assert.equal((await (await fetch(base() + '/comments')).json() as any).events.length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(base() + '/media')).arrayBuffer()), png);
  assert.equal((await fetch(server.viewerUrl + 'reviews')).status, 200);
  assert.equal((await fetch(server.viewerUrl + 'api/reviews?before=no')).status, 400);
});

test('video ranges, timestamps, invalid media and unjoined submissions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mbus-video-'));
  const server = await startServer({ port: 0, databasePath: ':memory:' });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'clip.mp4');
  const bytes = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.alloc(50)]);
  writeFileSync(path, bytes);
  const args = { path, title: 'Walk', message_id: 'walk' };
  assert.throws(() => server.bus.submitVisual('missing', args), /join/);
  server.bus.join('a', { room: 'art', name: 'artist', about: '', status: '' });
  const result = server.bus.submitVisual('a', args);
  const url = server.viewerUrl + `api/reviews/${result.visual.id}/media`;
  for (const [range, expected] of [['bytes=4-', bytes.subarray(4)], ['bytes=-5', bytes.subarray(-5)]] as const) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const comment = server.bus.commentVisual(result.visual.id, { text: 'Foot slides here', message_id: randomUUID(), time_seconds: 1.25 });
  assert.ok(comment.event.text!.includes('1.25s'));
  writeFileSync(path, '<html>not video</html>');
  assert.throws(() => server.bus.submitVisual('a', { ...args, message_id: 'bad' }), /header/);
  assert.throws(() => server.bus.submitVisual('a', { ...args, path: 'relative.mp4' }), /absolute/);
});
