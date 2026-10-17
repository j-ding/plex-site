import { store } from './util.js';
import { PlexServer, auth } from './plex.js';

export const state = {
  seq: 0,          // bumps on every page render; async work checks it to avoid stale writes
  rendered: null,  // hash (minus '#') of the page currently in #app
  sections: null,
  userToken: store.get('userToken'), // the Plex account that signed in
  profile: store.get('profile'),     // chosen Plex Home profile: { uuid, title, thumb, token }
  server: null,
  admin: undefined, // cached result of isAdmin()
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

// The owner of the server, watching as their own (not a managed) profile.
export async function isAdmin() {
  if (state.admin !== undefined) return state.admin;
  if (!state.userToken || !state.server) return false; // manual connections can't manage sharing
  let owned = state.server.owned;
  if (owned === undefined) {
    const resource = (await auth.servers(viewerToken())).find(s => s.clientIdentifier === state.server.id);
    owned = !!resource?.owned;
  }
  let admin = owned;
  if (admin && state.profile) {
    if (state.profile.admin === undefined) {
      const people = await auth.homeUsers(state.userToken);
      state.profile.admin = !!people.find(p => p.uuid === state.profile.uuid)?.admin;
      store.set('profile', state.profile);
    }
    admin = state.profile.admin;
  }
  return (state.admin = admin);
}

export function setProfile(profile) {
  state.admin = undefined;
  state.profile = profile;
  store.set('profile', profile);
  // Server access tokens are per person, so reconnect as the new profile.
  state.server = null;
  state.sections = null;
  state.rendered = null;
  store.del('server');
}

export function setServer(cfg) {
  state.admin = undefined;
  state.server = new PlexServer(cfg);
  state.sections = null;
  state.rendered = null;
  store.set('server', cfg);
  store.set('lastServerId', cfg.id);
}

export function signOut() {
  state.admin = undefined;
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
