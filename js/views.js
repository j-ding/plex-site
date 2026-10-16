import { CONFIG } from './config.js';
import { state, setServer, getSections } from './state.js';
import { auth, connect, PlexServer } from './plex.js';
import { esc, $, $$, store, duration, debounce } from './util.js';

const VIDEO_TYPES = new Set(['movie', 'show', 'season', 'episode']);
const SORTS = [
  ['titleSort', 'A–Z'],
  ['addedAt:desc', 'Recently added'],
  ['originallyAvailableAt:desc', 'Release date'],
  ['audienceRating:desc', 'Rating'],
  ['lastViewedAt:desc', 'Recently watched'],
];

const app = () => $('#app');
const stale = seq => seq !== state.seq;
const img = (path, w, h) => (path ? state.server.image(path, w, h) : '');
export const loading = () => `<div class="loading"><div class="spinner"></div></div>`;

function mount(seq, html) {
  if (stale(seq)) return false;
  app().innerHTML = html;
  return true;
}

function pageTitle(t) {
  document.title = t ? `${t} · ${CONFIG.appName}` : CONFIG.appName;
}

/* ---------- header ---------- */

export async function renderHeader() {
  const bar = $('#topbar');
  bar.hidden = false;
  const key = `${state.server.id}|${state.server.uri}`;
  if (bar.dataset.key === key) return updateNav();
  bar.dataset.key = key;
  bar.innerHTML = `
    <a class="logo" href="#/">${esc(CONFIG.appName)}</a>
    <nav id="nav"><a href="#/">Home</a></nav>
    <div class="hdr-right">
      <label class="search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.42 1.4-5.39-5.38A8 8 0 1 1 10 2Zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"/></svg>
        <input id="search" type="search" placeholder="Search" autocomplete="off" aria-label="Search">
      </label>
      <div class="menu">
        <button class="avatar" id="menu-btn" aria-haspopup="true" aria-label="Account">${esc((state.server.name || 'P')[0].toUpperCase())}</button>
        <div class="menu-pop" id="menu" hidden>
          <div class="menu-label">Watching from <strong>${esc(state.server.name || 'Plex server')}</strong></div>
          ${state.userToken ? `<a href="#/connect?pick=1">Switch server</a>` : ''}
          <button data-action="signout">Sign out</button>
        </div>
      </div>
    </div>`;

  const input = $('#search');
  input.addEventListener('input', debounce(() => {
    const q = input.value.trim();
    const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
    if (location.hash.startsWith('#/search')) location.replace(target);
    else location.hash = target;
  }, 250));

  if (state.userToken) {
    auth.user(state.userToken).then(u => {
      if (!u?.thumb) return;
      const b = $('#menu-btn');
      b.style.backgroundImage = `url(${JSON.stringify(u.thumb)})`;
      b.textContent = '';
    }).catch(() => {});
  }

  try {
    const sections = await getSections();
    $('#nav').insertAdjacentHTML('beforeend', sections.map(s => `<a href="#/library/${esc(s.key)}">${esc(s.title)}</a>`).join(''));
  } catch {}
  updateNav();
}

export function updateNav() {
  const path = (location.hash || '#/').split('?')[0];
  $$('#nav a').forEach(a => a.toggleAttribute('aria-current', a.getAttribute('href') === (path === '#' ? '#/' : path)));
}

export function hideHeader() {
  const bar = $('#topbar');
  bar.hidden = true;
  bar.dataset.key = '';
}

/* ---------- building blocks ---------- */

function cardInfo(item, landscape) {
  switch (item.type) {
    case 'episode':
      return {
        href: `#/watch/${item.ratingKey}`,
        img: landscape ? item.thumb || item.grandparentArt : item.grandparentThumb || item.parentThumb,
        title: item.grandparentTitle,
        sub: `S${item.parentIndex ?? '?'}:E${item.index ?? '?'} · ${item.title}`,
      };
    case 'season':
      return {
        href: `#/title/${item.parentRatingKey}?season=${item.ratingKey}`,
        img: landscape ? item.art : item.thumb || item.parentThumb,
        title: item.parentTitle,
        sub: item.title,
      };
    default:
      return {
        href: `#/title/${item.ratingKey}`,
        img: landscape ? item.art || item.thumb : item.thumb,
        title: item.title,
        sub: item.year ?? '',
      };
  }
}

