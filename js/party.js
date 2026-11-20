import { state } from './state.js';
import { CONFIG } from './config.js';
import { $, esc, sleep } from './util.js';
import { toast } from './views.js';

/* Watching together (Jellyfin).

   Every DingFlix tab keeps a WebSocket open to Jellyfin, so it can be sent
   messages. Joining a friend makes their tab the host: guests tell the host when
   they join, pause, skip or chat; the host tells every guest what's playing and
   where, and passes chat along. Messages travel as Jellyfin "display message"
   commands with a `dingflix` header, so no other server is involved. */

const TICK = 4000;     // how often the host sends where it is
const DRIFT = 2;       // seconds a guest may be off before it jumps
const LATENCY = 0.3;   // rough time a message takes, in seconds
const GONE = 45000;    // a guest that hasn't checked in for this long has left

let live = null;   // the WebSocket: { server, ws, sid, ready }
let party = null;  // { role: 'host'|'guest', host: { sid, name }, members, log, open, unread }
let player = null; // the open player (from player.js)
let leaveTimer = null;
let tickTimer = null;

const me = () => state.server?.userName || 'Someone';

/* ---------- the live connection ---------- */

export function startLive() {
  const s = state.server;
  if (live?.server === s) return;
  stopLive();
  if (s?.kind !== 'jellyfin' || s.guest || !s.socketUrl || typeof WebSocket === 'undefined') return;
  live = { server: s, sid: null, tries: 0 };
  open(live);
}

function stopLive() {
  if (!live) return;
  const l = live;
  live = null;
  party = null;
  clearTimeout(l.retry);
  clearInterval(l.keepAlive);
  l.ws?.close();
}

function open(l) {
  let resolve;
  l.ready = new Promise(r => (resolve = r));
  let ws;
  try {
    ws = l.ws = new WebSocket(l.server.socketUrl());
  } catch {
    return resolve(null);
  }
  ws.onopen = async () => {
    l.tries = 0;
    await l.server.announce().catch(() => {});
    l.sid = await l.server.mySessionId().catch(() => null);
    resolve(l.sid);
  };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.MessageType === 'ForceKeepAlive') {
      clearInterval(l.keepAlive);
      const every = Math.max(5, (Number(m.Data) || 60) / 2) * 1000;
      l.keepAlive = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ MessageType: 'KeepAlive' })), every);
      return;
    }
    if (m.MessageType !== 'GeneralCommand' || m.Data?.Name !== 'DisplayMessage') return;
    const a = m.Data.Arguments || {};
    if (a.Header !== 'dingflix') return;
    try {
      onMessage(JSON.parse(a.Text));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => {
    clearInterval(l.keepAlive);
    resolve(null);
    if (live !== l) return;
    l.retry = setTimeout(() => live === l && open(l), Math.min(30000, 2000 * 2 ** l.tries++));
  };
}

function send(sid, data, opts) {
  if (!live?.sid) return Promise.reject(new Error('Not connected'));
  return live.server.sendMessage(sid, { ...data, sid: live.sid, name: me() }, opts);
}

// Host → every guest. Guests that can't be reached any more are dropped.
function broadcast(data, except, opts) {
  if (party?.role !== 'host') return;
  for (const [sid, m] of party.members) {
    if (sid === except) continue;
    send(sid, data, opts).catch(err => {
      if (err.status === 400 || err.status === 404) dropMember(sid, `${m.name} left.`);
    });
  }
}

function dropMember(sid, line) {
  const m = party?.members.get(sid);
  if (!m) return;
  party.members.delete(sid);
  note(line || `${m.name} left.`);
  broadcast({ t: 'note', text: line || `${m.name} left.` });
  sendState();
}

/* ---------- joining ---------- */

