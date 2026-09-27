'use strict';
const el = id => document.getElementById(id);
let cursor = 0;
let hasMore = false;
let loaded = 0;
let busy = false;
let generation = 0;
const names = new Map();
let roomList = [];
let selectedBrief = null;
let editRevision = 0;
let editingExisting = false;

function status(text, error = false) {
  el('status').textContent = text;
  el('status').classList.toggle('error', error);
  if (error) { el('connection').textContent = 'Connection error'; el('connection').classList.remove('online'); }
}
async function api(path, body, method = body === undefined ? 'GET' : 'PUT') {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Server returned ${response.status}. Check that mbus is running.`);
  }
  el('connection').textContent = 'Connected'; el('connection').classList.add('online');
  return response.json();
}
const person = id => `${names.get(id) ?? 'Peer'} · ${id.slice(0, 8)}`;
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function render(event) {
  if (event.peer) names.set(event.from, event.peer.name);
  const date = new Date(event.at);
  const timestamp = node('time', date.toLocaleString());
  timestamp.dateTime = date.toISOString();
  if (event.type !== 'message') {
    const activity = node('div', undefined, 'presence');
    activity.hidden = !el('presence').checked;
    const text = event.type === 'room_updated'
      ? `#${event.seq} Room brief updated · revision ${event.brief?.revision} · ${event.brief?.purpose}`
      : `#${event.seq} ${person(event.from)} ${event.type === 'peer_joined' ? 'joined' : event.type === 'peer_left' ? 'left' : 'updated their profile'}${event.peer?.status ? ' — ' + event.peer.status : ''}`;
    activity.append(timestamp, node('span', text));
    return activity;
  }
  const article = node('article', undefined, 'message');
  const meta = node('div', undefined, 'meta');
  const route = node('span', undefined, 'route');
  route.append(node('span', event.from === 'the user' ? 'the user' : person(event.from)), node('span', '→', 'direction'), node('span', event.to === '*' ? 'Everyone' : person(event.to)));
  if (event.from === 'the user') article.classList.add('user-message');
  meta.append(node('span', `#${event.seq}`, 'seq'), route);
  if (event.to !== '*') meta.append(node('span', 'DIRECT', 'direct'));
  meta.append(timestamp);
  article.append(meta, node('div', event.text ?? '', 'body'));
  article.append(node('div', `Message ${event.message_id}${event.reply_to ? ' · Reply to #' + event.reply_to : ''}`, 'details'));
  return article;
}
function resetRoom() {
  generation++;
  cursor = 0; loaded = 0; hasMore = false;
  names.clear(); el('traffic').replaceChildren(); el('count').textContent = '';
  el('more').hidden = true;
  selectedBrief = null; el('brief').hidden = true;
}
async function rooms() {
  const version = generation;
  const data = await api('/api/rooms');
  if (version !== generation) return;
  roomList = data.rooms;
  const previous = el('room').value;
  el('room').replaceChildren(...data.rooms.map(room => {
    const option = node('option', `${room.name}${room.has_prompt ? '' : ' (needs brief)'}`);
    option.value = room.id;
    return option;
  }));
  if (data.rooms.some(room => room.id === previous)) el('room').value = previous;
}
async function loadBrief() {
  const selected = roomList.find(room => room.id === el('room').value);
  if (!selected) return;
  const version = generation;
  const data = await api('/api/room?name=' + encodeURIComponent(selected.name));
  if (version !== generation || selected.id !== el('room').value) return;
  selectedBrief = data.room;
  el('brief-purpose').textContent = data.room.purpose || 'This room needs a task brief';
  el('brief-revision').textContent = `Revision ${data.room.revision}`;
  el('brief-workspace').textContent = data.room.workspace ? `Workspace: ${data.room.workspace}` : '';
  el('brief-prompt').textContent = data.room.prompt || 'Click Edit brief to give joining agents their task.';
  el('brief').hidden = false;
}
async function refresh() {
  if (busy) return;
  busy = true;
  const version = generation;
  el('more').disabled = true; el('refresh').disabled = true;
  try {
    if (!el('room').value) await rooms();
    if (version !== generation) return;
    const room = el('room').value;
    if (!room) { status('No rooms yet. Click New room to give agents a place and a task.'); return; }
    if (!selectedBrief) await loadBrief();
    if (version !== generation) return;
    const data = await api(`/api/events?room=${encodeURIComponent(room)}&after=${cursor}&limit=100`);
    if (version !== generation) return;
    if (data.events.some(event => event.type === 'room_updated' && event.brief?.revision > (selectedBrief?.revision ?? 0))) await loadBrief();
    if (version !== generation) return;
    const follow = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
    const fragment = document.createDocumentFragment();
    for (const event of data.events) fragment.append(render(event));
    el('traffic').append(fragment);
    cursor = data.cursor; hasMore = data.has_more; loaded += data.events.length;
    el('more').hidden = !hasMore;
    el('count').textContent = `${loaded} events loaded · ${data.total} in room`;
    status(hasMore ? 'More saved history is available below.' : el('live').checked ? 'Caught up · checking for new traffic every 2 seconds.' : 'Live updates paused.');
    if (follow && loaded > data.events.length && data.events.length) window.scrollTo(0, document.body.scrollHeight);
  } catch (error) {
    if (version === generation) status(error.message, true);
  } finally {
    busy = false; el('more').disabled = false; el('refresh').disabled = false;
    if (version !== generation) void refresh();
  }
}
el('room').addEventListener('change', () => { resetRoom(); void refresh(); });
el('presence').addEventListener('change', () => {
  for (const row of document.querySelectorAll('.presence')) row.hidden = !el('presence').checked;
});
el('refresh').addEventListener('click', async () => {
  try { await rooms(); await loadBrief(); await refresh(); } catch (error) { status(error.message, true); }
});
el('more').addEventListener('click', () => void refresh());
el('live').addEventListener('change', () => {
  if (el('live').checked) void refresh(); else status('Live updates paused.');
});
setInterval(() => { if (el('live').checked && !hasMore) void refresh(); }, 2000);

