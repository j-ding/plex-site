import { state, setServer, setUserToken, setProfile, signOut, viewerToken } from './state.js';
import { auth, connect } from './plex.js';
import * as views from './views.js';
import { openPlayer, closePlayer, autoplayOn, setAutoplay } from './player.js';
import { $, $$, sleep, store, debounce } from './util.js';
import { setTrailersOn, trailersOn, toggleTrailerSound } from './trailers.js';
import { startLive, join } from './party.js';

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { raw, path, params: new URLSearchParams(query) };
}

let retried = false;

// When a Jellyfin server serves DingFlix itself (say at /web, through Tailscale),
// that server is the one to sign in to.
const jellyfinHost = location.hostname.endsWith('github.io') || location.protocol === 'file:'
  ? Promise.resolve(null)
  : fetch(`${location.origin}/System/Info/Public`, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(info => (/jellyfin/i.test(info?.ProductName || '') ? location.origin : null))
    .catch(() => null);

async function route() {
  const { raw, path, params } = parseHash();

  if (!state.server && !state.userToken && (path === '/' || path === '/connect')) {
    const host = await jellyfinHost;
    if (host) return void location.replace(`#/jellyfin?server=${encodeURIComponent(host)}`);
  }

  if (path === '/connect') {
    closePlayer();
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.connectView(seq, params), seq);
  }
  if (path === '/profiles') {
    closePlayer();
    if (!state.userToken) return void location.replace('#/connect');
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.profilesView(seq), seq);
  }
  if (path === '/jellyfin') {
    closePlayer();
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.jellyfinView(seq, params), seq);
  }
  const shared = path.match(/^\/s\/([\w-]+)$/);
  if (shared) {
    closePlayer();
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.sharedView(seq, shared[1]), seq);
  }
  if (path === '/join') {
    closePlayer();
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.joinView(seq, params), seq);
  }
  if (!state.server) return void location.replace('#/connect');
  // Share-link guests can only open their one title (and play it).
  if (state.server.guest && !/^\/(title|watch)\//.test(path)) return void location.replace(`#/title/${state.server.guest}`);
  views.renderHeader().catch(() => {});
  startLive();

  // The player sits on top of whatever page is already rendered, so closing it
  // returns you exactly where you were.
  // Plex IDs are numbers; Jellyfin IDs are hex strings.
  const watch = path.match(/^\/watch\/([\w-]+)$/);
  if (watch) {
    if (!state.rendered || state.rendered.startsWith('/connect') || state.rendered.startsWith('/profiles')) {
      state.rendered = '/';
      const seq = ++state.seq;
      run(() => views.home(seq), seq);
    }
    // ?join= comes from a friend's card on the home page; ?at= from following them to the next episode.
    let key = watch[1];
    let at = params.has('at') ? Number(params.get('at')) : null;
    if (params.has('join') || params.has('at')) history.replaceState(history.state, '', `#/watch/${key}`);
    if (params.has('join')) {
      const start = await join(params.get('join'));
      if (start) {
        if (String(start.key) !== String(key)) history.replaceState(history.state, '', `#/watch/${(key = start.key)}`);
        at = start.at;
      }
    }
    return openPlayer(key, { fromStart: params.has('start'), at });
  }

  closePlayer();
  views.updateNav();
  if (raw === state.rendered) return;
  state.rendered = raw;
  const seq = ++state.seq;
  // Back and forward land on an entry that remembers where you were on it.
  const place = history.state?.place?.raw === raw ? history.state.place : null;
  if (path !== '/search') window.scrollTo(0, 0);

  let m, render;
  if (path === '/') render = () => views.home(seq);
  else if ((m = path.match(/^\/library\/(\w+)$/))) render = () => views.library(seq, m[1], params);
  else if ((m = path.match(/^\/title\/([\w-]+)$/))) render = () => views.title(seq, m[1], params);
  else if (path === '/search') render = () => views.search(seq, params.get('q') || '');
  else if (path === '/manage') render = () => views.manage(seq);
  else if (path === '/holyarrs') render = () => views.holyarrsView(seq, params);
  else if (path === '/requests') render = () => views.requestsView(seq, params);
  else if (path === '/upcoming') render = () => views.upcomingView(seq);
  else if ((m = path.match(/^\/person\/([^/]+)$/))) render = () => views.personView(seq, decodeURIComponent(m[1]), params);
  else return void location.replace('#/');
  drawing = true;
  await run(render, seq);
  if (place) await restorePlace(place, seq);
  if (seq === state.seq) drawing = false;
}

