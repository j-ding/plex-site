// Muted trailer previews, Netflix style: behind the home banner and title pages, and
// in a pop-out when the mouse rests on a poster. Trailers are the YouTube videos the
// server's metadata names (Jellyfin keeps them; Plex doesn't hand them out).
import { state } from './state.js';
import { esc, $$, store } from './util.js';

const HERO_DELAY = 1500;
const HOVER_DELAY = 800;
const YT = 'https://www.youtube-nocookie.com';

export function youTubeKey(urls) {
  for (const url of urls || []) {
    const m = String(url).match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}

export const trailersOn = () => store.get('trailers', true);
export function setTrailersOn(on) {
  store.set('trailers', on);
  if (!on) stopTrailers();
}
const soundOn = () => store.get('trailers.sound', false);

// Only servers that can name a trailer, and never for share-link guests.
export const canPreview = () => !!state.server?.trailer && !state.server.guest;
const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches || !!navigator.connection?.saveData;
const mayPlay = () => canPreview() && trailersOn() && !quiet() && !location.hash.startsWith('#/watch');
const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ---------- the YouTube player ---------- */

// The frame is taller than the video, so YouTube's title bar lands in the cropped-off
// letterbox; it fades in only once YouTube says it's actually playing.
function trailerBox(key) {
  const q = new URLSearchParams({
    autoplay: 1, mute: 1, controls: 0, loop: 1, playlist: key, playsinline: 1, rel: 0,
    iv_load_policy: 3, disablekb: 1, enablejsapi: 1, origin: location.origin,
  });
  const box = document.createElement('div');
  box.className = 'trailer';
  box.innerHTML = `<iframe src="${YT}/embed/${esc(key)}?${q}" allow="autoplay; encrypted-media" tabindex="-1" title="Trailer" aria-hidden="true"></iframe>`;
  const frame = box.firstElementChild;
  // Like YouTube's own API: say we're listening until the player answers.
  frame.addEventListener('load', () => {
    let tries = 0;
    const hello = setInterval(() => {
      if (!frame.isConnected || frame.dataset.heard || ++tries > 40) return void clearInterval(hello);
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'dingflix', channel: 'widget' }), YT);
    }, 250);
  });
  return box;
}

function command(frame, func) {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), YT);
}

window.addEventListener('message', e => {
  if (e.origin !== YT) return;
  const frame = $$('.trailer iframe').find(f => f.contentWindow === e.source);
  if (!frame) return;
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  if (!frame.dataset.heard) {
    frame.dataset.heard = '1';
    if (soundOn()) command(frame, 'unMute');
  }
  // 1 = playing. Errors (removed, age-restricted, blocked) never get there, so the
  // poster or backdrop simply stays.
  const playerState = data.event === 'onStateChange' ? data.info : data.info?.playerState;
  if (playerState === 1) frame.parentElement.classList.add('playing');
});

const soundButton = () => `
  <button type="button" class="trailer-sound" data-action="trailer-sound" aria-label="${soundOn() ? 'Mute trailer' : 'Turn trailer sound on'}">${soundOn() ? '🔊' : '🔇'}</button>`;

export function toggleTrailerSound() {
  const on = !soundOn();
  store.set('trailers.sound', on);
  $$('.trailer iframe').forEach(f => command(f, on ? 'unMute' : 'mute'));
  $$('.trailer-sound').forEach(b => b.outerHTML = soundButton());
}

/* ---------- banners ---------- */

let heroWatch = null;

// Plays the title's trailer behind a banner (home or title page) after a moment.
export function heroTrailer(hero, id) {
  if (!hero || !id || !mayPlay() || matchMedia('(max-width: 700px)').matches) return;
  setTimeout(async () => {
    const { key } = await state.server.trailer(id);
    if (!key || !hero.isConnected || !mayPlay() || hero.querySelector('.trailer')) return;
    const bg = hero.querySelector('.hero-bg');
    if (bg) bg.after(trailerBox(key));
    else hero.prepend(trailerBox(key));
    hero.insertAdjacentHTML('beforeend', soundButton());
    // Pause while it's scrolled away, carry on when it's back.
    heroWatch?.disconnect();
    heroWatch = new IntersectionObserver(([entry]) => {
      const frame = hero.querySelector('.trailer iframe');
      if (!preview) command(frame, entry.isIntersecting ? 'playVideo' : 'pauseVideo');
      hero.dataset.offscreen = entry.isIntersecting ? '' : '1';
    }, { threshold: 0.3 });
    heroWatch.observe(hero);
  }, HERO_DELAY);
}