function openEditor(brief) {
  editingExisting = Boolean(brief);
  editRevision = brief?.revision ?? 0;
  el('editor-title').textContent = brief ? 'Edit room brief' : 'New room';
  el('room-name').value = brief?.name ?? '';
  el('room-name').readOnly = editingExisting;
  el('room-purpose').value = brief?.purpose ?? '';
  el('room-workspace').value = brief?.workspace ?? '';
  el('room-prompt').value = brief?.prompt ?? '';
  el('editor-status').textContent = '';
  el('room-editor').hidden = false;
  el(brief ? 'room-purpose' : 'room-name').focus();
}
el('new-room').addEventListener('click', () => openEditor(null));
el('edit-room').addEventListener('click', async () => {
  try { await loadBrief(); if (selectedBrief) openEditor(selectedBrief); }
  catch (error) { status(error.message, true); }
});
el('cancel-room').addEventListener('click', () => { el('room-editor').hidden = true; });
el('room-editor').addEventListener('submit', async event => {
  event.preventDefault();
  el('save-room').disabled = true;
  const version = generation;
  try {
    const data = await api('/api/rooms', {
      name: el('room-name').value, purpose: el('room-purpose').value,
      workspace: el('room-workspace').value, prompt: el('room-prompt').value,
      expected_revision: editRevision,
    });
    if (version !== generation) return;
    el('room-editor').hidden = true;
    await rooms();
    el('room').value = data.room.id;
    resetRoom(); await refresh();
  } catch (error) { el('editor-status').textContent = error.message; }
  finally { el('save-room').disabled = false; }
});

let pendingBroadcast = null;
el('broadcast-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = el('broadcast-text').value.trim();
  if (!text) { el('broadcast-status').textContent = 'Enter a message first.'; return; }
  // Reuse the ID after a timeout: a lost response must not duplicate delivery.
  if (!pendingBroadcast || pendingBroadcast.text !== text) pendingBroadcast = { text, message_id: crypto.randomUUID() };
  el('publish-message').disabled = true;
  el('broadcast-text').disabled = true;
  el('broadcast-status').textContent = 'Publishing...';
  try {
    const result = await api('/api/broadcast', pendingBroadcast, 'POST');
    el('broadcast-status').textContent = `Published as the user to ${result.rooms.length} room${result.rooms.length === 1 ? '' : 's'}. Agents with wake support receive it automatically; other agents see it on their next message check.`;
    el('broadcast-text').value = '';
    pendingBroadcast = null;
    await refresh();
  } catch (error) { el('broadcast-status').textContent = error.message + ' You can retry publishing.'; }
  finally { el('publish-message').disabled = false; el('broadcast-text').disabled = false; }
});

void refresh();
