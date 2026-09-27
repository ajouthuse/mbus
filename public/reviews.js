const $ = selector => document.querySelector(selector);
const list = $('#reviews');
let next = null;
let generation = 0;
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function card(visual) {
  const article = $('#card').content.firstElementChild.cloneNode(true);
  article.id = visual.id;
  const video = visual.mime.startsWith('video/');
  const media = document.createElement(video ? 'video' : 'img');
  media.src = `/api/reviews/${visual.id}/media`;
  if (video) { media.controls = true; media.preload = 'metadata'; }
  else { media.alt = visual.title; media.loading = 'lazy'; }
  media.addEventListener('error', () => { article.querySelector('.send-status').textContent = 'The browser could not display this media. Try opening the original file.'; });
  article.querySelector('.media').append(media);
  article.querySelector('.original').href = media.src;
  article.querySelector('h2').textContent = visual.title;
  article.querySelector('.eyebrow').textContent = visual.room;
  article.querySelector('.context').textContent = visual.description;
  article.querySelector('.metadata').textContent = `${visual.author} · ${new Date(visual.at).toLocaleString()} · ${(visual.bytes / 1048576).toFixed(1)} MB`;
  const textarea = article.querySelector('textarea');
  textarea.id = `comment-${visual.id}`;
  article.querySelector('.comment-label').htmlFor = textarea.id;
  const draftKey = `mbus-review-${visual.id}`;
  try { textarea.value = localStorage.getItem(draftKey) || ''; } catch {}
  textarea.addEventListener('input', () => { try { localStorage.setItem(draftKey, textarea.value); } catch {} });
  article.querySelector('.timestamp').hidden = !video;
  let cursor = 0, count = 0, pending, loadingComments = false;
  const comments = article.querySelector('.comments');
  const moreComments = article.querySelector('.more-comments');
  async function loadComments() {
    if (loadingComments) return;
    loadingComments = true;
    try {
    const data = await api(`/api/reviews/${visual.id}/comments?after=${cursor}`);
    for (const event of data.events) {
      const p = document.createElement('p');
      p.textContent = `${new Date(event.at).toLocaleString()}\n${event.text}`;
      comments.append(p); count++;
    }
    cursor = data.cursor;
    moreComments.hidden = !data.has_more;
    article.querySelector('.count').textContent = `(${count}${data.has_more ? '+' : ''})`;
    } finally { loadingComments = false; }
  }
  moreComments.textContent = 'Load more feedback';
  moreComments.onclick = () => loadComments().catch(error => { article.querySelector('.send-status').textContent = error.message; });
  article.querySelector('details').addEventListener('toggle', () => {
    if (article.querySelector('details').open) void loadComments().catch(error => { article.querySelector('.send-status').textContent = error.message; });
  });
  article.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = article.querySelector('button[type=submit]');
    const status = article.querySelector('.send-status');
    if (!textarea.value.trim()) { status.textContent = 'Write a comment first.'; return; }
    // Retain the complete failed request so a retry cannot duplicate feedback,
    // even if playback advances between attempts.
    if (!pending || pending.text !== textarea.value.trim()) {
      pending = { text: textarea.value.trim(), message_id: crypto.randomUUID() };
      if (video && article.querySelector('input').checked) pending.time_seconds = media.currentTime;
    }
    button.disabled = true; textarea.disabled = true; status.textContent = 'Sending…';
    try {
      await api(`/api/reviews/${visual.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) });
      textarea.value = ''; pending = undefined;
      try { localStorage.removeItem(draftKey); } catch {}
      status.textContent = `Sent to ${visual.room}.`;
      await loadComments().catch(() => { status.textContent = `Sent to ${visual.room}. Reopen previous feedback to refresh it.`; });
    } catch (error) { status.textContent = `${error.message} — your comment is kept; retry to send.`; }
    finally { button.disabled = false; textarea.disabled = false; }
  };
  return article;
}
async function load(older = false) {
  const current = ++generation;
  $('#status').textContent = 'Loading…';
  try {
    const id = location.hash.slice(1);
    $('#all').hidden = !id;
    let data;
    if (id) { const result = await api(`/api/reviews/${encodeURIComponent(id)}`); data = { visuals: [result.visual], next_before: null }; }
    else data = await api(`/api/reviews?room=${encodeURIComponent($('#room').value)}${older && next ? `&before=${next}` : ''}`);
    if (generation !== current) return;
    if (!older) list.replaceChildren();
    for (const visual of data.visuals) list.append(card(visual));
    next = data.next_before; $('#more').hidden = !next; $('#all').hidden = !id;
    if (!list.children.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = 'No visuals yet. Ask an agent in this room to submit a screenshot or video for review.'; list.append(empty);
    }
    $('#status').textContent = 'Feedback goes to the visual’s room. Drafts are saved in this browser.';
  } catch (error) { $('#status').textContent = error.message; }
}
$('#refresh').onclick = () => load();
$('#more').onclick = () => load(true);
$('#all').onclick = () => { location.hash = ''; };
$('#room').onchange = () => { if (location.hash) location.hash = ''; else void load(); };
window.addEventListener('hashchange', () => load());
void api('/api/rooms').then(data => {
  for (const room of data.rooms) { const option = document.createElement('option'); option.value = room.id; option.textContent = room.name; $('#room').append(option); }
}).catch(error => { $('#status').textContent = error.message; });
void load();
