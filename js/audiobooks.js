// Audiobooks (Jellyfin "Books" libraries): the Audiobooks page, a page for each book,
// and an audio player that keeps playing while you browse (a bar at the bottom), with
// 30-second skips, speed, a sleep timer, chapters and lock-screen controls.
import { state } from './state.js';
import { $, $$, esc, store, duration, uuid } from './util.js';
import { xo, loading, toast } from './views.js';

const SKIP = 30;
const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
const SLEEPS = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['chapter', 'End of chapter']];

const icon = (d, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="${d}"/>${extra}</svg>`;
const ICONS = {
  play: icon('M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z'),
  pause: icon('M6.5 5h3.5v14H6.5zm7.5 0h3.5v14H14z'),
  prev: icon('M6 6h2v12H6zm3.5 6 8.5 6V6z'),
  next: icon('M16 6h2v12h-2zM6 18l8.5-6L6 6z'),
  back: icon('M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z', '<text x="12" y="15.6" text-anchor="middle" font-size="6.4" font-weight="700" fill="currentColor">30</text>'),
  fwd: icon('M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8Z', '<text x="12" y="15.6" text-anchor="middle" font-size="6.4" font-weight="700" fill="currentColor">30</text>'),
  down: icon('M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z'),
  moon: icon('M12.3 2a10 10 0 1 0 9.7 12.4A8 8 0 0 1 12.3 2Z'),
  list: icon('M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z'),
  close: icon('M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z'),
};

const app = () => $('#app');
const stale = seq => seq !== state.seq;
const cover = (book, w) => (book?.cover ? state.server.image(book.cover, w) : '');
const sum = list => list.reduce((a, b) => a + b, 0);
const total = book => sum(book.parts.map(p => p.duration));

export const canListen = () => !!state.server?.audiobooks && !state.server.guest;

// "1:02:03" or "4:05".
export function clock(msec) {
  const t = Math.max(0, Math.floor((msec || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
const hoursLeft = msec => {
  const mins = Math.max(1, Math.round(msec / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
};

/* ---------- where you are in a book ---------- */

// Saved on this device every few seconds; Jellyfin only keeps audiobook positions
// past the first few minutes, so the device copy fills that gap.
const posKey = id => `bookPos.${state.server.id}.${state.server.userId}.${id}`;

function serverPlace(book) {
  let best = null;
  book.parts.forEach((p, i) => {
    if (p.lastPlayed && (!best || p.lastPlayed > best.when)) best = { part: i, at: p.viewOffset, when: p.lastPlayed, played: p.played };
  });
  if (book.parts.every(p => p.played)) return { part: 0, at: 0, when: best?.when || 0, done: true };
  if (!best) return null;
  if (best.played && !best.at) {
    // Finished that file: on to the next one not yet heard.
    const next = book.parts.findIndex((p, i) => i > best.part && !p.played);
    const any = next >= 0 ? next : book.parts.findIndex(p => !p.played);
    return { part: any, at: 0, when: best.when };
  }
  return { part: best.part, at: best.at, when: best.when };
}

// { part, at (ms into that file), when, done }, or null if never started.
export function placeIn(book) {
  const local = store.get(posKey(book.id));
  const server = serverPlace(book);
  // Another device (or Jellyfin's app) listened more recently: follow it.
  if (local && local.part < book.parts.length && (!server || local.when >= server.when - 120000)) return local;
  return server;
}

function savePlace(book, place) {
  store.set(posKey(book.id), { ...place, when: Date.now() });
}

export function progressOf(book, place = placeIn(book)) {
  const all = total(book);
  if (!place) return { elapsed: 0, total: all, started: false, done: false };
  if (place.done) return { elapsed: all, total: all, started: true, done: true };
  const elapsed = sum(book.parts.slice(0, place.part).map(p => p.duration)) + (place.at || 0);
  return { elapsed, total: all, started: elapsed > 1000, done: false };
}

/* ---------- chapters ---------- */

// One file with chapter marks: those. Several files: each file is a chapter.
const chapterCache = new Map();
export async function chapterList(book) {
  const key = `${book.id}:${book.parts.length}`;
  if (chapterCache.has(key)) return chapterCache.get(key);
  let list = null;
  if (book.parts.length === 1) {
    const marks = await state.server.chapters(book.parts[0].id).catch(() => []);
    if (marks.length > 1) list = marks.map((c, n) => ({ title: c.name || `Chapter ${n + 1}`, part: 0, start: c.start }));
  }
  list ||= book.parts.map((p, i) => ({ title: partName(p.title, book, i), part: i, start: 0 }));
  list.forEach((c, i) => {
    const next = list[i + 1];
    const end = next && next.part === c.part ? next.start : book.parts[c.part].duration;
    c.length = Math.max(0, end - c.start);
  });
  chapterCache.set(key, list);
  return list;
}

// File names like "The Hobbit - 03" become "Part 3"; real chapter names stay.
function partName(name, book, i) {
  const clean = (name || '').replace(book.title, '').replace(/^[\s\-_.:–]+|[\s\-_.:–]+$/g, '');
  if (!clean || /^\d+$/.test(clean)) return `Part ${i + 1}`;
  return clean;
}

const chapterAt = (chapters, part, msec) => {
  let idx = 0;
  chapters.forEach((c, i) => { if (c.part < part || (c.part === part && c.start <= msec + 250)) idx = i; });
  return idx;
};

/* ---------- finding books ---------- */

async function findBook(id, fresh = false) {
  const books = await state.server.audiobooks({ fresh });
  const book = books.find(b => b.id === id || b.parts.some(p => p.id === id));
  if (book || fresh) return book;
  return findBook(id, true);
}

/* ---------- cards and rows ---------- */

export function bookCard(book) {
  const pr = progressOf(book);
  const pct = pr.started && !pr.done ? Math.min(100, (pr.elapsed / pr.total) * 100) : 0;
  const src = cover(book, 400);
  return `
    <a class="card book-card" href="#/book/${esc(book.id)}" title="${esc(book.title)}">
      <div class="card-img">
        <span class="card-fallback">${esc(book.title)}</span>
        ${src ? `<img ${xo()}loading="lazy" src="${esc(src)}" alt="" onerror="this.remove()">` : ''}
        ${pct ? `<div class="progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
        ${pr.done ? `<span class="badge" aria-label="Finished">✓</span>` : ''}
      </div>
      <div class="card-text">
        <div class="card-title">${esc(book.title)}</div>
        <div class="card-sub">${esc(pct ? `${hoursLeft(pr.total - pr.elapsed)} left` : book.author)}</div>
      </div>
    </a>`;
}

function bookRow(title, books, link) {
  if (!books.length) return '';
  return `
    <section class="row">
      <h2>${esc(title)}${link ? ` <a class="see-all" href="${esc(link)}">See all ›</a>` : ''}</h2>
      <div class="row-track">
        <button class="row-nav prev" aria-label="Scroll left">‹</button>
        <div class="row-scroller">${books.map(bookCard).join('')}</div>
        <button class="row-nav next" aria-label="Scroll right">›</button>
      </div>
    </section>`;
}

const inProgress = books => books
  .map(b => ({ b, place: placeIn(b) }))
  .filter(x => x.place && !x.place.done && progressOf(x.b, x.place).started)
  .sort((a, b) => b.place.when - a.place.when)
  .map(x => x.b);

// For the home page.
export async function continueListeningRow() {
  if (!canListen()) return '';
  const books = await state.server.audiobooks();
  return bookRow('Continue Listening', inProgress(books).slice(0, 20), '#/audiobooks');
}

// For the search page: books whose title, author or narrator match.
export async function searchBooks(q) {
  if (!canListen()) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const books = await state.server.audiobooks();
  return books.filter(b => {
    const text = `${b.title} ${b.author} ${b.narrator}`.toLowerCase();
    return words.every(w => text.includes(w));
  }).slice(0, 40);
}
export const bookGrid = books => `<div class="grid books">${books.map(bookCard).join('')}</div>`;

/* ---------- pages ---------- */

const BOOK_SORTS = {
  title: ['Title', (a, b) => a.sortTitle.localeCompare(b.sortTitle)],
  author: ['Author', (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.sortTitle.localeCompare(b.sortTitle)],
  added: ['Recently added', (a, b) => b.addedAt - a.addedAt],
  listened: ['Recently listened', (a, b) => (placeIn(b)?.when || 0) - (placeIn(a)?.when || 0)],
};

export async function audiobooksView(seq) {
  document.title = 'Audiobooks · DingFlix';
  app().innerHTML = loading();
  const s = state.server;
  const [libs, books] = await Promise.all([s.bookLibraries(), s.audiobooks({ fresh: true })]);
  if (stale(seq)) return;
  if (!books.length) {
    app().innerHTML = `
      <div class="page-top pad empty">
        <h1 class="page-title">Audiobooks</h1>
        <p class="muted">${libs.length ? 'Your Books library has no audiobooks yet.' : 'There’s no audiobook library on this server yet.'}</p>
        ${s.admin ? `<p class="muted">In Jellyfin: <strong>Dashboard → Libraries → Add Media Library</strong>, content type <strong>Books</strong>, and point it at your audiobooks folder. Put each book in its own folder (with a <code>cover.jpg</code>), and number the files in order.</p>` : ''}
      </div>`;
    return;
  }
  const sort = BOOK_SORTS[store.get('bookSort')] ? store.get('bookSort') : 'title';
  const recent = [...books].sort(BOOK_SORTS.added[1]).slice(0, 20);
  app().innerHTML = `
    <div class="page-top pad"><h1 class="page-title">Audiobooks</h1></div>
    <div class="rows">
      ${bookRow('Continue Listening', inProgress(books))}
      ${books.length > 8 ? bookRow('Recently Added', recent) : ''}
    </div>
    <section class="pad browse">
      <div class="grid-head">
        <h2>All audiobooks <span class="muted">${books.length}</span></h2>
        <select id="sort" aria-label="Sort">${Object.entries(BOOK_SORTS).map(([k, [label]]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </div>
      <div id="book-grid"></div>
    </section>`;
  const draw = key => { $('#book-grid').innerHTML = bookGrid([...books].sort(BOOK_SORTS[key][1])); };
  draw(sort);
  $('#sort').addEventListener('change', e => {
    store.set('bookSort', e.target.value);
    draw(e.target.value);
  });
}

export async function bookView(seq, id) {
  app().innerHTML = loading();
  const book = await findBook(id);
  if (!book) throw new Error('That audiobook is no longer on the server.');
  const chapters = await chapterList(book);
  if (stale(seq)) return;
  document.title = `${book.title} · DingFlix`;
  const place = P.book?.id === book.id ? livePlace() : placeIn(book);
  const pr = progressOf(book, place);
  const nowAt = pr.started && !pr.done ? chapterAt(chapters, place.part, place.at) : -1;
  const src = cover(book, 600);
  const byline = [book.author && `by ${esc(book.author)}`, book.narrator && `read by ${esc(book.narrator)}`].filter(Boolean).join(' · ');
  const facts = [hoursLeft(pr.total), `${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}`, ...book.genres.slice(0, 2).map(esc)];

  app().innerHTML = `
    <section class="book-page" data-book="${esc(book.id)}">
      ${src ? `<div class="book-bg" style="background-image:url(${esc(JSON.stringify(src))})"></div>` : ''}
      <div class="book-top pad">
        <div class="book-cover">${src ? `<img ${xo()}src="${esc(src)}" alt="" onerror="this.remove()">` : ''}<span>${esc(book.title)}</span></div>
        <div class="book-info">
          <p class="book-kind">Audiobook</p>
          <h1>${esc(book.title)}</h1>
          ${byline ? `<p class="book-by">${byline}</p>` : ''}
          <p class="meta">${facts.join('<span class="sep">·</span>')}</p>
          ${pr.started && !pr.done ? `
            <div class="resume book-resume"><div class="progress"><span style="width:${((pr.elapsed / pr.total) * 100).toFixed(1)}%"></span></div>
            <small>${hoursLeft(pr.total - pr.elapsed)} left · ${esc(chapters[nowAt]?.title || '')}</small></div>` : ''}
          <div class="actions">
            <a class="btn primary" href="#/listen/${esc(book.id)}${pr.done ? '?start=1' : ''}">▶ ${pr.done ? 'Listen again' : pr.started ? 'Resume' : 'Listen'}</a>
            ${pr.started && !pr.done ? `<a class="btn" href="#/listen/${esc(book.id)}?start=1">↺ Start over</a>` : ''}
            <button class="btn" data-book-done="${pr.done ? 0 : 1}">${pr.done ? '✓ Finished' : 'Mark as finished'}</button>
          </div>
        </div>
      </div>
      ${book.summary ? `<p class="summary book-summary pad">${esc(book.summary)}</p>` : ''}
      <section class="pad chapters">
        <h2>Chapters</h2>
        <ol class="chapter-list">
          ${chapters.map((c, i) => `
            <li><a href="#/listen/${esc(book.id)}?ch=${i}" class="chapter ${i === nowAt ? 'now' : ''} ${pr.done || (nowAt > i) ? 'heard' : ''}">
              <span class="ch-num">${i === nowAt ? ICONS.play : i + 1}</span>
              <span class="ch-title">${esc(c.title)}</span>
              <span class="ch-time">${c.length ? clock(c.length) : ''}</span>
            </a></li>`).join('')}
        </ol>
      </section>
    </section>`;

  $('[data-book-done]').addEventListener('click', async e => {
    const done = e.currentTarget.dataset.bookDone === '1';
    e.currentTarget.disabled = true;
    try {
      await Promise.all(book.parts.map(p => (done ? state.server.scrobble(p.id) : state.server.unscrobble(p.id))));
      savePlace(book, { part: 0, at: 0, done });
      if (P.book?.id === book.id) P.done = done;
      toast(done ? `Marked “${book.title}” as finished.` : `“${book.title}” will start from the beginning.`);
    } catch (err) {
      toast(`Couldn't change it: ${err.message}`);
    }
    await state.server.audiobooks({ fresh: true }).catch(() => {});
    if (!stale(seq)) bookView(seq, id);
  });
}

/* ---------- the player ---------- */

const P = {
  book: null, chapters: [], part: 0, audio: null, session: null, root: null,
  full: false, sleep: null, chapter: -1, lastSave: 0, lastReport: 0, dragging: false, done: false,
};

const speed = () => (SPEEDS.includes(store.get('bookSpeed')) ? store.get('bookSpeed') : 1);
const nowMs = () => (P.audio ? P.audio.currentTime * 1000 : 0);
const partLength = () => (P.audio?.duration && isFinite(P.audio.duration) ? P.audio.duration * 1000 : P.book.parts[P.part].duration);
const livePlace = () => ({ part: P.part, at: nowMs(), when: Date.now(), done: P.done });

function audio() {
  if (P.audio) return P.audio;
  const a = (P.audio = new Audio());
  a.preload = 'auto';
  a.addEventListener('timeupdate', onTime);
  a.addEventListener('play', () => { report('playing'); update(); });
  a.addEventListener('pause', () => {
    if (!P.book) return;
    save();
    report('paused');
    update();
  });
  a.addEventListener('loadedmetadata', update);
  a.addEventListener('ended', onEnded);
  a.addEventListener('error', () => {
    if (!P.book || !a.src) return;
    toast('This audiobook couldn’t be played. The server may not be able to stream this file.');
    update();
  });
  window.addEventListener('pagehide', () => {
    if (!P.book) return;
    save();
    report('stopped', true);
  });
  return a;
}

function report(playState, keepalive = false) {
  if (!P.book || !P.session) return;
  if (playState !== 'stopped' && !P.audio.src) return;
  P.session.rate = P.audio.playbackRate;
  P.lastReport = Date.now();
  Promise.resolve(state.server.reportAudio(P.book.parts[P.part].id, P.session, playState, nowMs(), { keepalive })).catch(() => {});
}

function save() {
  if (!P.book) return;
  P.lastSave = Date.now();
  savePlace(P.book, { part: P.part, at: nowMs(), done: P.done });
}

function loadPart(i, at = 0, play = true) {
  const a = audio();
  if (P.session?.started) report('stopped');
  P.part = i;
  P.session = { id: uuid().replace(/-/g, ''), started: false };
  a.crossOrigin = 'anonymous';
  a.src = state.server.audioUrl(P.book.parts[i].id);
  a.defaultPlaybackRate = a.playbackRate = speed();
  if (at > 0) a.addEventListener('loadedmetadata', () => { a.currentTime = at / 1000; }, { once: true });
  if (play) a.play().catch(() => update());
  update();
}

function onTime() {
  if (!P.book) return;
  const a = P.audio;
  const ch = chapterAt(P.chapters, P.part, nowMs());
  if (ch !== P.chapter) {
    // Sleep at the end of the chapter: the chapter just changed.
    if (P.sleep?.mode === 'chapter' && P.chapter >= 0 && ch === P.sleep.chapter + 1) {
      P.sleep = null;
      a.pause();
    }
    P.chapter = ch;
    mediaMeta();
  }
  if (!a.paused && Date.now() - P.lastSave > 5000) save();
  if (!a.paused && Date.now() - P.lastReport > 10000) report('playing');
  if ('mediaSession' in navigator && a.duration && isFinite(a.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: a.duration, playbackRate: a.playbackRate, position: Math.min(a.currentTime, a.duration) }); } catch {}
  }
  update();
}