function card(item, { landscape = false, resume = false } = {}) {
  const info = cardInfo(item, landscape);
  if (resume) info.href = `#/watch/${item.ratingKey}`;
  const [w, h] = landscape ? [480, 270] : [300, 450];
  const src = img(info.img, w, h);
  const pct = item.viewOffset && item.duration ? Math.min(100, (item.viewOffset / item.duration) * 100) : 0;
  const unwatched = item.type === 'show' && item.leafCount ? item.leafCount - (item.viewedLeafCount || 0) : 0;
  const watched = item.type === 'movie' && item.viewCount && !item.viewOffset;
  return `
    <a class="card ${landscape ? 'landscape' : 'poster'}" href="${esc(info.href)}" title="${esc(info.title)}">
      <div class="card-img">
        <span class="card-fallback">${esc(info.title)}</span>
        ${src ? `<img loading="lazy" src="${esc(src)}" alt="" onerror="this.remove()">` : ''}
        ${pct ? `<div class="progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
        ${unwatched > 0 ? `<span class="badge">${unwatched}</span>` : ''}
        ${watched ? `<span class="badge" aria-label="Watched">✓</span>` : ''}
      </div>
      <div class="card-text">
        <div class="card-title">${esc(info.title)}</div>
        <div class="card-sub">${esc(info.sub)}</div>
      </div>
    </a>`;
}

function row(title, items, opts) {
  if (!items?.length) return '';
  return `
    <section class="row">
      <h2>${esc(title)}</h2>
      <div class="row-track">
        <button class="row-nav prev" aria-label="Scroll left">‹</button>
        <div class="row-scroller">${items.map(i => card(i, opts)).join('')}</div>
        <button class="row-nav next" aria-label="Scroll right">›</button>
      </div>
    </section>`;
}

function hubRows(hubs) {
  return hubs
    .filter(h => !/ondeck|continue/i.test(h.hubIdentifier || ''))
    .map(h => {
      const items = (h.Metadata || []).filter(m => VIDEO_TYPES.has(m.type));
      return row(h.title, items, { landscape: h.type === 'episode' });
    })
    .join('');
}

function metaLine(item) {
  const parts = [];
  if (item.year) parts.push(esc(item.year));
  if (item.contentRating) parts.push(`<span class="pill">${esc(item.contentRating)}</span>`);
  if (item.type === 'movie' && item.duration) parts.push(duration(item.duration));
  if (item.type === 'show' && item.childCount) parts.push(`${item.childCount} season${item.childCount > 1 ? 's' : ''}`);
  const score = item.audienceRating ?? item.rating;
  if (score) parts.push(`★ ${Number(score).toFixed(1)}`);
  return parts.join('<span class="sep">·</span>');
}

function titleArt(item) {
  const logo = item.Image?.find(i => i.type === 'clearLogo')?.url;
  return logo
    ? `<img class="hero-logo" src="${esc(img(logo, 800, 300))}" alt="${esc(item.title)}">`
    : `<h1>${esc(item.title)}</h1>`;
}

function hero(item) {
  if (!item) return '';
  return `
    <section class="hero">
      <img class="hero-bg" src="${esc(img(item.art, 1920, 1080))}" alt="">
      <div class="hero-content">
        ${titleArt(item)}
        <div class="meta">${metaLine(item)}</div>
        <p class="hero-summary">${esc(item.summary)}</p>
        <div class="actions">
          <button class="btn primary" data-play="${esc(item.ratingKey)}">▶ Play</button>
          <a class="btn" href="#/title/${esc(item.ratingKey)}">ⓘ More info</a>
        </div>
      </div>
    </section>`;
}

// Movies and episodes play directly; shows and seasons resume at the next unwatched episode.
export async function playItem(ratingKey) {
  const s = state.server;
  const item = await s.metadata(ratingKey);
  if (item.type === 'movie' || item.type === 'episode') {
    location.hash = `#/watch/${ratingKey}`;
    return;
  }
  const episodes = item.type === 'show' ? await s.allLeaves(ratingKey) : await s.children(ratingKey);
  const next = episodes.find(e => e.viewOffset || !e.viewCount) || episodes[0];
  if (next) location.hash = `#/watch/${next.ratingKey}`;
}

/* ---------- pages ---------- */

