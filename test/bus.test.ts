import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus, BusError } from '../src/bus.js';

const profile = (name: string, room = 'project') => ({ room, name, about: '', status: 'available' });
const send = (bus: Bus, from: string, to = '*', message_id = 'm1', text = 'hello') =>
  bus.send(from, { to, message_id, text });
const code = (expected: string) => (error: unknown) => error instanceof BusError && error.code === expected;

test('joining is idempotent; updates publish once and roster does not imply fixed roles', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('codex'));
  const b = bus.join('b', profile('claude'));
  const again = bus.join('a', profile('codex'));
  assert.equal(again.peer_id, a.peer_id);
  assert.deepEqual(again.cursor, a.cursor);
  assert.equal(again.peers.length, 2);
  assert.equal((await bus.receive('b', b.cursor, 0, 20)).events.length, 0);
  bus.join('a', { ...profile('codex'), status: 'parser' });
  const events = await bus.receive('b', b.cursor, 0, 20);
  assert.deepEqual(events.events.map(e => e.type), ['peer_updated']);
  assert.equal(events.events[0]?.peer?.status, 'parser');
  assert.throws(() => bus.join('a', profile('codex', 'other')), code('ALREADY_JOINED'));
});

test('third arrivals see public context but cannot read private history', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('codex'));
  const b = bus.join('b', profile('claude'));
  send(bus, 'a', b.peer_id, 'private', 'private detail');
  send(bus, 'a', '*', 'public', 'I implement; Claude tests.');
  const c = bus.join('c', profile('reviewer'));
  assert.equal(c.history.some(e => e.text === 'private detail'), false);
  assert.equal(c.history.some(e => e.message_id === 'public'), true);
  const historical = await bus.receive('c', { ...c.cursor, seq: 0 }, 0, 50);
  assert.equal(historical.events.some(e => e.message_id === 'private'), false);
  assert.equal((await bus.receive('a', a.cursor, 0, 50)).events.some(e => e.message_id === 'private'), true);
  assert.equal((await bus.receive('b', b.cursor, 0, 50)).events.some(e => e.message_id === 'private'), true);
  assert.throws(() => bus.send('c', { to: '*', text: 'reply', message_id: 'reply', reply_to: 3 }), code('UNKNOWN_REPLY'));
});

test('rooms and membership isolate recipients and cursors', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('codex'));
  const b = bus.join('b', profile('claude', 'unrelated'));
  assert.equal(b.peers.length, 1);
  assert.throws(() => send(bus, 'a', b.peer_id), code('UNKNOWN_PEER'));
  await assert.rejects(bus.receive('a', b.cursor, 0, 20), code('INVALID_CURSOR'));
  await assert.rejects(bus.receive('a', { ...a.cursor, seq: 100 }, 0, 20), code('INVALID_CURSOR'));
  assert.throws(() => send(bus, 'unknown'), code('NOT_JOINED'));
});

test('retrying sends does not duplicate events, even after recipient leaves', async () => {
  const bus = new Bus();
  bus.join('a', profile('a'));
  const b = bus.join('b', profile('b'));
  const first = send(bus, 'a', b.peer_id);
  bus.leave('b');
  const retry = send(bus, 'a', b.peer_id);
  assert.equal(retry.seq, first.seq);
  assert.equal(retry.duplicate, true);
  assert.throws(() => send(bus, 'a', b.peer_id, 'm1', 'changed'), code('MESSAGE_ID_CONFLICT'));
});

test('pagination is repeatable and advances across hidden events', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('a'));
  const b = bus.join('b', profile('b'));
  const c = bus.join('c', profile('c'));
  send(bus, 'a', '*', 'one');
  send(bus, 'a', b.peer_id, 'hidden');
  send(bus, 'a', '*', 'two');
  const first = await bus.receive('c', c.cursor, 0, 1);
  assert.equal(first.events[0]?.message_id, 'one');
  assert.equal(first.has_more, true);
  assert.deepEqual(await bus.receive('c', c.cursor, 0, 1), first);
  const second = await bus.receive('c', first.cursor, 0, 1);
  assert.equal(second.events[0]?.message_id, 'two');
  assert.equal(second.has_more, false);
  send(bus, 'a', a.peer_id, 'hidden-tail');
  const tail = await bus.receive('c', second.cursor, 0, 20);
  assert.equal(tail.events.length, 0);
  assert.ok(tail.cursor.seq > second.cursor.seq);
});

test('history remains readable beyond the old window; a restart invalidates old epochs', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('a'));
  for (let i = 0; i < 300; i++) send(bus, 'a', '*', String(i));
  const result = await bus.receive('a', a.cursor, 0, 20);
  assert.equal(result.gap, null);
  assert.equal(result.events[0]?.message_id, '0');
  assert.equal(result.events.length, 20);
  assert.equal(result.has_more, true);
  assert.equal(send(bus, 'a', '*', '0').duplicate, true);
  const restarted = new Bus();
  restarted.join('a', profile('a'));
  await assert.rejects(restarted.receive('a', a.cursor, 0, 20), code('SERVER_RESET'));
  bus.close();
  restarted.close();
});