function heroFrames(func) {
  $$('.hero:not([data-offscreen="1"]) .trailer iframe').forEach(f => command(f, func));
}

/* ---------- poster pop-outs ---------- */

let preview = null;
let hoverCard = null;
let hoverTimer = null;
let render = null;

// views.js hands over how to draw the meta line, so this module doesn't import it.
export function initPreviews(opts) {
  render = opts;
}

document.addEventListener('mouseover', e => {
  if (preview?.contains(e.target)) return;
  const card = e.target.closest?.('.card[data-id]');
  if (card === hoverCard) return;
  hoverCard = card;
  clearTimeout(hoverTimer);
  if (!card || !render || !finePointer() || !mayPlay()) return;
  hoverTimer = setTimeout(async () => {
    const { item, key } = await state.server.trailer(card.dataset.id);
    if (hoverCard !== card || !key || !card.isConnected || !mayPlay()) return;
    openPreview(card, item, key);
  }, HOVER_DELAY);
});

document.addEventListener('mouseout', e => {
  if (hoverCard && !hoverCard.contains(e.relatedTarget) && !preview?.contains(e.relatedTarget)) {
    hoverCard = null;
    clearTimeout(hoverTimer);
  }
});

function openPreview(card, item, key) {
  closePreview();
  const r = (card.querySelector('.card-img') || card).getBoundingClientRect();
  const gap = 12;
  const w = Math.min(Math.max(r.width * 1.7, 300), 420, innerWidth - gap * 2);
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, gap), innerWidth - gap - w);
  const top = Math.max(r.top + r.height / 2 - (w * 9) / 32 - 40, 72);
  const genres = (item.Genre || []).slice(0, 3).map(g => esc(g.tag)).join('<span class="sep">·</span>');
  const href = `#/title/${esc(item.ratingKey)}`;

  preview = document.createElement('div');
  preview.className = 'preview';
  preview.style.cssText = `left:${left + scrollX}px;top:${top + scrollY}px;width:${w}px`;
  preview.innerHTML = `
    <div class="preview-media">
      ${item.art || item.thumb ? `<img src="${esc(render.img(item.art || item.thumb, 640, 360))}" alt="">` : ''}
      <a class="preview-link" href="${href}" tabindex="-1" aria-hidden="true"></a>
      ${soundButton()}
    </div>
    <div class="preview-body">
      <div class="preview-actions">
        <button class="round light" data-play="${esc(item.ratingKey)}" aria-label="Play ${esc(item.title)}">▶</button>
        <a class="round" href="${href}" aria-label="More about ${esc(item.title)}">ⓘ</a>
      </div>
      <div class="preview-title">${esc(item.title)}</div>
      <div class="meta">${render.meta(item)}</div>
      ${genres ? `<div class="preview-genres">${genres}</div>` : ''}
    </div>`;
  preview.querySelector('.preview-media img, .preview-link').after(trailerBox(key));
  preview.addEventListener('mouseleave', e => {
    if (!hoverCard?.contains(e.relatedTarget)) closePreview();
  });
  document.body.append(preview);
  heroFrames('pauseVideo');
}

export function closePreview() {
  if (!preview) return;
  preview.remove();
  preview = null;
  hoverCard = null;
  heroFrames('playVideo');
}

// Every trailer stops when the player opens or they're switched off.
export function stopTrailers() {
  closePreview();
  heroWatch?.disconnect();
  $$('.trailer, .trailer-sound').forEach(el => el.remove());
}

// Scrolling (the page or a row) moves the poster out from under its pop-out.
window.addEventListener('scroll', closePreview, { passive: true, capture: true });
window.addEventListener('hashchange', () => (location.hash.startsWith('#/watch') ? stopTrailers() : closePreview()));