export async function home(seq) {
  pageTitle();
  app().innerHTML = loading();
  const s = state.server;
  const [deck, hubs] = await Promise.all([s.onDeck().catch(() => []), s.hubs()]);
  const heroPool = hubs
    .filter(h => h.type === 'movie' || h.type === 'show')
    .flatMap(h => h.Metadata || [])
    .filter(m => m.art && m.summary);
  const pick = heroPool[Math.floor(Math.random() * heroPool.length)];
  const rows = row('Continue Watching', deck, { landscape: true, resume: true }) + hubRows(hubs);
  mount(seq, rows
    ? `${hero(pick)}<div class="rows ${pick ? 'under-hero' : 'page-top'}">${rows}</div>`
    : `<div class="page-top pad empty"><h2>Nothing here yet</h2><p class="muted">Add some movies or shows to your Plex libraries and they'll show up here.</p></div>`);
}

export async function library(seq, id) {
  app().innerHTML = loading();
  const section = (await getSections()).find(x => String(x.key) === id);
  if (!section) throw new Error('That library no longer exists on this server.');
  pageTitle(section.title);
  const hubs = await state.server.sectionHubs(id).catch(() => []);
  const sort = store.get(`sort.${id}`, 'titleSort');
  if (!mount(seq, `
    <div class="page-top pad"><h1 class="page-title">${esc(section.title)}</h1></div>
    <div class="rows">${hubRows(hubs.slice(0, 6))}</div>
    <section class="pad browse">
      <div class="grid-head">
        <h2>All ${esc(section.title)}</h2>
        <select id="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="grid" id="grid"></div>
      <div id="sentinel" class="sentinel"></div>
    </section>`)) return;

  let stop = startGrid(seq, id, sort);
  $('#sort').addEventListener('change', e => {
    store.set(`sort.${id}`, e.target.value);
    stop();
    stop = startGrid(seq, id, e.target.value);
  });
}

// Infinite-scrolling grid of a whole library. Returns a function that stops it.
function startGrid(seq, sectionId, sort) {
  const grid = $('#grid');
  const sentinel = $('#sentinel');
  grid.innerHTML = '';
  let start = 0;
  let done = false;
  let busy = false;
  const obs = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || busy || done) return;
    busy = true;
    try {
      const { items, total } = await state.server.items(sectionId, { sort, start, size: 60 });
      if (stale(seq) || done) return;
      grid.insertAdjacentHTML('beforeend', items.map(i => card(i)).join(''));
      start += items.length;
      if (!items.length || start >= total) {
        done = true;
        obs.disconnect();
      } else {
        // Re-observe so we load again if the sentinel is still on screen.
        obs.unobserve(sentinel);
        obs.observe(sentinel);
      }
    } catch (err) {
      console.error(err);
    } finally {
      busy = false;
    }
  }, { rootMargin: '800px 0px' });
  obs.observe(sentinel);
  return () => {
    done = true;
    obs.disconnect();
  };
}

