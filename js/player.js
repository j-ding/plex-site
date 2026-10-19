import { state } from './state.js';
import { $, esc, store } from './util.js';

const QUALITIES = [
  { id: 'original', label: 'Original quality' },
  { id: '1080', label: '1080p · 8 Mbps', bitrate: 8000, res: '1920x1080' },
  { id: '720', label: '720p · 4 Mbps', bitrate: 4000, res: '1280x720' },
  { id: '480', label: '480p · 1.5 Mbps', bitrate: 1500, res: '720x480' },
];
const SUB_SIZES = [
  [75, 'Small'],
  [100, 'Normal'],
  [125, 'Large'],
  [150, 'Huge'],
];
const AUDIO = 2;
const SUBTITLE = 3;
const SUB_LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['ru', 'Russian'],
  ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['id', 'Indonesian'],
];

function defaultSubLanguage() {
  const saved = store.get('subLang');
  if (saved) return saved;
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUB_LANGUAGES.some(([code]) => code === browser) ? browser : 'en';
}

let ctx = null;

export async function openPlayer(ratingKey, { fromStart = false } = {}) {
  if (ctx?.ratingKey === ratingKey) return;
  closePlayer();

  const root = $('#player');
  root.innerHTML = `
    <video playsinline controls></video>
    <div class="player-bar">
      <button class="icon-btn" data-close aria-label="Back">←</button>
      <div class="player-title"></div>
      <button class="btn small" data-next hidden>Next episode ›</button>
      <button class="icon-btn" data-tracks aria-label="Audio and subtitles" title="Audio & subtitles" hidden>
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v10h2v1.17L7.17 16H20V6H4Zm2 3h5v2H6V9Zm7 0h5v2h-5V9Zm-7 3h9v2H6v-2Zm11 0h1v2h-1v-2Z"/></svg>
      </button>
      <select class="quality" aria-label="Quality">${QUALITIES.map(q => `<option value="${q.id}">${q.label}</option>`).join('')}</select>
    </div>
    <div class="tracks" role="dialog" aria-label="Audio and subtitles" hidden></div>
    <div class="player-status"></div>
    <div class="upnext" hidden></div>`;
  root.hidden = false;
  document.body.classList.add('player-open');

  const c = (ctx = {
    ratingKey,
    root,
    video: $('video', root),
    quality: store.get('quality', 'original'),
    subSize: store.get('subtitleSize', 100),
    loadId: 0,
  });
  if (!QUALITIES.some(q => q.id === c.quality)) c.quality = 'original';
  $('.quality', root).value = c.quality;
  applySubSize(c);
  bindUi(c);
  setStatus(c, 'loading');

  try {
    const item = await state.server.metadata(ratingKey);
    if (ctx !== c) return;
    c.item = item;
    c.part = item.Media?.[0]?.Part?.[0];
    if (!c.part) throw new Error('This title has no playable file.');
    const [main, sub] = item.type === 'episode'
      ? [item.grandparentTitle, `S${item.parentIndex}:E${item.index} · ${item.title}`]
      : [item.title, item.year || ''];
    $('.player-title', root).innerHTML = `<strong>${esc(main)}</strong><span>${esc(sub)}</span>`;
    document.title = main;
    // Always available: even files without subtitles can find some online.
    $('[data-tracks]', root).hidden = false;
    renderTracks(c);
    load(c, fromStart ? 0 : (item.viewOffset || 0) / 1000);
    if (item.type === 'episode') findNext(c);
  } catch (err) {
    if (ctx === c) setStatus(c, 'error', err.message);
  }
}

