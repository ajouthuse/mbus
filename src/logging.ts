import type { TrafficEntry } from './bus.js';

// Escape terminal controls so message content cannot erase or forge log lines.
const safe = (text: string) => text.replace(
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
);

export function formatTraffic({ room, event, sender, recipient }: TrafficEntry): string {
  const who = `${safe(sender)}[${event.from.slice(0, 8)}]`;
  const prefix = `${new Date(event.at).toISOString()} [${safe(room)}] #${event.seq}`;
  if (event.type === 'room_updated') return `${prefix} ROOM revision=${event.brief?.revision} purpose=${JSON.stringify(safe(event.brief?.purpose ?? ''))}`;
  if (event.type === 'message') {
    const destination = event.to === '*' ? 'all' : `${safe(recipient)}[${event.to.slice(0, 8)}]`;
    const reply = event.reply_to === undefined ? '' : ` reply_to=#${event.reply_to}`;
    const header = `${prefix} MESSAGE ${who} -> ${destination} id=${JSON.stringify(safe(event.message_id ?? ''))}${reply}`;
    const body = (event.text ?? '').split(/\r?\n/).map(line => `  | ${safe(line)}`).join('\n');
    return `${header}\n${body}`;
  }
  if (event.type === 'peer_left') return `${prefix} LEAVE ${who}`;
  const action = event.type === 'peer_joined' ? 'JOIN' : 'UPDATE';
  return `${prefix} ${action} ${who} status=${JSON.stringify(safe(event.peer?.status ?? ''))}`;
}