// Keeps the page's scroll and each row's sideways scroll in the history entry, so
// going back puts you where you were.
history.scrollRestoration = 'manual';
let drawing = false; // a page is still loading, or being put back where it was
const savePlace = debounce(() => {
  const raw = location.hash.replace(/^#/, '') || '/';
  if (drawing || raw !== state.rendered) return; // the player is open, or a page is still loading
  const rows = {};
  $$('#app .row-scroller').forEach((r, i) => { if (r.scrollLeft) rows[i] = Math.round(r.scrollLeft); });
  history.replaceState({ ...history.state, place: { raw, y: Math.round(scrollY), rows } }, '');
}, 200);
window.addEventListener('scroll', savePlace, { passive: true, capture: true });

// Rows and grids can still be filling in, so keep trying for a couple of seconds.
async function restorePlace({ y, rows }, seq) {
  for (let i = 0; i < 25 && seq === state.seq; i++) {
    $$('#app .row-scroller').forEach((r, n) => { if (rows[n]) r.scrollLeft = rows[n]; });
    const room = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo(0, Math.min(y, room));
    if (room >= y) return;
    await sleep(100);
  }
}

async function run(render, seq) {
  try {
    await render();
    retried = false;
  } catch (err) {
    console.error(err);
    if (seq !== state.seq) return;
    if (err.status === 401) {
      // The server stopped accepting our token: the profile was deleted or its access removed.
      if (state.server?.guest) return void endShare('This link has been turned off');
      if (state.server?.kind === 'jellyfin') {
        const uri = state.server.uri;
        views.toast('Please sign in again.');
        return void location.replace(`#/jellyfin?server=${encodeURIComponent(uri)}`);
      }
      if (state.profile) {
        setProfile(null);
        views.toast('That profile no longer has access. Choose who\'s watching.');
        return void location.replace('#/profiles');
      }
      if (state.userToken) return void location.replace('#/connect?pick=1');
      signOut();
      return void location.replace('#/connect');
    }
    // Server addresses can change (new IP, server moved); look it up again once.
    const networkError = err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError';
    if (networkError && !retried && state.userToken && state.server?.id && state.server.kind !== 'jellyfin') {
      retried = true;
      try {
        await reconnect();
        state.rendered = null;
        return route();
      } catch {}
    }
    views.errorView(err);
  }
}

// Leave share-link mode: go back to the visitor's own server if they had one.
function endShare(message) {
  closePlayer();
  const previous = store.get('serverBeforeShare');
  store.del('serverBeforeShare');
  if (previous) {
    setServer(previous);
    if (message) views.toast(message);
    return void location.replace('#/');
  }
  state.server = null;
  state.rendered = null;
  store.del('server');
  views.hideHeader();
  $('#app').innerHTML = `
    <div class="connect"><div class="connect-card">
      <div class="logo big">DingFlix</div>
      <h2 class="join-title">${message || 'Thanks for watching'}</h2>
      <p class="muted" style="text-align:center">${message ? 'Ask the person who sent it for a new link.' : 'Open the link again any time to keep watching.'}</p>
    </div></div>`;
}

async function reconnect() {
  const servers = await auth.servers(viewerToken());
  const resource = servers.find(s => s.clientIdentifier === state.server.id);
  if (!resource) throw new Error('Server is no longer available to this account.');
  const uri = await connect(resource);
  setServer({ uri, token: resource.accessToken, name: resource.name, id: resource.clientIdentifier, owned: !!resource.owned });
}

// Ask Plex to look for new files, wait until it's done, then redraw the page.
async function scanLibraries(button) {
  if (button.classList.contains('spinning')) return;
  button.classList.add('spinning');
  try {
    await state.server.scanAll();
    await sleep(1000);
    for (let i = 0; i < 300 && (await state.server.isScanning()); i++) await sleep(1000);
    state.sections = null; // libraries may have been added or renamed
    $('#topbar').dataset.key = '';
    state.rendered = null;
    if (!location.hash.startsWith('#/watch')) route();
    views.toast('Libraries are up to date');
  } catch (err) {
    console.error(err);
    views.toast(err.status === 401 || err.status === 403
      ? 'Only the server owner can check for new files.'
      : `Couldn't check for new files: ${err.message}`);
  } finally {
    button.classList.remove('spinning');
  }
}

// Coming back from app.plex.tv's login page: trade the PIN for a token.
async function finishLogin() {
  let pin;
  try {
    pin = JSON.parse(sessionStorage.getItem('marquee.pin') || 'null');
    sessionStorage.removeItem('marquee.pin');
  } catch {}
  if (!pin) return;
  $('#app').innerHTML = views.loading();
  for (let i = 0; i < 5; i++) {
    const token = await auth.checkPin(pin).catch(() => null);
    if (token) {
      setUserToken(token);
      // Someone arriving from an invite link continues joining; everyone else picks a server.
      history.replaceState(history.state, '', store.get('join') ? '#/join' : '#/connect');
      return;
    }
    await sleep(1000);
  }
}

document.addEventListener('click', async e => {
  const t = e.target;

  const nav = t.closest('.row-nav');
  if (nav) {
    const scroller = nav.parentElement.querySelector('.row-scroller');
    const dir = nav.classList.contains('next') ? 1 : -1;
    scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: 'smooth' });
    return;
  }

  const menu = $('#menu');
  if (t.closest('#menu-btn')) {
    menu.hidden = !menu.hidden;
    return;
  }
  if (menu && !menu.hidden && (!t.closest('#menu') || t.closest('#menu a, #menu button'))) menu.hidden = true;

  const play = t.closest('[data-play]');
  if (play) {
    play.disabled = true;
    try {
      await views.playItem(play.dataset.play);
    } catch (err) {
      views.errorView(err);
    } finally {
      play.disabled = false;
    }
    return;
  }

  const action = t.closest('[data-action]');
  if (!action) return;
  switch (action.dataset.action) {
    case 'signout':
      closePlayer();
      signOut();
      views.hideHeader();
      if (location.hash === '#/connect') route();
      else location.hash = '#/connect';
      break;
    case 'share':
      views.openShareDialog(action.dataset.key, action.dataset.title);
      break;
    case 'exit-share':
      endShare();
      break;
    case 'scan':
      scanLibraries(action);
      break;
    case 'hide':
      views.openHideDialog(action.dataset.key, action.dataset.title, () => {
        state.rendered = null;
        route();
      });
      break;
    case 'toggle-trailers':
      setTrailersOn(!trailersOn());
      action.textContent = views.trailerMenuLabel();
      break;
    case 'toggle-autoplay':
      setAutoplay(!autoplayOn());
      action.textContent = views.autoplayMenuLabel();
      break;
    case 'trailer-sound':
      toggleTrailerSound();
      break;
    case 'retry':
      retried = false;
      state.rendered = null;
      route();
      break;
    case 'toggle-watched': {
      action.disabled = true;
      const key = action.dataset.key;
      try {
        await (action.dataset.watched === '1' ? state.server.unscrobble(key) : state.server.scrobble(key));
      } catch (err) {
        console.error(err);
      }
      state.rendered = null;
      route();
      break;
    }
  }
});

window.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('solid', window.scrollY > 20);
}, { passive: true });

window.addEventListener('hashchange', route);

// Mark the entry the user landed on, so the player knows whether "Back" would leave the site.
history.replaceState({ root: true }, '');
await finishLogin();

// A device that hasn't picked a profile yet starts at "Who's watching?".
if (state.userToken && !state.profile && state.server?.kind !== 'jellyfin' && !/^#\/(connect|profiles|join|jellyfin|s\/)/.test(location.hash)) {
  history.replaceState(history.state, '', '#/profiles');
}
route();
