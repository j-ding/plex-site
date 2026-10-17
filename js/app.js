import { state, setServer, setUserToken, signOut } from './state.js';
import { auth, connect } from './plex.js';
import * as views from './views.js';
import { openPlayer, closePlayer } from './player.js';
import { $, sleep } from './util.js';

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { raw, path, params: new URLSearchParams(query) };
}

let retried = false;

async function route() {
  const { raw, path, params } = parseHash();

  if (path === '/connect') {
    closePlayer();
    state.rendered = raw;
    const seq = ++state.seq;
    return run(() => views.connectView(seq, params), seq);
  }
  if (!state.server) return void location.replace('#/connect');
  views.renderHeader().catch(() => {});

  // The player sits on top of whatever page is already rendered, so closing it
  // returns you exactly where you were.
  const watch = path.match(/^\/watch\/(\d+)$/);
  if (watch) {
    if (!state.rendered || state.rendered.startsWith('/connect')) {
      state.rendered = '/';
      const seq = ++state.seq;
      run(() => views.home(seq), seq);
    }
    return openPlayer(watch[1], { fromStart: params.has('start') });
  }

  closePlayer();
  views.updateNav();
  if (raw === state.rendered) return;
  state.rendered = raw;
  const seq = ++state.seq;
  if (path !== '/search') window.scrollTo(0, 0);

  let m;
  if (path === '/') return run(() => views.home(seq), seq);
  if ((m = path.match(/^\/library\/(\w+)$/))) return run(() => views.library(seq, m[1]), seq);
  if ((m = path.match(/^\/title\/(\d+)$/))) return run(() => views.title(seq, m[1], params), seq);
  if (path === '/search') return run(() => views.search(seq, params.get('q') || ''), seq);
  location.replace('#/');
}

async function run(render, seq) {
  try {
    await render();
    retried = false;
  } catch (err) {
    console.error(err);
    if (seq !== state.seq) return;
    if (err.status === 401) {
      // The server stopped accepting our token (e.g. share removed).
      if (state.userToken) return void location.replace('#/connect?pick=1');
      signOut();
      return void location.replace('#/connect');
    }
    // Server addresses can change (new IP, server moved); look it up again once.
    const networkError = err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError';
    if (networkError && !retried && state.userToken && state.server?.id) {
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

async function reconnect() {
  const servers = await auth.servers(state.userToken);
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
      if (!location.hash.startsWith('#/connect')) history.replaceState(history.state, '', '#/connect');
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
    case 'scan':
      scanLibraries(action);
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
route();