// Joins whoever is playing in session `sid`. Returns where to start: { key, at }.
export async function join(sid) {
  const s = state.server;
  const target = (await s.watchSessions?.().catch(() => []) || []).find(x => x.Id === sid);
  if (!target) {
    toast('They’ve stopped watching.');
    return null;
  }
  const name = target.UserName;
  const start = { key: target.NowPlayingItem.Id, at: (target.PlayState?.PositionTicks || 0) / 1e7 };
  if (party?.role === 'guest' && party.host.sid === sid) return start;
  const mySid = live ? await Promise.race([live.ready, sleep(6000).then(() => null)]) : null;
  if (target.Client !== CONFIG.appName || !mySid) {
    toast(target.Client !== CONFIG.appName
      ? `${name} is watching in another Jellyfin app, so you’ll start where they are, but you won’t stay in sync or chat.`
      : `Couldn’t connect to ${name}. Starting where they are, on your own.`);
    return start;
  }
  leaveNow();
  party = newParty('guest', { sid, name });
  party.lastHeard = Date.now();
  note(`You joined ${name}.`);
  send(sid, { t: 'join' }).catch(() => {
    if (party?.host.sid !== sid) return;
    party = null;
    render();
    toast(`Couldn’t reach ${name}. You’re watching on your own.`);
  });
  render();
  return start;
}

const newParty = (role, host) => ({ role, host, members: new Map(), log: [], open: true, unread: 0, people: [host.name] });

// Leaves (or, as host, ends) the current party straight away.
function leaveNow(opts) {
  if (!party) return;
  if (party.role === 'host') broadcast({ t: 'end' }, null, opts);
  else send(party.host.sid, { t: 'leave' }, opts).catch(() => {});
  party = null;
}

addEventListener('pagehide', () => leaveNow({ keepalive: true }));

/* ---------- messages ---------- */

function onMessage(m) {
  if (!m?.t || !m.sid) return;
  const fromHost = party?.role === 'guest' && m.sid === party.host.sid;
  const member = party?.role === 'host' ? party.members.get(m.sid) : null;
  if (member) member.seen = Date.now();
  if (fromHost) party.lastHeard = Date.now();

  switch (m.t) {
    case 'join': {
      // Someone joined a guest: send them to the host instead.
      if (party?.role === 'guest') return void send(m.sid, { t: 'redirect', to: party.host.sid }).catch(() => {});
      if (!player?.item) return void send(m.sid, { t: 'end' }).catch(() => {});
      if (!party) party = newParty('host', { sid: live.sid, name: me() });
      party.members.set(m.sid, { name: m.name, seen: Date.now() });
      note(`${m.name} joined.`);
      broadcast({ t: 'note', text: `${m.name} joined.` }, m.sid);
      party.open = true;
      sendState();
      render();
      break;
    }
    case 'redirect':
      if (party?.role === 'guest' && fromHost) party = null;
      join(m.to).then(start => start && watch(start));
      break;
    case 'state':
      if (!fromHost) return;
      party.people = m.people || party.people;
      party.last = m;
      applyState(m);
      render();
      break;
    case 'chat':
      if (member) {
        broadcast({ t: 'chat', who: m.name, text: m.text }, m.sid);
        chat(m.name, m.text);
      } else if (fromHost) chat(m.who || m.name, m.text);
      break;
    case 'note':
      if (fromHost) note(m.text);
      break;
    case 'ctl':
      if (member) control(m);
      break;
    case 'leave':
      if (member) dropMember(m.sid);
      break;
    case 'end':
      if (!fromHost) return;
      note(`${party.host.name} stopped watching.`);
      toast(`${party.host.name} stopped watching. You can keep going on your own.`);
      party = null;
      render();
      break;
  }
}

/* ---------- keeping the video in step ---------- */

function where() {
  const v = player?.video;
  return v ? { item: player.ratingKey, pos: Math.round(v.currentTime * 1000), paused: v.paused } : null;
}