function onEnded() {
  if (!P.book) return;
  report('stopped');
  state.server.scrobble(P.book.parts[P.part].id).catch(() => {});
  P.book.parts[P.part].played = true;
  // The sleep timer was set for the end of this chapter (a whole file).
  const sleepNow = P.sleep?.mode === 'chapter';
  if (sleepNow) P.sleep = null;
  if (P.part + 1 < P.book.parts.length) {
    loadPart(P.part + 1, 0, !sleepNow);
    save();
    return;
  }
  P.done = true;
  savePlace(P.book, { part: 0, at: 0, done: true });
  toast(`You finished “${P.book.title}”.`);
  update();
}

function seekTo(part, at, play = !P.audio.paused) {
  if (part !== P.part) return loadPart(part, at, play);
  P.audio.currentTime = Math.max(0, at / 1000);
  if (play && P.audio.paused) P.audio.play().catch(() => {});
  save();
  update();
}

// Skipping past the end (or start) of a file carries on into the next (or previous) one.
function skip(sec) {
  const t = nowMs() + sec * 1000;
  if (t < 0 && P.part > 0) return seekTo(P.part - 1, Math.max(0, P.book.parts[P.part - 1].duration + t));
  if (t > partLength() && P.part + 1 < P.book.parts.length) return seekTo(P.part + 1, t - partLength());
  seekTo(P.part, Math.min(Math.max(0, t), partLength() - 500));
}

