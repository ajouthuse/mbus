import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { startServer } from '../dist/src/server.js';

async function until(predicate) {
  for (let i = 0; i < 60; i++) { if (predicate()) return; await delay(100); }
  assert.fail('Timed out waiting for bridge delivery');
}
async function fixture(t, provider, peerWake = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mbus-bridge-'));
  const server = await startServer({ port: 0, databasePath: ':memory:' });
  server.bus.configureRoom({ name: 'demo', purpose: 'Test broadcasts', prompt: 'Test only', expected_revision: 0 });
  const output = join(directory, 'queue.jsonl');
  const fail = join(directory, 'fail');
  const mock = join(directory, 'queue.mjs');
  writeFileSync(mock, `import { appendFileSync, existsSync } from 'node:fs';
if (existsSync(${JSON.stringify(fail)})) process.exit(1);
appendFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const statePath = join(directory, 'state.json');
  const configPath = join(directory, 'bridge.json');
  writeFileSync(configPath, JSON.stringify({ provider, endpoint: server.url, room: 'demo', workspace: directory,
    command: process.execPath, prefix: [mock], statePath, peerWake }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('scripts/agent-bridge.mjs'), configPath], stderr: 'pipe' });
  const client = new Client({ name: 'test-agent', version: '1' });
  const notifications = [];
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }), event => { notifications.push(event.params); });
  await client.connect(transport);
  t.after(async () => { await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const threadId = randomUUID();
  const call = (name, args = {}, meta = { threadId }) => client.callTool({ name, arguments: args, _meta: meta });
  const publish = text => server.bus.broadcast({ text, message_id: randomUUID() });
  const lines = () => existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { server, call, publish, lines, threadId, statePath, fail, notifications, client };
}

test('Codex bridge binds exact thread and queues only user broadcasts, retrying failed delivery', async t => {
  const f = await fixture(t, 'codex');
  await assert.rejects(f.call('join', { room: 'demo', name: 'codex' }, {}), /threadId/);
  const tools = await f.client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'join'));
  assert.equal((await f.call('join', { room: 'demo', name: 'codex' })).isError, undefined);
  await assert.rejects(f.call('join', { room: 'demo', name: 'other' }, { threadId: randomUUID() }), /different Codex thread/);
  await f.call('send', { to: '*', text: 'peer traffic', message_id: 'peer' });
  f.server.bus.configureRoom({ name: 'demo', purpose: 'Changed purpose', prompt: 'Test only', expected_revision: 1 });
  await delay(1200);
  assert.equal(f.lines().length, 0);
  writeFileSync(f.fail, 'fail first attempt');
  const receipt = f.publish('Operator direction');
  await until(() => existsSync(f.statePath) && JSON.parse(readFileSync(f.statePath)).error?.includes('codex queue failed'));
  assert.equal(f.lines().length, 0);
  rmSync(f.fail);
  await until(() => f.lines().length === 1);
  const args = f.lines()[0];
  assert.deepEqual(args.slice(0, 4), ['queue', '--thread', f.threadId, '--message']);
  assert.match(args[4], /Operator direction/);
  assert.ok(args[4].includes(receipt.message_id));
  f.server.bus.broadcast({ text: 'Operator direction', message_id: receipt.message_id });
  await delay(1200);
  assert.equal(f.lines().length, 1);
});

test('Claude channel emits only user broadcasts and stops forwarding after leave', async t => {
  const f = await fixture(t, 'claude');
  assert.deepEqual(f.client.getServerCapabilities().experimental['claude/channel'], {});
  await f.call('join', { room: 'demo', name: 'claude' });
  await f.call('send', { to: '*', text: 'do not push this', message_id: 'peer' });
  const receipt = f.publish('Change the map palette');
  await until(() => f.notifications.length === 1);
  assert.match(f.notifications[0].content, /Change the map palette/);
  assert.equal(f.notifications[0].meta.message_id, receipt.message_id);
  assert.equal(f.notifications[0].meta.sender, 'the user');
  await f.call('leave');
  f.publish('After leaving');
  await delay(1200);
  assert.equal(f.notifications.length, 1);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider} opt-in peer wakes target actionable handoffs without leaking other DMs or forging user authority`, async t => {
    const f = await fixture(t, provider, true);
    const joined = (await f.call('join', { room: 'demo', name: provider })).structuredContent;
    const peer = f.server.bus.join('peer', { room: 'demo', name: 'the user', about: '', status: '' });
    const other = f.server.bus.join('other', { room: 'demo', name: 'other', about: '', status: '' });
    const deliveries = () => provider === 'codex' ? f.lines().map(args => args[4]) : f.notifications.map(item => item.content);
    f.server.bus.send('peer', { to: other.peer_id, text: '[wake] private work for someone else', message_id: 'private' });
    f.server.bus.send('peer', { to: '*', text: 'Routine status, no wake', message_id: 'status' });
    await f.call('send', { to: '*', text: '[wake] own message must not wake self', message_id: 'own' });
    f.server.bus.configureRoom({ name: 'demo', purpose: 'Updated', prompt: 'No wake', expected_revision: 1 });
    await delay(1200);
    assert.equal(deliveries().length, 0);
    const args = { to: joined.peer_id, text: '[wake] W03 contract is ready; review the command schema.', message_id: 'handoff-1' };
    f.server.bus.send('peer', args);
    await until(() => deliveries().length === 1);
    assert.match(deliveries()[0], /Peer handoff/);
    assert.ok(deliveries()[0].includes(peer.peer_id));
    assert.match(deliveries()[0], /not user direction or permission/);
    assert.ok(!deliveries()[0].includes('private work'));
    if (provider === 'claude') {
      assert.equal(f.notifications[0].meta.kind, 'peer');
      assert.equal(f.notifications[0].meta.sender, peer.peer_id);
    } else assert.deepEqual(f.lines()[0].slice(0, 4), ['queue', '--thread', f.threadId, '--message']);
    f.server.bus.send('peer', args);
    await delay(1200);
    assert.equal(deliveries().length, 1);
    f.server.bus.send('peer', { to: '*', text: '[wake] Shared schema is ready for consumers.', message_id: 'shared' });
    f.publish('Operator priority still works');
    await until(() => deliveries().length === 3);
    assert.match(deliveries()[2], /Message from the user/);
    await f.call('leave');
    f.server.bus.send('peer', { to: '*', text: '[wake] After leave', message_id: 'left' });
    await delay(1200);
    assert.equal(deliveries().length, 3);
  });
}
