// HolyArrs (https://holyarrs.com) finds movies and shows, downloads them and files them
// into the library. It refuses requests from other sites and won't be shown inside
// another page, so DingFlix links to its pages in a tab of their own.
import { store } from './util.js';
import { state } from './state.js';

export const DEFAULT_ADDRESS = 'http://localhost:6262';
const TAB = 'holyarrs'; // one named tab, reused by every link

export const holyarrsAddress = () => store.get('holyarrs');

// Accepts "localhost:6262", "http://pc:6262/explore" and the like; returns the saved
// address, or null if it isn't one.
export function setHolyarrsAddress(text) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  const address = url.origin;
  store.set('holyarrs', address);
  saveToAccount(address);
  return address;
}

export function forgetHolyarrs() {
  store.del('holyarrs');
  saveToAccount('');
}

// The address is also kept with the owner's Jellyfin account, so the NAS copy, the
// GitHub copy and your phone all know it after you enter it once.
const account = () => (state.server?.setMyPref && state.server.admin && !state.server.guest ? state.server : null);
function saveToAccount(address) {
  account()?.setMyPref('holyarrs', address).catch(() => {});
}

// Called once the owner is signed in: picks up the saved address (or saves this device's).
let synced = null;
export async function syncHolyarrs() {
  const s = account();
  if (!s || synced === s) return;
  synced = s;
  const saved = await s.myPref('holyarrs');
  const here = holyarrsAddress();
  if (saved && saved !== here) store.set('holyarrs', saved);
  else if (!saved && here) saveToAccount(here);
}

// A likely address: HolyArrs's usual port on the machine Jellyfin runs on.
export function guessAddress() {
  try {
    const host = new URL(state.server.uri).hostname;
    return host && host !== 'localhost' ? `http://${host}:6262` : DEFAULT_ADDRESS;
  } catch {
    return DEFAULT_ADDRESS;
  }
}

export const holyarrsLink = (path = '/') => `${holyarrsAddress()}${path}`;
export const holyarrsSearch = q => holyarrsLink(`/search?q=${encodeURIComponent(q)}`);
export const linkAttrs = `target="${TAB}" rel="noopener"`;

// HolyArrs's own page for a title, from its TMDB id (Plex and Jellyfin both keep one).
export function holyarrsTitle(item) {
  const tmdb = (item.Guid || []).map(g => g.id).find(id => id?.startsWith('tmdb://'))?.slice(7);
  if (!tmdb || (item.type !== 'movie' && item.type !== 'show')) return null;
  return holyarrsLink(`/title/${item.type}/${encodeURIComponent(tmdb)}`);
}

// Whether anything answers at the address: true, false, or null when this page can't
// tell. HolyArrs sends no CORS headers, so the answer can't be read, but only a network
// failure throws. An https page (GitHub) isn't allowed to call an http address at all,
// though links to it still open fine in a new tab.
export async function holyarrsUp(address = holyarrsAddress()) {
  if (location.protocol === 'https:' && address.startsWith('http:')) return null;
  try {
    await fetch(`${address}/api/v1/auth/state`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}