function goChapter(i, play = true) {
  const c = P.chapters[Math.max(0, Math.min(i, P.chapters.length - 1))];
  if (c) seekTo(c.part, c.start, play);
}

const currentChapter = () => chapterAt(P.chapters, P.part, nowMs());

function prevChapter() {
  const i = currentChapter();
  // A few seconds in: back to the start of this chapter; else the one before.
  if (nowMs() - P.chapters[i].start > 4000) return goChapter(i);
  goChapter(i - 1);
}

function setSleep(choice) {
  clearTimeout(P.sleepTimer);
  P.sleep = null;
  if (choice === 'chapter') P.sleep = { mode: 'chapter', chapter: P.chapter };
  else if (choice) {
    const until = Date.now() + choice * 60000;
    P.sleep = { mode: 'time', until, minutes: choice };
    P.sleepTimer = setTimeout(fadeOut, choice * 60000);
  }
  update();
}

// Lowers the volume over a few seconds, then pauses and puts the volume back.
function fadeOut() {
  const a = P.audio;
  const start = a.volume;
  let n = 0;
  const step = setInterval(() => {
    n++;
    a.volume = Math.max(0, start * (1 - n / 20));
    if (n >= 20) {
      clearInterval(step);
      a.pause();
      a.volume = start;
      P.sleep = null;
      update();
    }
  }, 200);
}