export function closePlayer() {
  const c = ctx;
  if (!c) return;
  ctx = null;
  report(c, 'stopped');
  c.started = false;
  c.loadId++;
  clearInterval(c.timer);
  clearInterval(c.countdown);
  clearTimeout(c.hideTimer);
  clearTimeout(c.watchdog);
  document.removeEventListener('keydown', c.onKey);
  teardown(c);
  c.root.hidden = true;
  c.root.innerHTML = '';
  c.root.className = '';
  document.body.classList.remove('player-open');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/* ---------- streaming ---------- */

const streamsOf = (c, type) => (c.part.Stream || []).filter(s => s.streamType === type);
const selected = (c, type) => streamsOf(c, type).find(s => s.selected);

async function load(c, at = 0) {
  const loadId = ++c.loadId;
  teardown(c);
  c.started = false;
  c.startAt = at;
  const v = c.video;
  const server = state.server;
  const quality = QUALITIES.find(q => q.id === c.quality) || QUALITIES[0];
  setStatus(c, 'loading');

  // Safety net: if nothing has played after a while (e.g. the server is busy
  // converting another video), retry once, then explain instead of spinning forever.
  clearTimeout(c.watchdog);
  c.watchdog = setTimeout(() => {
    if (ctx !== c || loadId !== c.loadId || c.started) return;
    if (!c.retried) {
      c.retried = true;
      load(c, at);
    } else {
      setStatus(c, 'error', 'The server is taking too long to start this video. It may be busy with another stream. Try again, or pick a lower quality.');
    }
  }, 25000);

  const seekWhenReady = () => v.addEventListener('loadedmetadata', () => {
    if (at > 0) v.currentTime = at;
    v.play().catch(() => {});
  }, { once: true });

  // The server decides: play the file as-is, or stream a converted (HLS) version.
  let plan;
  try {
    plan = await server.playback(c.item, { quality, subSize: c.subSize, forceTranscode: c.forceHls, startAt: at });
  } catch (err) {
    if (loadId === c.loadId) setStatus(c, 'error', err.message || "Couldn't start playback.");
    return;
  }
  if (loadId !== c.loadId) return void server.stopPlayback(plan);
  c.plan = plan;
  // A subtitle file from another site only loads if the video is fetched with CORS.
  if (plan.textTrack) v.crossOrigin = 'anonymous';
  else v.removeAttribute('crossorigin');
  attachTextTrack(c);

  if (plan.mode === 'direct') {
    c.mode = 'direct';
    seekWhenReady();
    v.src = plan.url;
    return;
  }

  const src = plan.url;
  if (window.Hls?.isSupported()) {
    c.mode = 'hls';
    let recovered = false;
    const hls = (c.hls = new Hls({
      startPosition: at > 0 ? at : -1,
      // Segment/playlist URLs can come back without credentials; add them.
      xhrSetup: (xhr, url) => {
        const authorized = server.authorizeUrl(url);
        if (authorized !== url) xhr.open('GET', authorized, true);
      },
    }));
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls.recoverMediaError();
      } else {
        setStatus(c, 'error', `Playback failed (${d.details}). The server may not be able to stream this file — try a lower quality.`);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    c.mode = 'native'; // Safari on iOS
    seekWhenReady();
    v.src = src;
  } else {
    setStatus(c, 'error', "This browser can't play streamed video.");
  }
}

// Subtitles the browser draws itself (Jellyfin text subtitles), so their size can change live.
function attachTextTrack(c) {
  c.video.querySelectorAll('track').forEach(t => t.remove());
  const sub = c.plan?.textTrack;
  if (!sub) return;
  const track = document.createElement('track');
  Object.assign(track, { kind: 'subtitles', label: sub.label || 'Subtitles', srclang: sub.language || '', src: sub.url, default: true });
  c.video.append(track);
  track.track.mode = 'showing';
  track.addEventListener('load', () => (track.track.mode = 'showing'));
}

function applySubSize(c) {
  c.root.style.setProperty('--sub-scale', String(c.subSize / 100));
}

function teardown(c) {
  if (c.hls) {
    c.hls.destroy();
    c.hls = null;
  }
  c.video.querySelectorAll('track').forEach(t => t.remove());
  if (c.plan && c.mode !== 'direct') state.server.stopPlayback(c.plan);
  c.plan = null;
  c.mode = null;
  c.video.removeAttribute('src');
  c.video.load();
}

// Restart the stream at the current position (after a quality/track change).
function reload(c) {
  load(c, c.started ? c.video.currentTime : c.startAt || 0);
}

// Tells the server where we are, so "Continue Watching" and watched status stay in sync.
function report(c, playState) {
  if (!c.started || !c.item) return;
  Promise.resolve(state.server.reportPlayback(c.item, c.plan, playState, c.video.currentTime * 1000)).catch(() => {});
}

/* ---------- audio & subtitle tracks ---------- */

function trackLabel(s) {
  const main = s.displayTitle || s.language || `Track ${s.index}`;
  // Many files tag every track with the release name; that's noise, not a description.
  const looksLikeFilename = (s.title?.match(/\./g) || []).length >= 3;
  return { main, extra: s.title && !looksLikeFilename && !main.includes(s.title) ? s.title : '' };
}

function trackButton(kind, id, label, on, extra = '') {
  return `
    <button class="track ${on ? 'on' : ''}" data-kind="${kind}" data-id="${id}" aria-pressed="${on}">
      <span class="check">${on ? '✓' : ''}</span>
      <span>${esc(label)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>
    </button>`;
}

function renderTracks(c) {
  const panel = $('.tracks', c.root);
  if (!panel || !c.part) return;
  const audio = streamsOf(c, AUDIO);
  const subs = streamsOf(c, SUBTITLE);
  const subOn = selected(c, SUBTITLE);
  panel.innerHTML = `
    <div class="tracks-col">
      <h3>Audio</h3>
      ${audio.map((s, i) => {
        const { main, extra } = trackLabel(s);
        return trackButton('audio', s.id, main, s.selected || (!selected(c, AUDIO) && i === 0), extra);
      }).join('')}
    </div>
    <div class="tracks-col">
      <h3>Subtitles</h3>
      ${trackButton('sub', 0, 'Off', !subOn)}
      ${subs.map(s => {
        const { main, extra } = trackLabel(s);
        return trackButton('sub', s.id, main, !!s.selected, extra);
      }).join('')}
      ${c.subSearch ? '' : `<button class="find-subs" data-find>Find subtitles online…</button>`}
      ${subs.length && state.server.supports?.subtitleSize ? `
        <h3>Subtitle size</h3>
        <div class="sizes">${SUB_SIZES.map(([v, l]) => `<button class="chip ${v === c.subSize ? 'on' : ''}" data-size="${v}">${l}</button>`).join('')}</div>` : ''}
    </div>
    ${c.subSearch ? renderSubSearch(c.subSearch) : ''}`;
}

/* ---------- online subtitles (OpenSubtitles, via the server) ---------- */

function renderSubSearch(search) {
  const { lang, busy, error, results, downloading } = search;
  let body;
  if (busy) body = `<div class="sub-busy"><div class="spinner"></div> Searching…</div>`;
  else if (error) body = `<p class="error">${esc(error)}</p>`;
  else if (!results.length) body = `<p class="muted">No subtitles found in this language.</p>`;
  else {
    body = `<div class="sub-results">${results.map((r, i) => `
      <button class="sub-result" data-result="${i}" ${downloading != null ? 'disabled' : ''}>
        <span class="sub-name">${esc(r.title || r.displayTitle || 'Subtitle')}</span>
        <span class="sub-tags">
          ${downloading === i ? '<span class="tag good">Downloading…</span>' : ''}
          ${r.perfectMatch ? '<span class="tag good">Matches your file</span>' : ''}
          ${r.hearingImpaired ? '<span class="tag">SDH</span>' : ''}
          <span class="muted">${esc(r.providerTitle || '')}</span>
        </span>
      </button>`).join('')}</div>`;
  }
  return `
    <div class="sub-search">
      <div class="sub-search-head">
        <h3>Find subtitles online</h3>
        <select data-lang aria-label="Subtitle language">
          ${SUB_LANGUAGES.map(([code, name]) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
      </div>
      ${body}
    </div>`;
}

async function searchSubtitles(c, lang) {
  store.set('subLang', lang);
  c.subSearch = { lang, busy: true, results: [] };
  renderTracks(c);
  const search = c.subSearch;
  try {
    search.results = (await state.server.searchSubtitles(c.item.ratingKey, lang)).slice(0, 20);
  } catch (err) {
    search.error = `Search failed: ${err.message}`;
  }
  search.busy = false;
  if (ctx === c && c.subSearch === search) renderTracks(c);
}

async function downloadSubtitle(c, index) {
  const search = c.subSearch;
  if (!search || search.downloading != null) return;
  search.downloading = index;
  search.error = null;
  renderTracks(c);
  const before = new Set(streamsOf(c, SUBTITLE).map(s => s.id));
  try {
    await state.server.downloadSubtitle(c.item.ratingKey, search.results[index], search.lang);
    // The server fetches it in the background; wait for the new track to appear.
    let added;
    for (let tries = 0; tries < 15 && !added; tries++) {
      const part = (await state.server.metadata(c.item.ratingKey)).Media?.[0]?.Part?.[0];
      added = part?.Stream?.find(s => s.streamType === SUBTITLE && !before.has(s.id));
      if (added) c.part.Stream = part.Stream;
      else await new Promise(r => setTimeout(r, 1000));
    }
    if (ctx !== c) return;
    if (!added) throw new Error('the server did not add it');
    c.subSearch = null;
    c.closePanel();
    await selectTrack(c, 'sub', added.id, { force: true });
  } catch (err) {
    if (ctx !== c) return;
    search.downloading = null;
    search.error = `Couldn't download that subtitle: ${err.message}`;
    renderTracks(c);
  }
}

async function selectTrack(c, kind, id, { force = false } = {}) {
  const type = kind === 'audio' ? AUDIO : SUBTITLE;
  const current = selected(c, type)?.id ?? 0;
  if (current === id && !force) return;
  try {
    await state.server.selectStreams(c.part.id, kind === 'audio' ? { audioStreamID: id } : { subtitleStreamID: id });
  } catch (err) {
    console.error(err);
    return;
  }
  if (ctx !== c) return;
  streamsOf(c, type).forEach(s => (s.selected = s.id === id));
  c.forceHls = false;
  renderTracks(c);
  reload(c);
}

/* ---------- UI ---------- */

function setStatus(c, kind, message) {
  const el = $('.player-status', c.root);
  if (!el) return;
  if (kind === 'loading') el.innerHTML = `<div class="spinner"></div>`;
  else if (kind === 'error') {
    el.innerHTML = `<div class="player-error"><p>${esc(message)}</p><button class="btn primary small" data-close>Go back</button></div>`;
    $('[data-close]', el).onclick = () => leave(c);
  } else el.innerHTML = '';
}

function bindUi(c) {
  const { root, video } = c;
  const panel = $('.tracks', root);
  const poke = () => {
    root.classList.add('ui');
    clearTimeout(c.hideTimer);
    c.hideTimer = setTimeout(() => {
      if (panel.hidden) root.classList.remove('ui');
    }, 3000);
  };
  const togglePanel = open => {
    panel.hidden = !(open ?? panel.hidden);
    root.classList.toggle('panel-open', !panel.hidden);
    poke();
  };
  c.closePanel = () => togglePanel(false);
  root.addEventListener('mousemove', poke);
  root.addEventListener('touchstart', poke, { passive: true });
  poke();

  $('.player-bar [data-close]', root).onclick = () => leave(c);
  $('[data-next]', root).onclick = () => c.next && goTo(c.next.ratingKey);
  $('[data-tracks]', root).onclick = e => {
    e.stopPropagation();
    togglePanel();
  };
  $('.quality', root).onchange = e => {
    c.quality = e.target.value;
    store.set('quality', c.quality);
    if (c.item) reload(c);
  };
  panel.onchange = e => {
    if (e.target.matches('[data-lang]')) searchSubtitles(c, e.target.value);
  };
  panel.onclick = e => {
    // Clicks here can re-render the panel (detaching e.target), so keep them from
    // reaching the "click outside closes the panel" handler below.
    e.stopPropagation();
    if (e.target.closest('[data-find]')) return void searchSubtitles(c, defaultSubLanguage());
    const result = e.target.closest('[data-result]');
    if (result) return void downloadSubtitle(c, Number(result.dataset.result));
    const track = e.target.closest('.track');
    if (track) {
      togglePanel(false);
      selectTrack(c, track.dataset.kind, Number(track.dataset.id));
    }
    const size = e.target.closest('[data-size]');
    if (size) {
      c.subSize = Number(size.dataset.size);
      store.set('subtitleSize', c.subSize);
      renderTracks(c);
      applySubSize(c);
      // Burned-in subtitles need the stream restarted at the new size; browser-drawn ones don't.
      if (selected(c, SUBTITLE) && !c.plan?.textTrack) reload(c);
    }
  };
  // Clicking anywhere outside the panel closes it.
  root.addEventListener('click', e => {
    if (!panel.hidden && !e.target.closest('.tracks, [data-tracks]')) togglePanel(false);
  });

  video.addEventListener('playing', () => {
    c.started = true;
    c.retried = false;
    setStatus(c, null);
    report(c, 'playing');
  });
  video.addEventListener('canplay', () => setStatus(c, null));
  video.addEventListener('waiting', () => setStatus(c, 'loading'));
  video.addEventListener('play', () => root.classList.remove('paused'));
  video.addEventListener('pause', () => {
    root.classList.add('paused');
    if (!video.ended) report(c, 'paused');
  });
  video.addEventListener('ended', () => {
    report(c, 'stopped');
    state.server.scrobble(c.ratingKey).catch(() => {});
    if (c.next) upNext(c);
  });
  video.addEventListener('error', () => {
    if (c.mode === 'direct') {
      // Our codec guess was wrong; let the server transcode instead.
      c.forceHls = true;
      load(c, video.currentTime || 0);
    } else if (c.mode === 'native') {
      setStatus(c, 'error', "This video couldn't be played.");
    }
  });

  c.timer = setInterval(() => {
    if (!video.paused) report(c, 'playing');
  }, 10000);

  c.onKey = e => {
    if (e.target === video || e.target.closest?.('input, select, textarea, button')) return;
    switch (e.key) {
      case ' ':
      case 'k':
        video.paused ? video.play() : video.pause();
        break;
      case 'ArrowRight':
        video.currentTime += 10;
        break;
      case 'ArrowLeft':
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'f':
        document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.();
        break;
      case 'Escape':
        if (!panel.hidden) togglePanel(false);
        else if (!document.fullscreenElement) leave(c);
        break;
      default:
        return;
    }
    e.preventDefault();
    poke();
  };
  document.addEventListener('keydown', c.onKey);
}

async function findNext(c) {
  try {
    const episodes = await state.server.allLeaves(c.item.grandparentRatingKey);
    const i = episodes.findIndex(e => String(e.ratingKey) === String(c.ratingKey));
    if (ctx !== c || i < 0 || !episodes[i + 1]) return;
    c.next = episodes[i + 1];
    $('[data-next]', c.root).hidden = false;
  } catch {}
}

function upNext(c) {
  const n = c.next;
  const box = $('.upnext', c.root);
  let left = 10;
  const paint = () => {
    box.innerHTML = `
      ${n.thumb ? `<img src="${esc(state.server.image(n.thumb, 320, 180))}" alt="">` : ''}
      <div>
        <small>Up next · S${esc(n.parentIndex)}:E${esc(n.index)}</small>
        <strong>${esc(n.title)}</strong>
        <div class="actions">
          <button class="btn primary small" data-go>Play now (${left})</button>
          <button class="btn small" data-cancel>Cancel</button>
        </div>
      </div>`;
  };
  paint();
  box.hidden = false;
  box.onclick = e => {
    if (e.target.closest('[data-go]')) goTo(n.ratingKey);
    if (e.target.closest('[data-cancel]')) {
      clearInterval(c.countdown);
      box.hidden = true;
    }
  };
  c.countdown = setInterval(() => {
    if (--left <= 0) {
      clearInterval(c.countdown);
      goTo(n.ratingKey);
    } else paint();
  }, 1000);
}

// Swap to another episode without adding a history entry, so Back still exits the player.
function goTo(ratingKey) {
  history.replaceState(history.state, '', `#/watch/${ratingKey}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function leave(c) {
  if (!history.state?.root) return history.back();
  // Opened via a direct link: there's nothing in-app to go back to, so show the title page.
  const it = c.item;
  location.replace(!it ? '#/' : it.type === 'episode' ? `#/title/${it.grandparentRatingKey}?season=${it.parentRatingKey}` : `#/title/${it.ratingKey}`);
}
