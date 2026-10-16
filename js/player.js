import { state } from './state.js';
import { $, esc, store, uuid } from './util.js';
import { identity } from './plex.js';

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
    const streams = c.part.Stream || [];
    $('[data-tracks]', root).hidden = !(streams.filter(s => s.streamType === AUDIO).length > 1 || streams.some(s => s.streamType === SUBTITLE));
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

// Browsers can play H.264/AAC in MP4 natively — no server work needed — but only
// with the file's first audio track and no subtitles. Anything else goes through
// Plex's transcoder as HLS.
function canDirectPlay(c) {
  const media = c.item.Media[0];
  if (!media || (media.Part?.length ?? 0) > 1) return false;
  if (selected(c, SUBTITLE)) return false;
  const audio = streamsOf(c, AUDIO);
  if (audio.length > 1 && selected(c, AUDIO) && selected(c, AUDIO) !== audio[0]) return false;
  const container = (media.container || '').toLowerCase();
  const video = (media.videoCodec || '').toLowerCase();
  const audioCodec = (media.audioCodec || '').toLowerCase();
  return ['mp4', 'm4v', 'mov'].includes(container) && video === 'h264' && ['aac', 'mp3'].includes(audioCodec);
}

function streamParams(c, quality) {
  const params = {
    path: c.item.key,
    mediaIndex: 0,
    partIndex: 0,
    protocol: 'hls',
    fastSeek: 1,
    directPlay: 0,
    directStream: 1,
    directStreamAudio: 1,
    videoQuality: 100,
    // Subtitles are drawn into the video by the server, which handles every
    // format (text and image-based PGS/VobSub alike).
    subtitles: 'burn',
    subtitleSize: c.subSize,
    audioBoost: 100,
    hasMDE: 1,
    session: c.session,
    'X-Plex-Session-Identifier': c.session,
    ...identity(),
  };
  if (quality.bitrate) Object.assign(params, { maxVideoBitrate: quality.bitrate, videoResolution: quality.res });
  return params;
}

async function load(c, at = 0) {
  const loadId = ++c.loadId;
  teardown(c);
  c.started = false;
  c.startAt = at;
  const v = c.video;
  const server = state.server;
  const quality = QUALITIES.find(q => q.id === c.quality) || QUALITIES[0];
  setStatus(c, 'loading');

  const seekWhenReady = () => v.addEventListener('loadedmetadata', () => {
    if (at > 0) v.currentTime = at;
    v.play().catch(() => {});
  }, { once: true });

  if (!quality.bitrate && !c.forceHls && canDirectPlay(c)) {
    c.mode = 'direct';
    seekWhenReady();
    v.src = server.url(c.part.key);
    return;
  }

  c.session = uuid();
  const params = streamParams(c, quality);
  try {
    // The server must be asked how it will play the file before a stream can start.
    const decision = await server.get('/video/:/transcode/universal/decision', params);
    if (loadId !== c.loadId) return;
    if (decision.generalDecisionCode >= 2000) {
      return setStatus(c, 'error', decision.generalDecisionText || "The server can't play this file.");
    }
  } catch (err) {
    if (loadId === c.loadId) setStatus(c, 'error', `Couldn't start playback: ${err.message}`);
    return;
  }

  const src = server.url('/video/:/transcode/universal/start.m3u8', params);
  if (window.Hls?.isSupported()) {
    c.mode = 'hls';
    let recovered = false;
    const hls = (c.hls = new Hls({
      startPosition: at > 0 ? at : -1,
      // Segment/playlist URLs come back relative and without the token; add it.
      xhrSetup: (xhr, url) => {
        if (!url.includes('X-Plex-Token=')) xhr.open('GET', server.withToken(url), true);
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

function teardown(c) {
  if (c.hls) {
    c.hls.destroy();
    c.hls = null;
  }
  if ((c.mode === 'hls' || c.mode === 'native') && c.session) {
    state.server.stopTranscode(c.session).catch(() => {});
  }
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
  state.server.timeline({
    ratingKey: c.item.ratingKey,
    key: c.item.key,
    state: playState,
    time: Math.round(c.video.currentTime * 1000),
    duration: c.item.duration,
    'X-Plex-Session-Identifier': c.session || '',
  }).catch(() => {});
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
      ${subs.length ? `
        <h3>Subtitle size</h3>
        <div class="sizes">${SUB_SIZES.map(([v, l]) => `<button class="chip ${v === c.subSize ? 'on' : ''}" data-size="${v}">${l}</button>`).join('')}</div>` : ''}
    </div>`;
}

async function selectTrack(c, kind, id) {
  const type = kind === 'audio' ? AUDIO : SUBTITLE;
  const current = selected(c, type)?.id ?? 0;
  if (current === id) return;
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
  panel.onclick = e => {
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
      if (selected(c, SUBTITLE)) reload(c);
    }
  };
  // Clicking anywhere outside the panel closes it.
  root.addEventListener('click', e => {
    if (!panel.hidden && !e.target.closest('.tracks, [data-tracks]')) togglePanel(false);
  });

  video.addEventListener('playing', () => {
    c.started = true;
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