function mediaMeta() {
  if (!('mediaSession' in navigator) || !P.book) return;
  const c = P.chapters[P.chapter];
  const art = cover(P.book, 512);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: c?.title || P.book.title,
      artist: P.book.author || '',
      album: P.book.title,
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  } catch {}
}

function mediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  on('play', () => P.audio.play().catch(() => {}));
  on('pause', () => P.audio.pause());
  on('seekbackward', () => skip(-SKIP));
  on('seekforward', () => skip(SKIP));
  on('previoustrack', prevChapter);
  on('nexttrack', () => goChapter(currentChapter() + 1));
  on('seekto', d => seekTo(P.part, d.seekTime * 1000));
  on('stop', closeBook);
}

/* --- opening and closing --- */

// Opens the full-screen player for a book (#/listen/{id}), starting where you left off,
// at chapter ?ch=N, or from the beginning with ?start=1.
export async function openListen(id, params = new URLSearchParams()) {
  const book = P.book && (P.book.id === id || P.book.parts.some(p => p.id === id)) ? P.book : await findBook(id);
  if (!book) throw new Error('That audiobook is no longer on the server.');
  const ch = params.get('ch');
  const fromStart = params.has('start');
  if (ch != null || fromStart) history.replaceState(history.state, '', `#/listen/${book.id}`);
  if (P.book !== book || ch != null || fromStart) {
    if (P.book && P.book !== book) closeBook({ keepView: true });
    P.book = book;
    P.chapters = await chapterList(book);
    P.chapter = -1;
    P.done = false;
    const place = placeIn(book);
    let part = 0;
    let at = 0;
    if (ch != null) {
      const c = P.chapters[Number(ch)] || P.chapters[0];
      [part, at] = [c.part, c.start];
    } else if (!fromStart && place && !place.done) {
      [part, at] = [place.part, place.at];
    }
    loadPart(part, at, true);
    mediaHandlers();
  }
  P.full = true;
  draw();
}