test('receive wakes on arrivals and messages without blocking independent work', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('a'));
  const pending = bus.receive('a', a.cursor, 20_000, 20);
  bus.join('b', profile('b'));
  const arrival = await pending;
  assert.equal(arrival.events[0]?.type, 'peer_joined');
  const waiting = bus.receive('a', arrival.cursor, 20_000, 20);
  await assert.rejects(bus.receive('a', arrival.cursor, 1, 20), code('ALREADY_WAITING'));
  send(bus, 'b', a.peer_id);
  assert.equal((await waiting).events[0]?.text, 'hello');
});

test('timeout, cancellation, leave/rejoin, and shutdown clean pending receives', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('a'));
  assert.equal((await bus.receive('a', a.cursor, 5, 20)).events.length, 0);
  const abort = new AbortController();
  const cancelled = bus.receive('a', a.cursor, 20_000, 20, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, code('CANCELLED'));
  const left = bus.receive('a', a.cursor, 20_000, 20);
  assert.equal(bus.leave('a').left, true);
  assert.equal(bus.leave('a').left, false);
  const newJoin = bus.join('a', profile('a'));
  await assert.rejects(left, code('NOT_JOINED'));
  const stopped = bus.receive('a', newJoin.cursor, 20_000, 20);
  bus.close();
  await assert.rejects(stopped, code('SHUTDOWN'));
});

test('quiet peers become stale without being removed or losing their scope', () => {
  let now = 1000;
  const bus = new Bus({ now: () => now, staleMs: 100 });
  bus.join('a', { ...profile('a'), status: 'owns parser' });
  bus.join('b', profile('b'));
  now += 101;
  const peers = bus.listPeers('b').peers;
  assert.equal(peers.find(p => p.name === 'a')?.stale, true);
  assert.equal(peers.find(p => p.name === 'a')?.status, 'owns parser');
  assert.equal(peers.find(p => p.name === 'b')?.stale, false);
});

test('room and peer caps are bounded and empty rooms can be reclaimed', () => {
  const bus = new Bus({ maxRooms: 1, maxPeers: 2 });
  bus.join('a', profile('a'));
  assert.throws(() => bus.join('b', profile('b', 'different')), code('CAPACITY'));
  bus.join('b', profile('b'));
  assert.throws(() => bus.join('c', profile('c')), code('CAPACITY'));
  bus.leave('a');
  bus.leave('b');
  assert.equal(bus.join('c', profile('c', 'different')).peers.length, 1);
});

test('response byte limit paginates large messages without dropping them', async () => {
  const bus = new Bus();
  const a = bus.join('a', profile('a'));
  for (let i = 0; i < 20; i++) send(bus, 'a', '*', String(i), '\u0000'.repeat(4096));
  let cursor = a.cursor;
  const seen: string[] = [];
  do {
    const batch = await bus.receive('a', cursor, 0, 50);
    assert.ok(Buffer.byteLength(JSON.stringify(batch.events)) <= 64 * 1024);
    seen.push(...batch.events.map(e => e.message_id!));
    cursor = batch.cursor;
    if (!batch.has_more) break;
  } while (true);
  assert.equal(seen.length, 20);
});

test('room discovery is paginated and configured rooms do not consume live room capacity', () => {
  const bus = new Bus({ maxRooms: 1 });
  try {
    for (const name of ['alpha', 'beta', 'gamma']) {
      bus.configureRoom({ name, purpose: `Work in ${name}`, prompt: 'Investigate and share findings.', expected_revision: 0 });
    }
    const first = bus.listRooms('', 2);
    assert.deepEqual(first.rooms.map(room => room.name), ['alpha', 'beta']);
    assert.equal(first.has_more, true);
    assert.deepEqual(bus.listRooms(first.next_after, 2).rooms.map(room => room.name), ['gamma']);
    const a = bus.join('a', profile('a', 'alpha'));
    assert.equal(a.welcome.ready, true);
    assert.equal(bus.listRooms().rooms[0]?.peer_count, 1);
    assert.throws(() => bus.join('b', profile('b', 'beta')), code('CAPACITY'));
    bus.leave('a');
    assert.equal(bus.join('b', profile('b', 'beta')).welcome.ready, true);
  } finally { bus.close(); }
});

test('legacy rooms have explicit missing-brief guidance; unchanged brief saves emit no event', () => {
  const bus = new Bus();
  try {
    const old = bus.join('a', profile('a'));
    assert.equal(old.welcome.ready, false);
    assert.match(old.welcome.next_action, /no task brief/);
    const input = { name: 'project', purpose: 'Review', prompt: 'Review this project.', expected_revision: 0 };
    const configured = bus.configureRoom(input);
    const same = bus.configureRoom({ ...input, expected_revision: 1 });
    assert.equal(same.revision, configured.revision);
    assert.equal(same.seq, configured.seq);
  } finally { bus.close(); }
});