function sendState(to) {
  if (party?.role !== 'host' || !player?.ready) return;
  const data = { t: 'state', ...where(), people: [me(), ...[...party.members.values()].map(x => x.name)] };
  party.people = data.people;
  if (to) send(to, data).catch(() => {});
  else broadcast(data);
}

// Opens another title in the player (the host moved on, or a redirect).
function watch({ key, at }) {
  if (party) party.switching = String(key);
  history.replaceState(history.state, '', `#/watch/${key}?at=${Math.round(at || 0)}`);
  dispatchEvent(new HashChangeEvent('hashchange'));
}

function applyState(m) {
  const c = player;
  if (!c) return;
  if (String(c.ratingKey) !== String(m.item)) {
    if (party.switching !== String(m.item)) watch({ key: m.item, at: m.pos / 1000 });
    return;
  }
  // Right after we paused or skipped, the host's older news would undo it.
  if (!c.ready || Date.now() - (party.sentAt || 0) < 1500) return;
  const v = c.video;
  const target = m.pos / 1000 + (m.paused ? 0 : LATENCY);
  if (Math.abs(v.currentTime - target) > DRIFT) {
    expect(c, 'seeked');
    v.currentTime = target;
  }
  if (m.paused && !v.paused) {
    expect(c, 'pause');
    v.pause();
  } else if (!m.paused && v.paused) {
    expect(c, 'play');
    v.play().catch(() => {});
  }
}

// The video events our own changes cause, so they aren't sent back as the guest's doing.
function expect(c, type) {
  c.expecting ??= {};
  c.expecting[type] = (c.expecting[type] || 0) + 1;
  clearTimeout(c.expectTimer);
  c.expectTimer = setTimeout(() => (c.expecting = {}), 3000);
}

// A guest paused, played or skipped: do the same here; the video's events then tell everyone.
function control(m) {
  const v = player?.video;
  if (!v || String(player.ratingKey) !== String(m.item)) return;
  const at = m.pos / 1000;
  const moved = Math.abs(v.currentTime - at) > DRIFT;
  let line = '';
  if (moved) {
    v.currentTime = at;
    line = `${m.name} skipped to ${clock(at)}.`;
  }
  if (m.paused && !v.paused) {
    v.pause();
    line = `${m.name} paused.`;
  } else if (!m.paused && v.paused) {
    v.play().catch(() => {});
    line = line || `${m.name} pressed play.`;
  }
  if (line) {
    note(line);
    broadcast({ t: 'note', text: line });
  }
  sendState();
}

const clock = s => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

/* ---------- the player hooks ---------- */

// 'host', 'guest' or null. Guests don't move on by themselves; the host takes them along.
export const partyRole = () => party?.role || null;