// Leaving the full-screen player: it carries on in the bar at the bottom.
export function collapseListen() {
  if (!P.full) return false;
  P.full = false;
  draw();
  return true;
}

export function pauseBook() {
  if (P.audio && !P.audio.paused) P.audio.pause();
}

export function closeBook({ keepView = false } = {}) {
  if (!P.book) return;
  save();
  report('stopped');
  clearTimeout(P.sleepTimer);
  P.sleep = null;
  P.audio.pause();
  P.audio.removeAttribute('src');
  P.audio.load();
  P.book = null;
  P.session = null;
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; } catch {}
  }
  if (!keepView) {
    P.full = false;
    draw();
  }
}

function leaveFull() {
  if (!history.state?.root && location.hash.startsWith('#/listen/')) return history.back();
  location.replace(P.book ? `#/book/${P.book.id}` : '#/audiobooks');
}

/* --- drawing --- */

function rootEl() {
  if (P.root) return P.root;
  const r = (P.root = document.createElement('div'));
  r.id = 'listen';
  document.body.append(r);
  r.addEventListener('click', onClick);
  r.addEventListener('input', e => {
    if (!e.target.matches('.ab-seek')) return;
    P.dragging = true;
    const c = P.chapters[P.chapter];
    if (c) $('.ab-pos', r).textContent = clock(c.length * (e.target.value / 1000));
  });
  r.addEventListener('change', e => {
    if (!e.target.matches('.ab-seek')) return;
    P.dragging = false;
    const c = P.chapters[P.chapter];
    if (c) seekTo(c.part, c.start + c.length * (e.target.value / 1000));
  });
  document.addEventListener('keydown', e => {
    if (!P.full || !P.book || e.target.closest('input:not([type=range]), textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' && e.target.closest('button, a')) return; // the button itself handles it
    if (e.key === ' ' || e.key === 'k') toggle();
    else if (e.key === 'ArrowLeft' || e.key === 'j') skip(-SKIP);
    else if (e.key === 'ArrowRight' || e.key === 'l') skip(SKIP);
    else if (e.key === 'Escape') {
      if ($('.ab-pop', r) || !$('.ab-sheet', r)?.hidden) closePops();
      else leaveFull();
    } else return;
    e.preventDefault();
  });
  return r;
}

function toggle() {
  if (!P.book) return;
  if (P.audio.paused) {
    // Finished: start again from the top.
    if (P.done) {
      P.done = false;
      return goChapter(0);
    }
    P.audio.play().catch(() => {});
  } else P.audio.pause();
}

function closePops() {
  $$('.ab-pop', P.root).forEach(p => p.remove());
  const sheet = $('.ab-sheet', P.root);
  if (sheet) sheet.hidden = true;
}

function onClick(e) {
  const t = e.target.closest('[data-ab]');
  if (!t) {
    if (!e.target.closest('.ab-pop')) $$('.ab-pop', P.root).forEach(p => p.remove());
    return;
  }
  const act = t.dataset.ab;
  if (act !== 'speed' && act !== 'sleep') $$('.ab-pop', P.root).forEach(p => p.remove());
  switch (act) {
    case 'toggle': return toggle();
    case 'back': return skip(-SKIP);
    case 'fwd': return skip(SKIP);
    case 'prev': return prevChapter();
    case 'next': return goChapter(currentChapter() + 1);
    case 'expand': return void (location.hash = `#/listen/${P.book.id}`);
    case 'collapse': return leaveFull();
    case 'close': return closeBook();
    case 'chapters': {
      const sheet = $('.ab-sheet', P.root);
      sheet.hidden = !sheet.hidden;
      if (!sheet.hidden) $('.ab-ch.now', sheet)?.scrollIntoView({ block: 'center' });
      return;
    }
    case 'chapter':
      closePops();
      return goChapter(Number(t.dataset.i));
    case 'speed':
    case 'sleep':
      return openPop(t, act);
    case 'set-speed': {
      const v = Number(t.dataset.v);
      store.set('bookSpeed', v);
      P.audio.defaultPlaybackRate = P.audio.playbackRate = v;
      $$('.ab-pop', P.root).forEach(p => p.remove());
      report(P.audio.paused ? 'paused' : 'playing');
      return update();
    }
    case 'set-sleep':
      $$('.ab-pop', P.root).forEach(p => p.remove());
      return setSleep(t.dataset.v === 'chapter' ? 'chapter' : Number(t.dataset.v));
  }
}

function openPop(button, kind) {
  const open = $(`.ab-pop[data-kind=${kind}]`, P.root);
  $$('.ab-pop', P.root).forEach(p => p.remove());
  if (open) return;
  const items = kind === 'speed'
    ? SPEEDS.map(v => `<button data-ab="set-speed" data-v="${v}" class="${v === P.audio.playbackRate ? 'on' : ''}">${v}×</button>`)
    : [...SLEEPS.map(([v, label]) => `<button data-ab="set-sleep" data-v="${v}" class="${(v === 'chapter' ? P.sleep?.mode === 'chapter' : P.sleep?.minutes === v) ? 'on' : ''}">${label}</button>`),
      P.sleep ? `<button data-ab="set-sleep" data-v="0">Turn off</button>` : ''];
  button.parentElement.insertAdjacentHTML('beforeend', `
    <div class="ab-pop" data-kind="${kind}" role="menu">
      <p>${kind === 'speed' ? 'Playback speed' : 'Stop playing in'}</p>${items.join('')}
    </div>`);
}

function draw() {
  const r = rootEl();
  document.body.classList.toggle('ab-mini-on', !!P.book && !P.full);
  document.body.classList.toggle('ab-full-on', !!P.book && P.full);
  if (!P.book) {
    r.className = '';
    r.innerHTML = '';
    return;
  }
  const b = P.book;
  const src = cover(b, 600);
  const coverImg = w => (src ? `<img ${xo()}src="${esc(cover(b, w))}" alt="" onerror="this.remove()">` : '');
  if (!P.full) {
    r.className = 'ab-mini';
    r.innerHTML = `
      <div class="ab-mini-bar"><span></span></div>
      <button class="ab-mini-open" data-ab="expand" aria-label="Open the player">
        <span class="ab-mini-cover">${coverImg(120)}</span>
        <span class="ab-mini-text"><strong>${esc(b.title)}</strong><small class="ab-chapter"></small></span>
      </button>
      <button class="ab-btn" data-ab="back" aria-label="Back 30 seconds">${ICONS.back}</button>
      <button class="ab-btn ab-play" data-ab="toggle" aria-label="Play"></button>
      <button class="ab-btn ab-hide-phone" data-ab="fwd" aria-label="Forward 30 seconds">${ICONS.fwd}</button>
      <button class="ab-btn ab-x" data-ab="close" aria-label="Stop listening">${ICONS.close}</button>`;
    return update();
  }
  r.className = 'ab-full';
  r.innerHTML = `
    ${src ? `<div class="ab-bg" style="background-image:url(${esc(JSON.stringify(src))})"></div>` : ''}
    <div class="ab-top">
      <button class="ab-btn" data-ab="collapse" aria-label="Minimize">${ICONS.down}</button>
      <a class="ab-top-title" href="#/book/${esc(b.id)}">${esc(b.title)}</a>
      <button class="ab-btn" data-ab="chapters" aria-label="Chapters">${ICONS.list}</button>
    </div>
    <div class="ab-main">
      <div class="ab-cover"><span>${esc(b.title)}</span>${coverImg(600)}</div>
      <div class="ab-info">
        <h1 class="ab-chapter"></h1>
        <p>${esc(b.title)}${b.author ? ` · ${esc(b.author)}` : ''}</p>
      </div>
      <input class="ab-seek" type="range" min="0" max="1000" value="0" aria-label="Position in chapter">
      <div class="ab-times"><span class="ab-pos">0:00</span><span class="ab-left"></span></div>
      <div class="ab-controls">
        <button class="ab-btn" data-ab="prev" aria-label="Previous chapter">${ICONS.prev}</button>
        <button class="ab-btn ab-big" data-ab="back" aria-label="Back 30 seconds">${ICONS.back}</button>
        <button class="ab-btn ab-play" data-ab="toggle" aria-label="Play"></button>
        <button class="ab-btn ab-big" data-ab="fwd" aria-label="Forward 30 seconds">${ICONS.fwd}</button>
        <button class="ab-btn" data-ab="next" aria-label="Next chapter">${ICONS.next}</button>
      </div>
      <div class="ab-extra">
        <div class="ab-pop-wrap"><button class="ab-pill" data-ab="speed"><span class="ab-speed"></span></button></div>
        <div class="ab-pop-wrap"><button class="ab-pill" data-ab="sleep">${ICONS.moon}<span class="ab-sleep"></span></button></div>
        <button class="ab-pill" data-ab="chapters">${ICONS.list}<span>Chapters</span></button>
      </div>
      <p class="ab-book-left"></p>
    </div>
    <div class="ab-sheet" hidden>
      <div class="ab-sheet-head"><h2>Chapters</h2><button class="ab-btn" data-ab="chapters" aria-label="Close">${ICONS.close}</button></div>
      <ol>${P.chapters.map((c, i) => `
        <li><button class="ab-ch" data-ab="chapter" data-i="${i}">
          <span class="ch-num">${i + 1}</span><span class="ch-title">${esc(c.title)}</span><span class="ch-time">${c.length ? clock(c.length) : ''}</span>
        </button></li>`).join('')}</ol>
    </div>`;
  update();
}

function update() {
  const r = P.root;
  if (!r || !P.book) return;
  const a = P.audio;
  const playing = a && !a.paused;
  $$('.ab-play', r).forEach(b => {
    b.innerHTML = playing ? ICONS.pause : ICONS.play;
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  const t = nowMs();
  const idx = P.chapter >= 0 ? P.chapter : chapterAt(P.chapters, P.part, t);
  const c = P.chapters[idx];
  const into = c ? Math.max(0, t - c.start) : 0;
  const len = c?.length || partLength() || 0;
  $$('.ab-chapter', r).forEach(el => { el.textContent = P.done ? 'Finished' : c?.title || P.book.title; });
  const all = total(P.book);
  const elapsed = sum(P.book.parts.slice(0, P.part).map(p => p.duration)) + t;
  const bar = $('.ab-mini-bar span', r);
  if (bar) bar.style.width = `${all ? Math.min(100, (elapsed / all) * 100) : 0}%`;
  if (!P.full) return;
  const seek = $('.ab-seek', r);
  if (!P.dragging && seek) {
    seek.value = len ? Math.round((into / len) * 1000) : 0;
    seek.style.setProperty('--fill', `${seek.value / 10}%`);
    $('.ab-pos', r).textContent = clock(into);
  }
  const rate = a?.playbackRate || 1;
  $('.ab-left', r).textContent = `−${clock((len - into) / rate)}`;
  $('.ab-speed', r).textContent = `${rate}×`;
  $('.ab-sleep', r).textContent = !P.sleep ? 'Sleep' : P.sleep.mode === 'chapter' ? 'End of chapter' : clock(P.sleep.until - Date.now());
  $('.ab-book-left', r).textContent = P.done ? 'You finished this book.'
    : `Chapter ${idx + 1} of ${P.chapters.length} · ${hoursLeft((all - elapsed) / rate)} left${rate !== 1 ? ` at ${rate}×` : ''}`;
  $$('.ab-ch', r).forEach((b, i) => {
    b.classList.toggle('now', i === idx);
    b.classList.toggle('heard', i < idx);
  });
  // The sleep countdown ticks even while paused between timeupdates.
  clearTimeout(P.tick);
  if (P.sleep?.mode === 'time') P.tick = setTimeout(update, 1000);
}
