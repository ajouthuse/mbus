import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BusEvent } from './bus.js';
import type { Visual } from './visuals.js';
import { RoomConflict, type RoomDefinition, type RoomInput } from './rooms.js';

/** One connection owns the database. Every published event is committed first. */
export class History {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // Exclusive ownership also prevents two mbus processes from exposing
      // inconsistent in-memory rosters for the same durable history.
      this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE;');
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported mbus database version: ${version}`);
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          seq INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          room_id TEXT NOT NULL REFERENCES rooms(id),
          seq INTEGER NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          message_id TEXT,
          payload TEXT NOT NULL,
          PRIMARY KEY (room_id, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE UNIQUE INDEX IF NOT EXISTS events_message_id
          ON events(room_id, sender, message_id) WHERE message_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS events_recipient ON events(room_id, recipient, seq);
        CREATE INDEX IF NOT EXISTS events_sender ON events(room_id, sender, seq);
        CREATE TABLE IF NOT EXISTS user_broadcasts (
          message_id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          deliveries TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS visuals (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL REFERENCES rooms(id),
          payload TEXT NOT NULL,
          media BLOB NOT NULL
        ) STRICT;
      `);
      if (version < 2) {
        this.db.exec(`
          ALTER TABLE rooms ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
          ALTER TABLE rooms ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
          ALTER TABLE rooms ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
          ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        `);
      }
      this.db.exec('PRAGMA user_version = 2; COMMIT;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  room(name: string): RoomDefinition {
    this.statement('INSERT OR IGNORE INTO rooms(id, name) VALUES (?, ?)').run(randomUUID(), name);
    return this.getRoom(name)!;
  }

  getRoom(name: string): RoomDefinition | undefined {
    return this.statement('SELECT id, name, seq, purpose, prompt, workspace, revision FROM rooms WHERE name = ?')
      .get(name) as RoomDefinition | undefined;
  }

  listRooms(after: string, limit: number) {
    return this.statement("SELECT id, name, purpose, workspace, revision, prompt != '' AS has_prompt FROM rooms WHERE name > ? ORDER BY name LIMIT ?")
      .all(after, limit) as { id: string; name: string; purpose: string; workspace: string; revision: number; has_prompt: number }[];
  }

  configureRoom(input: RoomInput, at: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.room(input.name);
      if (previous.revision !== input.expected_revision) {
        throw new RoomConflict(`Room brief is now revision ${previous.revision}. Reload it before saving your changes.`);
      }
      let event: BusEvent | undefined;
      if (previous.purpose !== input.purpose || previous.prompt !== input.prompt || previous.workspace !== input.workspace) {
        this.statement('UPDATE rooms SET purpose = ?, prompt = ?, workspace = ?, revision = revision + 1 WHERE id = ?')
          .run(input.purpose, input.prompt, input.workspace, previous.id);
        const { name, purpose, prompt, workspace, revision } = this.getRoom(input.name)!;
        event = this.insertEvent(previous.id, {
          at, type: 'room_updated', from: 'mbus', to: '*',
          brief: { name, purpose, prompt, workspace, revision },
        });
      }
      const room = this.getRoom(input.name)!;
      this.db.exec('COMMIT');
      return { room, event };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertEvent(roomId: string, data: Omit<BusEvent, 'seq'>): BusEvent {
    const row = this.statement('UPDATE rooms SET seq = seq + 1 WHERE id = ? RETURNING seq').get(roomId);
    if (!row) throw new Error('History room does not exist');
    const event = { ...data, seq: Number(row.seq) };
    this.statement('INSERT INTO events(room_id, seq, sender, recipient, message_id, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, event.seq, event.from, event.to, event.message_id ?? null, JSON.stringify(event));
    return event;
  }

  append(roomId: string, data: Omit<BusEvent, 'seq'>): BusEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.insertEvent(roomId, data);
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  duplicate(roomId: string, sender: string, messageId: string): BusEvent | undefined {
    const row = this.statement('SELECT payload FROM events WHERE room_id = ? AND sender = ? AND message_id = ?')
      .get(roomId, sender, messageId);
    return row ? JSON.parse(row.payload as string) as BusEvent : undefined;
  }

  broadcast(text: string, messageId: string, at: number) {
    type Delivery = { room: string; room_id: string; event: BusEvent };
    const previous = this.statement('SELECT text, deliveries FROM user_broadcasts WHERE message_id = ?').get(messageId);
    if (previous) {
      return { duplicate: true, conflict: previous.text !== text, deliveries: JSON.parse(previous.deliveries as string) as Delivery[] };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rooms = this.statement('SELECT id, name FROM rooms ORDER BY name').all();
      const deliveries: Delivery[] = rooms.map(room => ({
        room: String(room.name), room_id: String(room.id),
        event: this.insertEvent(String(room.id), {
          type: 'message', from: 'the user', to: '*', text, message_id: messageId, at,
        }),
      }));
      this.statement('INSERT INTO user_broadcasts(message_id, text, deliveries) VALUES (?, ?, ?)')
        .run(messageId, text, JSON.stringify(deliveries));
      this.db.exec('COMMIT');
      return { duplicate: false, conflict: false, deliveries };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  event(roomId: string, seq: number): BusEvent | undefined {
    const row = this.statement('SELECT payload FROM events WHERE room_id = ? AND seq = ?').get(roomId, seq);
    return row ? JSON.parse(row.payload as string) as BusEvent : undefined;
  }

  recentPublic(roomId: string, through: number): BusEvent[] {
    return this.statement("SELECT payload FROM events WHERE room_id = ? AND recipient = '*' AND seq <= ? ORDER BY seq DESC LIMIT 10")
      .all(roomId, through).map(row => JSON.parse(row.payload as string) as BusEvent);
  }

  visible(roomId: string, peerId: string, after: number, limit: number): BusEvent[] {
    // Three bounded index seeks avoid scanning a large run of other peers' DMs.
    // Merge at most 3 * limit candidates; self/broadcast messages may overlap.
    const received = this.statement('SELECT payload FROM events WHERE room_id = ? AND recipient = ? AND seq > ? ORDER BY seq LIMIT ?');
    const sent = this.statement('SELECT payload FROM events WHERE room_id = ? AND sender = ? AND seq > ? ORDER BY seq LIMIT ?');
    const rows = [
      ...received.all(roomId, '*', after, limit),
      ...received.all(roomId, peerId, after, limit),
      ...sent.all(roomId, peerId, after, limit),
    ];
    const unique = new Map<number, BusEvent>();
    for (const row of rows) {
      const event = JSON.parse(row.payload as string) as BusEvent;
      unique.set(event.seq, event);
    }
    return [...unique.values()].sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  /** Local operator view: includes DMs and archived peers, unlike MCP receive. */
  archiveRooms() {
    return this.statement("SELECT id, name, seq, purpose, workspace, revision, prompt != '' AS has_prompt FROM rooms ORDER BY name").all();
  }

  userMessages(roomId: string, after: number, limit: number) {
    const room = this.statement('SELECT seq FROM rooms WHERE id = ?').get(roomId);
    if (!room) return undefined;
    const events = this.statement("SELECT payload FROM events WHERE room_id = ? AND sender = 'the user' AND seq > ? ORDER BY seq LIMIT ?")
      .all(roomId, after, limit + 1).map(row => JSON.parse(row.payload as string) as BusEvent);
    const batch = events.slice(0, limit);
    return { events: batch, cursor: events.length > limit ? batch.at(-1)!.seq : Number(room.seq), has_more: events.length > limit };
  }

  archiveEvents(roomId: string, after: number, limit: number) {
    const room = this.statement('SELECT seq FROM rooms WHERE id = ?').get(roomId);
    if (!room) return undefined;
    const rows = this.statement('SELECT payload FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(roomId, after, limit);
    const events: BusEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const payload = row.payload as string;
      const size = Buffer.byteLength(payload);
      if (events.length && bytes + size > 256 * 1024) break;
      events.push(JSON.parse(payload) as BusEvent);
      bytes += size;
    }
    const cursor = events.at(-1)?.seq ?? after;
    return { events, cursor, has_more: cursor < Number(room.seq), total: Number(room.seq) };
  }

  addVisual(visual: Visual, media: Buffer, eventData: Omit<BusEvent, 'seq'>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statement('INSERT INTO visuals(id, room_id, payload, media) VALUES (?, ?, ?, ?)')
        .run(visual.id, visual.room_id, JSON.stringify(visual), media);
      const event = this.insertEvent(visual.room_id, eventData);
      this.db.exec('COMMIT');
      return event;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  visual(id: string): Visual | undefined {
    const row = this.statement('SELECT payload FROM visuals WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }

  visuals(room: string, before: number) {
    const rows = this.statement("SELECT rowid AS position, payload FROM visuals WHERE (? = '' OR room_id = ?) AND rowid < ? ORDER BY rowid DESC LIMIT 21")
      .all(room, room, before);
    return { visuals: rows.slice(0, 20).map(row => JSON.parse(String(row.payload)) as Visual),
      next_before: rows.length > 20 ? Number(rows[19]!.position) : null };
  }

  visualMedia(id: string, start: number, length: number) {
    return this.statement('SELECT substr(media, ?, ?) AS data FROM visuals WHERE id = ?').get(start + 1, length, id)?.data as Uint8Array | undefined;
  }

  visualComments(id: string, after: number) {
    const visual = this.visual(id);
    if (!visual) return undefined;
    const rows = this.statement("SELECT payload FROM events WHERE room_id = ? AND sender = 'the user' AND seq > ? AND json_extract(payload, '$.review_id') = ? ORDER BY seq LIMIT 101")
      .all(visual.room_id, after, id);
    const events = rows.slice(0, 100).map(row => JSON.parse(String(row.payload)) as BusEvent);
    return { events, has_more: rows.length > 100, cursor: events.at(-1)?.seq ?? after };
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
