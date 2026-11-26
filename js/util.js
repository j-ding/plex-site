const PREFIX = 'marquee.';

// localStorage can throw (private mode, blocked storage), so every access is guarded.
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem(PREFIX + key); } catch {}
  },
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

// How an audio or subtitle track is named in menus: { main, extra } (extra is a smaller second line).
// A commentary track is named by its title ("Commentary with the director"), with the language underneath.
const looksLikeFilename = t => (t?.match(/\./g) || []).length >= 3;
export const isCommentary = s => s.streamType === 2 && /commentary/i.test(`${s.title || ''} ${s.extendedDisplayTitle || ''}`);
export function trackLabel(s) {
  const base = s.displayTitle || s.language || `Track ${s.index}`;
  const title = looksLikeFilename(s.title) ? '' : (s.title || '').trim();
  if (isCommentary(s)) {
    const name = /commentary/i.test(title) ? title : title ? `Commentary: ${title}` : 'Commentary';
    return { main: name, extra: base, commentary: true };
  }
  // Many files tag every track with the release name; that's noise, not a description.
  return { main: base, extra: title && !base.includes(title) ? title : '' };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function duration(ms) {
  const mins = Math.max(1, Math.round((ms || 0) / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
