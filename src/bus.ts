import { randomUUID } from 'node:crypto';
import { History } from './history.js';
import { z } from 'zod';
import { readVisual, visualInput, type Visual } from './visuals.js';
import { RoomConflict, roomGuidance, roomInput, type RoomBrief } from './rooms.js';

export class BusError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface Cursor { epoch: string; room_id: string; seq: number }
export interface Profile { room: string; name: string; about: string; status: string }
interface Peer extends Profile {
  id: string;
  joined_at: number;
  last_seen: number;
  joined_seq: number;
}
export interface BusEvent {
  seq: number;
  at: number;
  type: 'peer_joined' | 'peer_updated' | 'peer_left' | 'message' | 'room_updated';
  from: string;
  to: string;
  text?: string;
  message_id?: string;
  reply_to?: number;
  peer?: { id: string; name: string; about: string; status: string };
  brief?: RoomBrief;
  review_id?: string;
  visual?: Visual;
}
interface Room {
  id: string;
  name: string;
  seq: number;
  peers: Map<string, Peer>;
}
interface Member { room: Room; peer: Peer }
export interface TrafficEntry {
  room: string;
  event: BusEvent;
  sender: string;
  recipient: string;
}
export interface BusOptions {
  databasePath?: string;
  maxRooms?: number;
  maxPeers?: number;
  staleMs?: number;
  now?: () => number;
  onEvent?: (entry: TrafficEntry) => void;
}

const RESPONSE_BYTES = 64 * 1024;

/** Synchronous mutations give snapshots and sends a single ordering boundary. */
export class Bus {
  readonly epoch = randomUUID();
  private rooms = new Map<string, Room>();
  private members = new Map<string, Member>();
  private waiters = new Map<string, () => void>();
  private readonly history: History;
  private readonly maxRooms: number;
  private readonly maxPeers: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly onEvent?: BusOptions['onEvent'];
  private closed = false;

