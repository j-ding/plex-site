import { store } from './util.js';
import { PlexServer } from './plex.js';

export const state = {
  seq: 0,          // bumps on every page render; async work checks it to avoid stale writes
  rendered: null,  // hash (minus '#') of the page currently in #app
  sections: null,
  userToken: store.get('userToken'),
  server: null,
};

const saved = store.get('server');
if (saved?.uri && saved?.token) state.server = new PlexServer(saved);

export function setUserToken(token) {
  state.userToken = token;
  store.set('userToken', token);
}

export function setServer(cfg) {
  state.server = new PlexServer(cfg);
  state.sections = null;
  state.rendered = null;
  store.set('server', cfg);
}

export function signOut() {
  state.userToken = null;
  state.server = null;
  state.sections = null;
  state.rendered = null;
  store.del('userToken');
  store.del('server');
}

export async function getSections() {
  if (!state.sections) {
    const all = await state.server.sections();
    state.sections = all.filter(s => s.type === 'movie' || s.type === 'show');
  }
  return state.sections;
}
