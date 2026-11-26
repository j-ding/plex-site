// Extras from the studios' own YouTube channels (featurettes, behind the scenes, bloopers,
// trailers), as listed on TMDB. Needs a free TMDB API key; the owner saves it once in
// Manage and the Jellyfin server hands it to everyone's DingFlix.
import { state } from './state.js';
import { store, esc } from './util.js';

const API = 'https://api.themoviedb.org/3';
const YT = 'https://www.youtube-nocookie.com';
const KEY_RE = /^[\w.-]{20,400}$/;
const cache = new Map();
let serverKey = null; // promise, per server

export const validKey = key => KEY_RE.test(key || '');

// This device's key, else the one saved on the Jellyfin server.
export async function tmdbKey() {
  const own = store.get('tmdbKey');
  if (own) return own;
  const s = state.server;
  if (!s?.sharedSetting) return null;
  if (!serverKey || serverKey.server !== s) {
    serverKey = { server: s, key: s.sharedSetting('tmdb').catch(() => null) };
  }
  return serverKey.key;
}

export function forgetServerKey() { serverKey = null; }

async function tmdb(path, key, params = {}) {
  const url = new URL(API + path);
  const headers = { Accept: 'application/json' };
  // A v4 "read access token" goes in a header; a v3 "API key" goes in the address.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw new Error('TMDB didn’t accept that key');
  if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
  return res.json();
}

// Checks a key before it's saved.
export const checkKey = key => tmdb('/configuration', key);

function kindOf(v) {
  const name = v.name || '';
  if (/deleted|extended scene|alternate (ending|scene|opening)/i.test(name)) return 'DeletedScene';
  if (/interview/i.test(name)) return 'Interview';
  return {
    Trailer: 'Trailer', Teaser: 'Trailer', Featurette: 'Featurette', 'Behind the Scenes': 'BehindTheScenes',
    Bloopers: 'Bloopers', Clip: 'Clip', 'Opening Credits': 'Clip',
  }[v.type] || 'Unknown';
}

// The YouTube videos TMDB lists for a movie or show, shaped like the server's extras.
export async function onlineExtras(item) {
  const id = (item.Guid || []).map(g => g.id).find(x => x?.startsWith('tmdb://'))?.slice(7);
  const type = item.type === 'movie' ? 'movie' : item.type === 'show' ? 'tv' : null;
  if (!id || !type) return [];
  const key = await tmdbKey();
  if (!key) return [];
  const ck = `${type}/${id}`;
  if (!cache.has(ck)) {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    cache.set(ck, tmdb(`/${type}/${encodeURIComponent(id)}/videos`, key, { include_video_language: [...new Set([lang, 'en', 'null'])].join(',') })
      .then(r => r.results || [])
      .catch(err => {
        cache.delete(ck);
        console.warn('Online extras:', err.message);
        return [];
      }));
  }
  const videos = await cache.get(ck);
  const seen = new Set();
  return videos
    .filter(v => v.site === 'YouTube' && /^[\w-]{11}$/.test(v.key) && !seen.has(v.key) && seen.add(v.key))
    // Official videos first, then newest.
    .sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, 40)
    .map(v => ({
      online: true,
      ratingKey: `yt:${v.key}`,
      youtube: v.key,
      title: v.name || 'Video',
      extraType: kindOf(v),
      thumb: `https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`,
    }));
}

// Plays a YouTube video over the page.
export function playYouTube(key, title) {
  document.querySelector('.yt-backdrop')?.remove();
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'yt-backdrop';
  wrap.innerHTML = `
    <div class="yt-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="yt-head">
        <strong>${esc(title)}</strong>
        <a class="yt-out" href="https://www.youtube.com/watch?v=${esc(key)}" target="_blank" rel="noopener">YouTube ↗</a>
        <button class="icon-btn" data-yt-close aria-label="Close">×</button>
      </div>
      <div class="yt-frame">
        <iframe src="${YT}/embed/${esc(key)}?autoplay=1&rel=0&modestbranding=1&playsinline=1"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="${esc(title)}"></iframe>
      </div>
    </div>`;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    back?.focus?.();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-yt-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  wrap.querySelector('[data-yt-close]').focus();
}