export async function title(seq, id, params) {
  app().innerHTML = loading();
  const s = state.server;
  const item = await s.metadata(id);
  if (stale(seq)) return;
  if (item.type === 'season') return void location.replace(`#/title/${item.parentRatingKey}?season=${item.ratingKey}`);
  if (item.type === 'episode') return void location.replace(`#/title/${item.grandparentRatingKey}?season=${item.parentRatingKey}`);

  const isShow = item.type === 'show';
  const [seasons, related] = await Promise.all([
    isShow ? s.children(id).then(l => l.filter(x => x.type === 'season')) : [],
    s.related(id).catch(() => []),
  ]);
  if (stale(seq)) return;
  pageTitle(item.title);

  const watched = isShow ? item.leafCount > 0 && item.viewedLeafCount >= item.leafCount : !!item.viewCount && !item.viewOffset;
  const resume = !isShow && item.viewOffset ? item.viewOffset : 0;
  const tags = (list, n) => (list || []).slice(0, n).map(t => esc(t.tag)).join(', ');
  const fact = (label, value) => (value ? `<p>${label}: <span>${value}</span></p>` : '');
  const current = params.get('season') || (seasons.find(x => (x.viewedLeafCount || 0) < x.leafCount) || seasons[0])?.ratingKey;

  if (!mount(seq, `
    <section class="hero title-hero">
      ${item.art ? `<img class="hero-bg" src="${esc(img(item.art, 1920, 1080))}" alt="">` : ''}
      <div class="hero-content">
        ${titleArt(item)}
        <div class="meta">${metaLine(item)}</div>
        ${item.tagline ? `<p class="tagline">${esc(item.tagline)}</p>` : ''}
        <div class="actions">
          <button class="btn primary" data-play="${esc(id)}">▶ ${resume ? 'Resume' : 'Play'}</button>
          ${resume ? `<a class="btn" href="#/watch/${esc(id)}?start=1">↺ Start over</a>` : ''}
          <button class="btn" data-action="toggle-watched" data-key="${esc(id)}" data-watched="${watched ? 1 : 0}">${watched ? '✓ Watched' : 'Mark as watched'}</button>
        </div>
        ${resume ? `<div class="resume"><div class="progress"><span style="width:${((resume / item.duration) * 100).toFixed(1)}%"></span></div><small>${duration(item.duration - resume)} left</small></div>` : ''}
      </div>
    </section>
    <div class="title-details pad">
      <p class="summary">${esc(item.summary)}</p>
      <div class="facts">
        ${fact('Genres', tags(item.Genre, 4))}
        ${fact('Director', tags(item.Director, 3))}
        ${fact('Cast', tags(item.Role, 8))}
        ${fact('Studio', esc(item.studio))}
      </div>
    </div>
    ${isShow && seasons.length ? `
      <section class="pad seasons">
        <div class="season-head">
          <h2>Episodes</h2>
          ${seasons.length > 1
            ? `<select id="season" aria-label="Season">${seasons.map(x => `<option value="${esc(x.ratingKey)}" ${String(x.ratingKey) === String(current) ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`
            : `<span class="muted">${esc(seasons[0].title)}</span>`}
        </div>
        <div id="episodes"></div>
      </section>` : ''}
    <div class="rows">${hubRows(related)}</div>`)) return;

  if (isShow && seasons.length) {
    const select = $('#season');
    select?.addEventListener('change', () => {
      history.replaceState(history.state, '', `#/title/${id}?season=${select.value}`);
      state.rendered = location.hash.slice(1);
      loadSeason(seq, select.value);
    });
    loadSeason(seq, current);
  }
}

