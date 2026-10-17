import { store } from './util.js';
import { PlexServer } from './plex.js';

export const state = {
  seq: 0,          // bumps on every page render; async work checks it to avoid stale writes
  rendered: null,  // hash (minus '#') of the page currently in #app
  sections: null,
  userToken: store.get('userToken'), // the Plex account that signed in
  profile: store.get('profile'),     // chosen Plex Home profile: { uuid, title, thumb, token }
  server: null,
};

const saved = store.get('server');
if (saved?.uri && saved?.token) state.server = new PlexServer(saved);

// The token that identifies who is watching. With Plex Home profiles each person
// has their own, which is what keeps progress and watched status separate.
export const viewerToken = () => state.profile?.token || state.userToken;

export function setUserToken(token) {
  state.userToken = token;
  store.set('userToken', token);
}

export function setProfile(profile) {
  state.profile = profile;
  store.set('profile', profile);
  // Server access tokens are per person, so reconnect as the new profile.
  state.server = null;
  state.sections = null;
  state.rendered = null;
  store.del('server');
}

export function setServer(cfg) {
  state.server = new PlexServer(cfg);
  state.sections = null;
  state.rendered = null;
  store.set('server', cfg);
  store.set('lastServerId', cfg.id);
}

export function signOut() {
  state.userToken = null;
  state.profile = null;
  state.server = null;
  state.sections = null;
  state.rendered = null;
  for (const key of ['userToken', 'profile', 'server', 'lastServerId']) store.del(key);
}

export async function getSections() {
  if (!state.sections) {
    const all = await state.server.sections();
    state.sections = all.filter(s => s.type === 'movie' || s.type === 'show');
  }
  return state.sections;
}