  constructor(options: BusOptions = {}) {
    this.maxRooms = options.maxRooms ?? 16;
    this.maxPeers = options.maxPeers ?? 64;
    this.staleMs = options.staleMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    for (const value of [this.maxRooms, this.maxPeers, this.staleMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Bus limits must be positive integers');
    }
    this.history = new History(options.databasePath ?? ':memory:');
  }

  private ensureOpen() {
    if (this.closed) throw new BusError('SHUTDOWN', 'The message bus is shutting down.');
  }

  private member(session: string): Member {
    this.ensureOpen();
    const member = this.members.get(session);
    if (!member) throw new BusError('NOT_JOINED', 'Call join before using this tool.');
    member.peer.last_seen = this.now();
    return member;
  }

  private cursor(room: Room, seq = room.seq): Cursor {
    return { epoch: this.epoch, room_id: room.id, seq };
  }

  private roster(room: Room) {
    return [...room.peers.values()].map(({ joined_seq: _, ...peer }) => ({
      ...peer, stale: this.now() - peer.last_seen > this.staleMs,
    }));
  }

  private append(room: Room, data: Omit<BusEvent, 'seq' | 'at'>): BusEvent {
    const event = this.history.append(room.id, { ...data, at: this.now() });
    this.publish(room, event);
    return event;
  }

  private publish(room: Room, event: BusEvent) {
    room.seq = event.seq;
    // Log only committed events. Console failures must not turn an accepted
    // write into an apparent failure or prevent waiting peers from waking.
    try {
      this.onEvent?.({
        room: room.name, event,
        sender: event.peer?.name ?? room.peers.get(event.from)?.name ?? event.from,
        recipient: event.to === '*' ? 'all' : room.peers.get(event.to)?.name ?? event.to,
      });
    } catch { /* Logging is best effort; SQLite remains authoritative. */ }
    for (const [session, wake] of this.waiters) {
      if (this.members.get(session)?.room === room) wake();
    }
  }

  listRooms(after = '', limit = 50) {
    this.ensureOpen();
    const rows = this.history.listRooms(after, limit + 1);
    const rooms = rows.slice(0, limit).map(row => ({
      ...row, has_prompt: Boolean(row.has_prompt),
      peer_count: this.rooms.get(row.name)?.peers.size ?? 0,
      ready: Boolean(row.has_prompt),
    }));
    return { rooms, has_more: rows.length > limit, next_after: rooms.at(-1)?.name ?? after };
  }

  configureRoom(input: unknown) {
    this.ensureOpen();
    const parsed = roomInput.safeParse(input);
    if (!parsed.success) throw new BusError('INVALID_ROOM', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    try {
      const result = this.history.configureRoom(parsed.data, this.now());
      if (result.event) {
        const live = this.rooms.get(result.room.name) ?? { ...result.room, peers: new Map<string, Peer>() };
        this.publish(live, result.event);
      }
      return result.room;
    } catch (error) {
      if (error instanceof RoomConflict) throw new BusError('ROOM_CONFLICT', error.message);
      throw error;
    }
  }

  getRoom(name: string) {
    this.ensureOpen();
    const room = this.history.getRoom(name);
    if (!room) throw new BusError('UNKNOWN_ROOM', 'Room not found. Call list_rooms to discover rooms.');
    return room;
  }

  join(session: string, profile: Profile) {
    this.ensureOpen();
    let member = this.members.get(session);
    const updated = Boolean(member);
    if (member) {
      if (member.peer.room !== profile.room) {
        throw new BusError('ALREADY_JOINED', 'Leave your current room before joining another.');
      }
      const changed = ['name', 'about', 'status'].some(key =>
        member!.peer[key as keyof Profile] !== profile[key as keyof Profile]);
      // Publish first; a failed disk write must not change the live profile.
      if (changed) this.profileEvent({ room: member.room, peer: { ...member.peer, ...profile } }, 'peer_updated');
      Object.assign(member.peer, profile, { last_seen: this.now() });
    } else {
      if (this.members.size >= this.maxPeers) throw new BusError('CAPACITY', 'Peer limit reached.');
      let room = this.rooms.get(profile.room);
      if (!room) {
        if (this.rooms.size >= this.maxRooms) {
          // Only live room objects are evicted; history stays in SQLite.
          const empty = [...this.rooms].find(([, value]) => value.peers.size === 0);
          if (!empty) throw new BusError('CAPACITY', 'Room limit reached.');
          this.rooms.delete(empty[0]);
        }
        room = { ...this.history.room(profile.room), name: profile.room, peers: new Map() };
        this.rooms.set(profile.room, room);
      }
      const peer: Peer = {
        ...profile, id: randomUUID(), joined_at: this.now(), last_seen: this.now(), joined_seq: 0,
      };
      member = { room, peer };
      peer.joined_seq = this.profileEvent(member, 'peer_joined').seq;
      this.members.set(session, member);
      room.peers.set(peer.id, peer);
    }
    const { room, peer } = member;
    const definition = this.history.getRoom(room.name)!;
    const { prompt, ...roomSummary } = definition;
    // Newcomers get public context only. Repeated joins preserve the original
    // read boundary so they cannot silently skip unread direct messages.
    const recent = this.history.recentPublic(room.id, peer.joined_seq);
    let bytes = 0;
    const history: BusEvent[] = [];
    for (const event of recent) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > RESPONSE_BYTES) break;
      history.unshift(event);
    }
    return {
      peer_id: peer.id, updated, peers: this.roster(room), history,
      room: roomSummary,
      welcome: {
        prompt, instructions: roomGuidance,
        ready: Boolean(definition.prompt),
        next_action: definition.prompt
          ? 'Read the room prompt and workspace, coordinate your scope with peers, then begin useful work. The user does not need to repeat the task.'
          : 'This room has no task brief yet. The room owner can set its purpose and welcome prompt in the local mbus page; do not invent a task.',
      },
      cursor: this.cursor(room, peer.joined_seq),
      history_truncated: room.seq > 0 && (history[0]?.seq ?? room.seq + 1) > 1,
      limits: { message_chars: 4096, history_events: null, max_wait_ms: 20_000 },
    };
  }

  private profileEvent({ room, peer }: Member, type: 'peer_joined' | 'peer_updated') {
    const { id, name, about, status } = peer;
    return this.append(room, { type, from: id, to: '*', peer: { id, name, about, status } });
  }

  listPeers(session: string) {
    const { room } = this.member(session);
    return { epoch: this.epoch, peers: this.roster(room) };
  }