async function loadSeason(seq, seasonKey) {
  const list = $('#episodes');
  list.innerHTML = loading();
  const episodes = await state.server.children(seasonKey).catch(() => null);
  if (stale(seq) || list !== $('#episodes')) return;
  if (!episodes) {
    list.innerHTML = `<p class="muted">Couldn't load episodes.</p>`;
    return;
  }
  list.innerHTML = episodes.map(ep => {
    const pct = ep.viewOffset && ep.duration ? (ep.viewOffset / ep.duration) * 100 : ep.viewCount ? 100 : 0;
    return `
      <a class="episode" href="#/watch/${esc(ep.ratingKey)}">
        <span class="ep-num">${esc(ep.index ?? '')}</span>
        <div class="ep-thumb">
          ${ep.thumb ? `<img loading="lazy" src="${esc(img(ep.thumb, 400, 225))}" alt="">` : ''}
          <span class="ep-play">▶</span>
          ${pct ? `<div class="progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
        </div>
        <div class="ep-body">
          <div class="ep-head"><h3>${esc(ep.title)}</h3><span class="muted">${ep.duration ? duration(ep.duration) : ''}</span></div>
          <p>${esc(ep.summary)}</p>
        </div>
      </a>`;
  }).join('');
}

export async function search(seq, q) {
  pageTitle('Search');
  const input = $('#search');
  if (input && document.activeElement !== input) input.value = q;
  if (!q) return void mount(seq, `<div class="page-top pad"><p class="muted">Search your libraries for titles, actors, or genres.</p></div>`);
  if (!$('#results')) app().innerHTML = `<div class="page-top pad"><div id="results">${loading()}</div></div>`;
  const hubs = await state.server.search(q);
  if (stale(seq)) return;
  const groups = hubs.filter(h => VIDEO_TYPES.has(h.type) && h.Metadata?.length);
  $('#results').innerHTML = groups.length
    ? groups.map(h => {
        const landscape = h.type === 'episode';
        return `<h2 class="group-title">${esc(h.title)}</h2>
          <div class="grid ${landscape ? 'landscape' : ''}">${h.Metadata.map(m => card(m, { landscape })).join('')}</div>`;
      }).join('')
    : `<p class="muted">No results for “${esc(q)}”.</p>`;
}

export function errorView(err) {
  pageTitle('Error');
  app().innerHTML = `
    <div class="page-top pad empty">
      <h2>Something went wrong</h2>
      <p class="muted">${esc(err.message || err)}</p>
      <div class="actions">
        <button class="btn primary" data-action="retry">Try again</button>
        <a class="btn" href="#/connect?pick=1">Change server</a>
      </div>
    </div>`;
}

/* ---------- sign in / pick a server ---------- */

const shell = inner => `
  <div class="connect">
    <div class="connect-card">
      <div class="logo big">${esc(CONFIG.appName)}</div>
      ${inner}
    </div>
  </div>`;

export async function connectView(seq, params) {
  hideHeader();
  pageTitle('Sign in');
  if (!state.userToken) return renderSignIn(seq);

  mount(seq, shell(`
    <h2>Choose a server</h2>
    <div id="servers" class="server-list">${loading()}</div>
    <p id="connect-error" class="error" role="alert"></p>
    <div class="connect-foot">
      ${state.server ? `<a href="#/">← Back</a>` : '<span></span>'}
      <button class="link" data-action="signout">Sign out</button>
    </div>`));

  const servers = await auth.servers(state.userToken);
  if (stale(seq)) return;
  const list = $('#servers');
  if (!servers.length) {
    list.innerHTML = `<p class="muted">No Plex Media Server is linked to this account yet. Once you set one up — or a friend shares theirs with you — it'll appear here.</p>`;
    return;
  }
  list.innerHTML = servers.map((r, i) => `
    <button class="server" data-i="${i}">
      <span class="status ${r.presence ? 'on' : ''}" title="${r.presence ? 'Online' : 'Offline'}"></span>
      <span class="server-text">
        <strong>${esc(r.name)}</strong>
        <small>${r.owned ? 'Your server' : `Shared by ${esc(r.sourceTitle || 'a friend')}`}</small>
      </span>
      <span class="server-go">›</span>
    </button>`).join('');
  $$('.server', list).forEach(b => b.addEventListener('click', () => pickServer(servers[b.dataset.i], b)));
  if (servers.length === 1 && !params.has('pick')) pickServer(servers[0], $('.server', list));
}

async function pickServer(resource, button) {
  const buttons = $$('.server');
  const error = $('#connect-error');
  buttons.forEach(b => (b.disabled = true));
  button.classList.add('busy');
  error.textContent = '';
  try {
    const uri = await connect(resource);
    setServer({ uri, token: resource.accessToken, name: resource.name, id: resource.clientIdentifier });
    location.hash = '#/';
  } catch (err) {
    error.textContent = err.message;
    buttons.forEach(b => (b.disabled = false));
    button.classList.remove('busy');
  }
}

function renderSignIn(seq) {
  if (!mount(seq, shell(`
    <p class="muted">Sign in with your Plex account to watch from your server, or from one a friend has shared with you.</p>
    <button class="btn accent block" id="signin">Sign in with Plex</button>
    <p id="connect-error" class="error" role="alert"></p>
    <details class="manual">
      <summary>Connect with a server URL and token</summary>
      <form id="manual">
        <label>Server URL<input name="uri" type="url" placeholder="https://1-2-3-4.abc123.plex.direct:32400" required></label>
        <label>Plex token<input name="token" type="password" autocomplete="off" required></label>
        <button class="btn block">Connect</button>
      </form>
    </details>`))) return;

  const error = $('#connect-error');

  $('#signin').addEventListener('click', async e => {
    e.target.disabled = true;
    error.textContent = '';
    try {
      const pin = await auth.createPin();
      sessionStorage.setItem('marquee.pin', JSON.stringify({ id: pin.id, code: pin.code }));
      location.href = auth.loginUrl(pin, location.href.split('#')[0]);
    } catch (err) {
      error.textContent = `Couldn't reach plex.tv: ${err.message}`;
      e.target.disabled = false;
    }
  });

  $('#manual').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const uri = form.uri.value.trim().replace(/\/+$/, '');
    const token = form.token.value.trim();
    error.textContent = '';
    if (location.protocol === 'https:' && uri.startsWith('http:')) {
      error.textContent = "This site is served over HTTPS, so your browser will block an http:// server. Use the server's https://…plex.direct address instead.";
      return;
    }
    form.querySelector('button').disabled = true;
    try {
      const info = await new PlexServer({ uri, token }).info();
      setServer({ uri, token, name: info.friendlyName || 'Plex server', id: info.machineIdentifier });
      location.hash = '#/';
    } catch (err) {
      error.textContent = `Couldn't connect: ${err.message}`;
      form.querySelector('button').disabled = false;
    }
  });
}
