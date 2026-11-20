// HolyArrs (https://holyarrs.com) finds movies and shows, downloads them and files them
// into the library. It refuses requests from other sites and won't be shown inside
// another page, so DingFlix links to its pages in a tab of their own.
import { store } from './util.js';

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
  return address;
}

export const forgetHolyarrs = () => store.del('holyarrs');

export const holyarrsLink = (path = '/') => `${holyarrsAddress()}${path}`;
export const holyarrsSearch = q => holyarrsLink(`/search?q=${encodeURIComponent(q)}`);
export const linkAttrs = `target="${TAB}" rel="noopener"`;

// HolyArrs's own page for a title, from its TMDB id (Plex and Jellyfin both keep one).
export function holyarrsTitle(item) {
  const tmdb = (item.Guid || []).map(g => g.id).find(id => id?.startsWith('tmdb://'))?.slice(7);
  if (!tmdb || (item.type !== 'movie' && item.type !== 'show')) return null;
  return holyarrsLink(`/title/${item.type}/${encodeURIComponent(tmdb)}`);
}

// Whether anything answers at the address. HolyArrs sends no CORS headers, so the
// answer can't be read, but only a network failure throws.
export async function holyarrsUp(address = holyarrsAddress()) {
  try {
    await fetch(`${address}/api/v1/auth/state`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}