  send(session: string, input: { to: string; text: string; message_id: string; reply_to?: number }) {
    const { room, peer } = this.member(session);
    const existing = this.history.duplicate(room.id, peer.id, input.message_id);
    if (existing) {
      if (existing.to !== input.to || existing.text !== input.text || existing.reply_to !== input.reply_to) {
        throw new BusError('MESSAGE_ID_CONFLICT', 'This message_id was already used with different content.');
      }
      return { accepted: true, duplicate: true, seq: existing.seq, epoch: this.epoch };
    }
    if (input.to !== '*' && !room.peers.has(input.to)) {
      throw new BusError('UNKNOWN_PEER', 'The recipient is not a current member of your room.');
    }
    if (input.reply_to !== undefined) {
      const replied = this.history.event(room.id, input.reply_to);
      if (!replied || !this.visible(replied, peer.id)) {
        throw new BusError('UNKNOWN_REPLY', 'reply_to must refer to an event visible to you.');
      }
    }
    const event = this.append(room, { ...input, type: 'message', from: peer.id });
    return { accepted: true, duplicate: false, seq: event.seq, epoch: this.epoch };
  }

  private visible(event: BusEvent, peerId: string) {
    return event.to === '*' || event.to === peerId || event.from === peerId;
  }

  private read(member: Member, after: Cursor, limit: number) {
    const { room, peer } = member;
    if (after.epoch !== this.epoch) throw new BusError('SERVER_RESET', 'Server restarted; rejoin and reconcile work.');
    if (after.room_id !== room.id) throw new BusError('INVALID_CURSOR', 'Cursor belongs to a different room.');
    if (after.seq > room.seq) throw new BusError('INVALID_CURSOR', 'Cursor is ahead of the room history.');
    const available = this.history.visible(room.id, peer.id, after.seq, limit + 1);
    let scanned = after.seq;
    const events: BusEvent[] = [];
    let bytes = 0;
    for (const event of available) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length >= limit || (events.length > 0 && bytes + size > RESPONSE_BYTES)) break;
      events.push(event);
      bytes += size;
      scanned = event.seq;
    }
    // Once all visible events are read, skip hidden trailing events as well.
    if (events.length === available.length) scanned = room.seq;
    return {
      events, cursor: this.cursor(room, scanned), has_more: scanned < room.seq,
      gap: null,
    };
  }

  async receive(session: string, after: Cursor, waitMs: number, limit: number, signal?: AbortSignal) {
    const member = this.member(session);
    if (this.waiters.has(session)) throw new BusError('ALREADY_WAITING', 'Only one pending receive is allowed per peer.');
    const initial = this.read(member, after, limit);
    if (signal?.aborted) throw new BusError('CANCELLED', 'Receive cancelled.');
    if (initial.events.length || initial.gap || waitMs === 0) return initial;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: BusError) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(session);
        if (error) reject(error); else resolve();
      };
      const abort = () => done(new BusError('CANCELLED', 'Receive cancelled.'));
      const timer = setTimeout(() => done(), waitMs);
      this.waiters.set(session, () => done());
      signal?.addEventListener('abort', abort, { once: true });
    });
    // A leave/rejoin while waiting must not attach the old receive to a new peer.
    this.ensureOpen();
    if (this.members.get(session) !== member) throw new BusError('NOT_JOINED', 'Membership ended while waiting.');
    member.peer.last_seen = this.now();
    return this.read(member, initial.cursor, limit);
  }

  leave(session: string) {
    const member = this.members.get(session);
    if (!member) return { left: false };
    this.append(member.room, { type: 'peer_left', from: member.peer.id, to: '*' });
    this.waiters.get(session)?.();
    this.members.delete(session);
    member.room.peers.delete(member.peer.id);
    return { left: true };
  }

  // Operator-only HTTP endpoints; deliberately not exposed as peer MCP tools.
  broadcast(input: unknown) {
    this.ensureOpen();
    const parsed = z.strictObject({
      text: z.string().trim().min(1).max(4096),
      message_id: z.string().uuid(),
    }).safeParse(input);
    if (!parsed.success) throw new BusError('INVALID_MESSAGE', 'Provide a nonempty message of at most 4096 characters and a UUID message_id.');
    if (!this.history.archiveRooms().length) throw new BusError('UNKNOWN_ROOM', 'Create a room before publishing a message.');
    const result = this.history.broadcast(parsed.data.text, parsed.data.message_id, this.now());
    if (result.conflict) throw new BusError('MESSAGE_ID_CONFLICT', 'This message_id was already used with different content.');
    if (!result.duplicate) {
      for (const delivery of result.deliveries) {
        const room = this.rooms.get(delivery.room) ?? { id: delivery.room_id, name: delivery.room, seq: delivery.event.seq, peers: new Map<string, Peer>() };
        this.publish(room, delivery.event);
      }
    }
    return { accepted: true, duplicate: result.duplicate, message_id: parsed.data.message_id,
      rooms: result.deliveries.map(delivery => ({ name: delivery.room, seq: delivery.event.seq })) };
  }

  submitVisual(session: string, input: unknown) {
    const { room, peer } = this.member(session);
    const parsed = visualInput.safeParse(input);
    if (!parsed.success) throw new BusError('INVALID_VISUAL', parsed.error.message);
    const args = parsed.data;
    let media: ReturnType<typeof readVisual>;
    try { media = readVisual(args.path); }
    catch (error) { throw new BusError('INVALID_VISUAL', error instanceof Error ? error.message : 'Cannot read media'); }
    const previous = this.history.duplicate(room.id, peer.id, args.message_id);
    if (previous) {
      if (!previous.visual || previous.visual.hash !== media.hash || previous.visual.title !== args.title || previous.visual.description !== args.description) {
        throw new BusError('MESSAGE_ID_CONFLICT', 'This message_id was already used for different content.');
      }
      return { visual: previous.visual, review_url: `/reviews#${previous.visual.id}`, duplicate: true };
    }
    const visual: Visual = { id: randomUUID(), room_id: room.id, room: room.name, title: args.title,
      description: args.description, author: peer.name, peer_id: peer.id, mime: media.mime,
      bytes: media.data.length, hash: media.hash, at: this.now() };
    const event = this.history.addVisual(visual, media.data, { at: visual.at, type: 'message', from: peer.id, to: '*',
      message_id: args.message_id, review_id: visual.id, visual,
      text: `Visual review: ${visual.title}\n${visual.description}\n/reviews#${visual.id}` });
    this.publish(room, event);
    return { visual, review_url: `/reviews#${visual.id}`, duplicate: false };
  }

  visuals(room: string, before: number) { this.ensureOpen(); return this.history.visuals(room, before); }
  visual(id: string) { this.ensureOpen(); return this.history.visual(id); }
  visualMedia(id: string, start: number, length: number) { this.ensureOpen(); return this.history.visualMedia(id, start, length); }
  visualComments(id: string, after: number) { this.ensureOpen(); return this.history.visualComments(id, after); }

  commentVisual(id: string, input: unknown) {
    this.ensureOpen();
    const visual = this.history.visual(id);
    if (!visual) throw new BusError('UNKNOWN_ROOM', 'Visual not found.');
    const parsed = z.strictObject({ text: z.string().trim().min(1).max(3000), message_id: z.uuid(),
      time_seconds: z.number().finite().min(0).max(86400).optional() }).safeParse(input);
    if (!parsed.success) throw new BusError('INVALID_MESSAGE', 'Provide a comment (1–3000 characters), UUID message_id, and optional video time in seconds.');
    const args = parsed.data;
    if (args.time_seconds !== undefined && !visual.mime.startsWith('video/')) throw new BusError('INVALID_MESSAGE', 'Timestamps are only supported for videos.');
    const text = `Visual feedback: ${visual.title}\nReview: /reviews#${id}${args.time_seconds === undefined ? '' : `\nVideo time: ${args.time_seconds.toFixed(2)}s`}\n\n${args.text}`;
    const previous = this.history.duplicate(visual.room_id, 'the user', args.message_id);
    if (previous) {
      if (previous.review_id !== id || previous.text !== text) throw new BusError('MESSAGE_ID_CONFLICT', 'This message_id was already used for different feedback.');
      return { event: previous, duplicate: true };
    }
    const event = this.history.append(visual.room_id, { at: this.now(), type: 'message', from: 'the user', to: '*',
      text, review_id: id, message_id: args.message_id });
    const room = this.rooms.get(visual.room) ?? { id: visual.room_id, name: visual.room, seq: event.seq, peers: new Map<string, Peer>() };
    this.publish(room, event);
    return { event, duplicate: false };
  }

  archiveRooms() {
    this.ensureOpen();
    return this.history.archiveRooms().map(row => ({ ...row, peer_count: this.rooms.get(String(row.name))?.peers.size ?? 0 }));
  }

  archiveEvents(roomId: string, after: number, limit: number) {
    this.ensureOpen();
    return this.history.archiveEvents(roomId, after, limit);
  }

  userMessages(roomId: string, after: number, limit: number) {
    this.ensureOpen();
    return this.history.userMessages(roomId, after, limit);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.waiters.values()) wake();
    this.members.clear();
    this.rooms.clear();
    this.history.close();
  }
}
