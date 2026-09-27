import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Bus } from '../src/bus.js';
import { History } from '../src/history.js';

function file(t: TestContext) {
  const root = resolve(tmpdir());
  const dir = mkdtempSync(join(root, 'mbus-history-'));
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    const child = relative(root, resolve(dir));
    assert.ok(child.startsWith('mbus-history-') && !child.includes('/') && !child.includes('\\'));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    path: join(dir, 'history.sqlite'), cleanup,
    track<T extends { close(): void }>(resource: T): T {
      cleanup.push(() => resource.close());
      return resource;
    },
  };
}
const profile = (name: string, room = 'project') => ({ name, room, about: '', status: 'available' });

test('user broadcasts persist, include empty rooms, and retain retry scope after restart', async t => {
  const f = file(t);
  const first = f.track(new Bus({ databasePath: f.path }));
  first.configureRoom({ name: 'empty', purpose: 'Waiting', prompt: 'Wait here', expected_revision: 0 });
  first.join('a', profile('a'));
  const input = { text: 'New direction', message_id: randomUUID() };
  const receipt = first.broadcast(input);
  assert.equal(receipt.rooms.length, 2);
  first.close();
  const second = f.track(new Bus({ databasePath: f.path }));
  second.configureRoom({ name: 'later', purpose: 'New room', prompt: 'New task', expected_revision: 0 });
  const retry = second.broadcast(input);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.rooms, receipt.rooms);
  const joined = second.join('b', profile('b', 'empty'));
  const history = await second.receive('b', { ...joined.cursor, seq: 0 }, 0, 50);
  const messages = history.events.filter(event => event.from === 'the user');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text, input.text);
});

test('disk history and room sequences survive restart; live peers do not', async t => {
  const f = file(t);
  const path = f.path;
  const first = f.track(new Bus({ databasePath: path }));
  const a = first.join('a', profile('a'));
  const b = first.join('b', profile('b'));
  first.send('a', { to: b.peer_id, message_id: 'private', text: 'private archive' });
  first.send('a', { to: '*', message_id: 'public', text: 'public agreement' });
  first.close();
  const second = f.track(new Bus({ databasePath: path }));
  const newcomer = second.join('new', profile('a'));
  assert.equal(newcomer.cursor.room_id, a.cursor.room_id);
  assert.notEqual(newcomer.cursor.epoch, a.cursor.epoch);
  assert.notEqual(newcomer.peer_id, a.peer_id);
  assert.equal(newcomer.peers.length, 1);
  assert.equal(newcomer.cursor.seq, 5);
  assert.ok(newcomer.history.some(e => e.message_id === 'public'));
  const all = await second.receive('new', { ...newcomer.cursor, seq: 0 }, 0, 50);
  assert.ok(all.events.some(e => e.message_id === 'public'));
  assert.ok(!all.events.some(e => e.message_id === 'private'));
  second.close();
  const archive = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(archive.prepare("SELECT count(*) AS n FROM events WHERE message_id = 'private'").get()!.n, 1);
    assert.equal(archive.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { archive.close(); }
});

test('evicting an inactive room does not discard its archived messages', async t => {
  const f = file(t);
  const bus = f.track(new Bus({ databasePath: f.path, maxRooms: 1 }));
  const original = bus.join('a', profile('a', 'one'));
  bus.send('a', { to: '*', message_id: 'remember', text: 'keep this' });
  bus.leave('a');
  bus.join('b', profile('b', 'two'));
  bus.leave('b');
  const again = bus.join('c', profile('c', 'one'));
  assert.equal(again.cursor.room_id, original.cursor.room_id);
  assert.ok(again.history.some(e => e.message_id === 'remember'));
});

test('failed writes roll back sequence allocation and publish no partial event', t => {
  const f = file(t);
  const history = f.track(new History(f.path));
  const room = history.room('rollback');
  const event = { at: Date.now(), type: 'message' as const, from: 'sender', to: '*', text: 'first', message_id: 'unique' };
  assert.equal(history.append(room.id, event).seq, 1);
  assert.throws(() => history.append(room.id, { ...event, text: 'conflict' }), /UNIQUE/);
  assert.equal(history.room('rollback').seq, 1);
  assert.equal(history.append(room.id, { ...event, message_id: 'next' }).seq, 2);
});

test('a second writer is refused until the database owner closes', t => {
  const f = file(t);
  const path = f.path;
  const first = f.track(new History(path));
  assert.throws(() => new History(path), /locked/);
  first.close();
  const second = new History(path);
  second.close();
});

test('committed events recover after the writer is forcibly terminated', async t => {
  const f = file(t);
  const path = f.path;
  const historyModule = new URL('../src/history.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { History } = await import(${JSON.stringify(historyModule)});
    const history = new History(process.argv[1]);
    const room = history.room('crash');
    history.append(room.id, { type: 'message', at: Date.now(), from: 'a', to: '*', message_id: 'committed', text: 'survives' });
    process.stdout.write('committed\\n');
    setInterval(() => {}, 1000);
  `, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  f.cleanup.push(async () => { if (child.exitCode === null) child.kill(); await exited; });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child timed out: ${stderr}`)), 5000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Child exited early: ${stderr}`)); });
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  child.kill('SIGKILL');
  await exited;
  const history = new History(path);
  try {
    const room = history.room('crash');
    assert.equal(room.seq, 1);
    assert.equal(history.event(room.id, 1)?.text, 'survives');
  } finally { history.close(); }
});

test('version 1 archive migrates without losing room IDs, sequences, or messages; briefs persist', async t => {
  const f = file(t);
  const old = new DatabaseSync(f.path);
  const id = randomUUID();
  try {
    old.exec(`
      CREATE TABLE rooms(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE events(room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL, sender TEXT NOT NULL,
        recipient TEXT NOT NULL, message_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(room_id, seq)) STRICT, WITHOUT ROWID;
      PRAGMA user_version=1;
    `);
    old.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(id, 'old-room', 1);
    const event = { seq: 1, at: 1, type: 'message', from: 'old-peer', to: '*', text: 'Keep this history', message_id: 'old-message' };
    old.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(id, 1, 'old-peer', '*', 'old-message', JSON.stringify(event));
  } finally { old.close(); }
  const first = f.track(new Bus({ databasePath: f.path }));
  assert.equal(first.listRooms().rooms[0]?.ready, false);
  const definition = first.configureRoom({ name: 'old-room', purpose: 'Continue the review', prompt: 'Review the remaining work.', workspace: 'C:/project', expected_revision: 0 });
  assert.equal(definition.id, id);
  assert.equal(definition.seq, 2);
  first.close();
  const second = f.track(new Bus({ databasePath: f.path }));
  const joined = second.join('a', profile('Codex', 'old-room'));
  assert.equal(joined.room.id, id);
  assert.equal(joined.room.revision, 1);
  assert.equal(joined.welcome.prompt, 'Review the remaining work.');
  assert.equal(joined.room.workspace, 'C:/project');
  assert.ok(joined.history.some(event => event.text === 'Keep this history'));
  assert.equal(joined.cursor.seq, 3);
});