export function attachParty(c) {
  player = c;
  clearTimeout(leaveTimer);
  if (party) party.switching = null;
  c.root.querySelector('.player-bar [data-tracks]')?.insertAdjacentHTML('beforebegin', `
    <button class="icon-btn party-btn" data-party aria-label="Chat with everyone watching" title="Watching together" hidden>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M9 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm7.5 2a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm0-2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM2 20v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1h-2v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1H2Zm16 0v-1c0-1.3-.4-2.5-1.1-3.5A4.5 4.5 0 0 1 22 20h-2a2.5 2.5 0 0 0-2-2.45V20Z"/></svg>
      <span class="party-count" hidden></span>
    </button>`);
  c.root.insertAdjacentHTML('beforeend', `
    <aside class="party" aria-label="Watching together" hidden>
      <div class="party-head">
        <div><strong>Watching together</strong><small class="party-people"></small></div>
        <button class="icon-btn" data-party-close aria-label="Hide chat">×</button>
      </div>
      <div class="party-log" aria-live="polite"></div>
      <form class="party-form">
        <input name="text" maxlength="300" autocomplete="off" placeholder="Say something…" aria-label="Message">
        <button class="btn small accent">Send</button>
      </form>
    </aside>
    <div class="party-pops" aria-hidden="true"></div>`);

  const v = c.video;
  v.addEventListener('playing', () => {
    if (c.ready) return;
    c.ready = true;
    if (party?.role === 'guest' && party.last) applyState(party.last);
    else sendState();
  });
  const changed = e => {
    if (c.expecting?.[e.type] > 0) return void c.expecting[e.type]--;
    if (!party || !c.ready || player !== c) return;
    if (party.role === 'host') return void soon(sendState);
    party.sentAt = Date.now(); // from now on, until the host has heard, its older news is ignored
    soon(() => {
      if (party?.role !== 'guest' || player !== c) return;
      party.sentAt = Date.now();
      send(party.host.sid, { t: 'ctl', ...where() }).catch(() => {});
    });
  };
  for (const type of ['play', 'pause', 'seeked']) v.addEventListener(type, changed);

  $('[data-party]', c.root).onclick = e => {
    e.stopPropagation();
    if (!party) return;
    party.open = !party.open;
    render();
  };
  $('[data-party-close]', c.root).onclick = () => {
    if (party) party.open = false;
    render();
  };
  $('.party', c.root).addEventListener('click', e => e.stopPropagation());
  $('.party-form', c.root).onsubmit = e => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value.trim().slice(0, 300);
    if (!text || !party) return;
    input.value = '';
    if (party.role === 'host') broadcast({ t: 'chat', who: me(), text });
    else send(party.host.sid, { t: 'chat', text }).catch(() => note('That message didn’t send.'));
    chat(me(), text, true);
  };

  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK);
  render();
}

export function detachParty(c) {
  if (player !== c) return;
  player = null;
  clearInterval(tickTimer);
  clearTimeout(leaveTimer);
  // Moving on to the next episode reopens the player straight away; only leave
  // the party if it stays closed.
  if (party) leaveTimer = setTimeout(() => player || leaveNow(), 4000);
}

function tick() {
  if (!party) return;
  if (party.role === 'host') {
    for (const [sid, m] of party.members) if (Date.now() - m.seen > GONE) dropMember(sid);
    sendState();
  } else {
    send(party.host.sid, { t: 'here' }).catch(() => {});
    if (Date.now() - party.lastHeard > 20000) {
      toast(`Lost touch with ${party.host.name}. You’re watching on your own.`);
      party = null;
      render();
    }
  }
}

let soonTimer = null;
function soon(fn) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(fn, 250);
}

/* ---------- chat ---------- */

function note(text) {
  if (!party) return;
  party.log.push({ text, note: true });
  render();
}

function chat(who, text, mine = false) {
  if (!party || !text) return;
  party.log.push({ who, text: String(text).slice(0, 300), mine });
  if (party.log.length > 200) party.log.shift();
  if (!party.open && !mine) {
    party.unread++;
    pop(who, text);
  }
  render();
}

function pop(who, text) {
  const box = player && $('.party-pops', player.root);
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'party-pop';
  el.innerHTML = `<strong>${esc(who)}</strong> ${esc(text)}`;
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 7000);
}

function render() {
  const c = player;
  if (!c) return;
  const btn = $('[data-party]', c.root);
  const panel = $('.party', c.root);
  if (!btn || !panel) return;
  btn.hidden = !party;
  const show = !!party?.open;
  panel.hidden = !show;
  c.root.classList.toggle('party-open', show);
  if (!party) return;
  if (show) party.unread = 0;
  const count = $('.party-count', btn);
  count.hidden = !party.unread;
  count.textContent = party.unread || '';
  $('.party-people', panel).textContent = party.people.join(', ');
  const log = $('.party-log', panel);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = party.log.map(x => (x.note
    ? `<p class="party-note">${esc(x.text)}</p>`
    : `<p class="party-msg${x.mine ? ' mine' : ''}"><strong>${esc(x.who)}</strong> ${esc(x.text)}</p>`)).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;
}
