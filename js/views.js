import { CONFIG } from './config.js';
import { state, setServer, setProfile, getSections, viewerToken, isAdmin } from './state.js';
import { auth, connect, PlexServer } from './plex.js';
import { jellyfinAuth } from './jellyfin.js';
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
  const jellyfin = state.server.kind === 'jellyfin';
  const who = jellyfin ? state.server.userName : state.profile?.title;
  const key = `${state.server.id}|${state.server.uri}|${state.profile?.uuid ?? state.server.userId ?? ''}`;
  if (bar.dataset.key === key) return updateNav();
  bar.dataset.key = key;
  bar.innerHTML = `
    <a class="logo" href="#/">${esc(CONFIG.appName)}</a>
    <nav id="nav"><a href="#/">Home</a></nav>
    <div class="hdr-right">
      ${state.server.owned === false ? '' : `
        <button class="icon-btn hdr-btn" data-action="scan" title="Check for new files" aria-label="Check for new files">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 0 1 7.75 6h-2.08A6 6 0 1 0 18 14h2.07A8 8 0 1 1 12 4Zm6-2 4 5h-8l4-5Z" transform="rotate(0 12 12)"/></svg>
        </button>`}
      <label class="search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.42 1.4-5.39-5.38A8 8 0 1 1 10 2Zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"/></svg>
        <input id="search" type="search" placeholder="Search" autocomplete="off" aria-label="Search">
      </label>
      <div class="menu">
        <button class="avatar" id="menu-btn" aria-haspopup="true" aria-label="Account">${esc((who || state.server.name || 'P')[0].toUpperCase())}</button>
        <div class="menu-pop" id="menu" hidden>
          <div class="menu-label">
            ${who ? `Profile: <strong>${esc(who)}</strong><br>` : ''}
            Watching from <strong>${esc(state.server.name || 'your server')}</strong>
            <small class="muted server-kind">${jellyfin ? 'Jellyfin' : 'Plex'}</small>
          </div>
          ${state.userToken || jellyfin ? `<a href="#/profiles">Switch profile</a>` : ''}
          <a href="#/connect?pick=1">Switch server</a>
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

  const setAvatar = thumb => {
    if (!thumb) return;
    const b = $('#menu-btn');
    b.style.backgroundImage = `url(${JSON.stringify(thumb)})`;
    b.textContent = '';
  };
  if (jellyfin) setAvatar(state.server.userAvatar());
  else if (state.profile) setAvatar(state.profile.thumb);
  else if (state.userToken) auth.user(state.userToken).then(u => setAvatar(u?.thumb)).catch(() => {});

  try {
    const sections = await getSections();
    $('#nav').insertAdjacentHTML('beforeend', sections.map(s => `<a href="#/library/${esc(s.key)}">${esc(s.title)}</a>`).join(''));
  } catch {}
  if (await isAdmin().catch(() => false)) $('#nav').insertAdjacentHTML('beforeend', `<a href="#/manage" class="nav-admin">Manage</a>`);
  updateNav();
}

export function updateNav() {
  const path = (location.hash || '#/').split('?')[0];
  $$('#nav a').forEach(a => a.toggleAttribute('aria-current', a.getAttribute('href') === (path === '#' ? '#/' : path)));
}

export function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 3500);
  setTimeout(() => el.remove(), 4000);
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

/* ---------- owner: who has access ---------- */

const when = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const itemName = m => (m.type === 'episode' ? `${m.grandparentTitle} · S${m.parentIndex}:E${m.index} ${m.title}` : `${m.title}${m.year ? ` (${m.year})` : ''}`);

export async function manage(seq) {
  pageTitle('Manage');
  app().innerHTML = loading();
  if (!(await isAdmin())) throw new Error('Only the owner of this server can manage who has access.');
  if (state.server.kind === 'jellyfin') return jellyfinManage(seq);
  const s = state.server;
  const [shares, people, sessions, pending] = await Promise.all([
    auth.sharedUsers(state.userToken, s.id),
    auth.homeUsers(state.userToken).catch(() => []),
    s.sessions().catch(() => []),
    auth.sentInvites(state.userToken).catch(() => []),
  ]);
  if (stale(seq)) return;

  // One entry per person: shared friends/profiles, plus Home profiles that have no share yet.
  const home = new Map(people.filter(p => !p.admin).map(p => [String(p.id), p]));
  const members = shares.map(sh => ({ ...sh, profile: home.get(String(sh.userId)) }));
  for (const [id, p] of home) {
    if (!members.some(m => String(m.userId) === id)) members.push({ userId: id, username: p.title, libraries: [], accepted: true, profile: p });
  }
  members.forEach(m => (m.name = m.profile?.title || m.username || m.email || 'Unknown'));
  members.sort((a, b) => a.name.localeCompare(b.name));

  const nowPlaying = nowPlayingHtml(sessions);

  if (!mount(seq, `
    <div class="page-top pad manage">
      <h1 class="page-title">Manage</h1>
      <p class="muted">People with access to <strong>${esc(s.name || 'your server')}</strong>, what they've finished watching, and who's watching right now.</p>

      <h2 class="group-title">Invite someone</h2>
      <form class="invite-form" id="invite-form">
        <input name="recipient" type="text" autocomplete="off" placeholder="Their email (or Plex username)" required aria-label="Email or Plex username">
        <button class="btn accent">Send invite</button>
      </form>
      <p class="muted invite-note">They don't need a Plex account yet. They'll get an email from Plex, and you'll get a link to send them. The link walks them through signing up and drops them right into your libraries.</p>
      <div id="invite-result"></div>
      ${pending.length ? `
        <div class="pending-list">
          <h3>Waiting to accept</h3>
          ${pending.map((p, i) => `
            <div class="pending-row">
              <span>${esc(p.who)}${p.sentAt ? ` <small class="muted">· sent ${when(p.sentAt)}</small>` : ''}</span>
              <span class="member-actions">
                <button class="btn small" data-copy-link>Copy link</button>
                <button class="btn small danger" data-cancel-invite="${i}">Cancel</button>
              </span>
            </div>`).join('')}
        </div>` : ''}

      <h2 class="group-title">Watching now</h2>
      ${nowPlaying || '<p class="muted">Nobody is watching right now.</p>'}

      <h2 class="group-title">People with access</h2>
      ${members.length ? members.map((m, i) => `
        <section class="member" data-i="${i}">
          <div class="member-head">
            <span class="member-pic">${m.profile?.thumb ? `<img src="${esc(m.profile.thumb)}" alt="">` : esc(m.name[0].toUpperCase())}</span>
            <div class="member-info">
              <strong>${esc(m.name)}</strong>
              <small class="muted">
                ${m.profile ? 'Home profile' : 'Friend'}${m.email ? ` · ${esc(m.email)}` : ''}
                ${!m.accepted ? ' · <span class="pending">Invite pending</span>' : ''}
                · ${m.libraries.length ? `Can see: ${esc(m.libraries.join(', '))}` : 'No library access'}
              </small>
            </div>
            <div class="member-actions">
              ${m.shareId ? `<button class="btn small danger" data-remove="${i}">Remove access</button>` : ''}
              ${m.profile ? `<button class="btn small danger" data-delete="${i}">Delete profile</button>` : ''}
            </div>
          </div>
          <div class="history" id="history-${i}">${loading()}</div>
        </section>`).join('') : `<p class="muted">You haven't shared your library with anyone yet. Invite someone above, or add profiles for your household on the "Who's watching?" screen.</p>`}
    </div>`)) return;

  const link = inviteLink(s);
  const copy = async text => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied. Send it to them however you like.');
    } catch {
      prompt('Copy this link:', text);
    }
  };

  $('#invite-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const recipient = form.recipient.value.trim();
    const button = form.querySelector('button');
    const result = $('#invite-result');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      await auth.shareServer(state.userToken, s.id, { invited_email: recipient });
      result.innerHTML = `
        <div class="invite-done">
          <p><strong>Invite sent to ${esc(recipient)}.</strong> Send them this link:</p>
          <div class="link-row"><input readonly value="${esc(link)}" aria-label="Invite link"><button class="btn small accent" data-copy-link>Copy</button></div>
        </div>`;
      form.reset();
    } catch (err) {
      result.innerHTML = `<p class="error">Couldn't send the invite: ${esc(err.message)}. Check the email address or username and try again.</p>`;
    } finally {
      button.disabled = false;
      button.textContent = 'Send invite';
    }
  });

  // Load everyone's watch history in parallel.
  members.forEach(async (m, i) => {
    const box = $(`#history-${i}`);
    const items = await s.history(m.userId, 10).catch(() => null);
    if (stale(seq) || !box) return;
    box.innerHTML = !items ? '<p class="muted">Couldn\'t load watch history.</p>'
      : !items.length ? '<p class="muted">Hasn\'t finished anything yet.</p>'
      : `<ul>${items.map(h => `<li><span>${esc(itemName(h))}</span><small class="muted">${when(h.viewedAt)}</small></li>`).join('')}</ul>`;
  });

  app().querySelector('.manage').addEventListener('click', async e => {
    if (e.target.closest('[data-copy-link]')) return void copy(link);
    const cancel = e.target.closest('[data-cancel-invite]');
    if (cancel) {
      const invite = pending[cancel.dataset.cancelInvite];
      if (!confirm(`Cancel the invite to ${invite.who}?`)) return;
      cancel.disabled = true;
      try {
        await auth.cancelInvite(state.userToken, invite.id);
        toast(`Cancelled the invite to ${invite.who}.`);
        state.rendered = null;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (err) {
        cancel.disabled = false;
        toast(`Couldn't cancel: ${err.message}`);
      }
      return;
    }
    const remove = e.target.closest('[data-remove]');
    const del = e.target.closest('[data-delete]');
    const button = remove || del;
    if (!button) return;
    const m = members[button.dataset.remove ?? button.dataset.delete];
    const question = remove
      ? `Remove ${m.name}'s access to your libraries? They won't be able to watch anything until you share with them again.`
      : `Delete the profile "${m.name}"? Their watch history and progress will be lost.`;
    if (!confirm(question)) return;
    button.disabled = true;
    try {
      if (remove) await auth.removeShare(state.userToken, s.id, m.shareId);
      else await auth.deleteProfile(state.userToken, m.userId);
      toast(remove ? `${m.name} no longer has access.` : `Deleted ${m.name}.`);
      state.rendered = null;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      button.disabled = false;
      toast(`Couldn't do that: ${err.message}`);
    }
  });
}

function nowPlayingHtml(sessions) {
  return sessions.map(m => {
    const pct = m.duration ? Math.round(((m.viewOffset || 0) / m.duration) * 100) : 0;
    return `
      <div class="np">
        ${m.thumb || m.grandparentThumb ? `<img src="${esc(img(m.grandparentThumb || m.thumb, 120, 180))}" alt="">` : '<div></div>'}
        <div>
          <strong>${esc(m.User?.title || 'Someone')}</strong> is watching
          <div>${esc(itemName(m))}</div>
          <div class="progress static"><span style="width:${pct}%"></span></div>
          <small class="muted">${esc(m.Player?.state || '')} · ${pct}% · ${esc(m.Player?.product || '')} on ${esc(m.Player?.title || m.Player?.device || 'a device')}</small>
        </div>
      </div>`;
  }).join('');
}

function historyHtml(items) {
  if (!items) return '<p class="muted">Couldn\'t load watch history.</p>';
  if (!items.length) return '<p class="muted">Hasn\'t finished anything yet.</p>';
  return `<ul>${items.map(h => `<li><span>${esc(itemName(h))}</span><small class="muted">${h.viewedAt ? when(h.viewedAt) : ''}</small></li>`).join('')}</ul>`;
}

// Jellyfin version of Manage: accounts live on the server, so "inviting" means
// creating an account and sending its sign-in link.
async function jellyfinManage(seq) {
  const s = state.server;
  const [users, sessions] = await Promise.all([s.users(), s.sessions().catch(() => [])]);
  if (stale(seq)) return;
  const others = users.filter(u => u.Id !== s.userId).sort((a, b) => a.Name.localeCompare(b.Name));
  const avatar = u => (u.PrimaryImageTag ? `<img src="${esc(s.image(`/Users/${u.Id}/Images/Primary?tag=${u.PrimaryImageTag}`, 88))}" alt="">` : esc(u.Name[0].toUpperCase()));
  const lastSeen = u => (u.LastActivityDate ? `last active ${when(Date.parse(u.LastActivityDate) / 1000)}` : 'never signed in');

  if (!mount(seq, `
    <div class="page-top pad manage">
      <h1 class="page-title">Manage</h1>
      <p class="muted">People with accounts on <strong>${esc(s.name || 'your server')}</strong> (Jellyfin), what they've finished watching, and who's watching right now.</p>

      <h2 class="group-title">Invite someone</h2>
      <form class="invite-form" id="invite-form">
        <input name="who" type="text" autocomplete="off" maxlength="40" placeholder="Their name" required aria-label="Name">
        <input name="pass" type="text" autocomplete="off" placeholder="Password (optional)" aria-label="Password">
        <button class="btn accent">Create account</button>
      </form>
      <p class="muted invite-note">This creates a Jellyfin account for them with access to all your libraries. You'll get a link to send them. It opens the sign-in screen with their name already filled in.</p>
      <div id="invite-result"></div>

      <h2 class="group-title">Watching now</h2>
      ${nowPlayingHtml(sessions) || '<p class="muted">Nobody is watching right now.</p>'}

      <h2 class="group-title">People with access</h2>
      ${others.length ? others.map((u, i) => `
        <section class="member">
          <div class="member-head">
            <span class="member-pic">${avatar(u)}</span>
            <div class="member-info">
              <strong>${esc(u.Name)}</strong>
              <small class="muted">
                ${u.Policy?.IsAdministrator ? 'Administrator' : 'Account'} · ${lastSeen(u)}
                ${u.Policy?.IsDisabled ? ' · <span class="pending">Access removed</span>' : ''}
              </small>
            </div>
            <div class="member-actions">
              <button class="btn small" data-copy="${i}">Copy sign-in link</button>
              ${u.Policy?.IsDisabled
                ? `<button class="btn small" data-enable="${i}">Restore access</button>`
                : `<button class="btn small danger" data-disable="${i}">Remove access</button>`}
              <button class="btn small danger" data-delete="${i}">Delete</button>
            </div>
          </div>
          <div class="history" id="history-${i}">${loading()}</div>
        </section>`).join('') : '<p class="muted">Nobody else has an account yet. Invite someone above.</p>'}
    </div>`)) return;

  others.forEach(async (u, i) => {
    const items = await s.history(u.Id, 10).catch(() => null);
    const box = $(`#history-${i}`);
    if (!stale(seq) && box) box.innerHTML = historyHtml(items);
  });

  const copy = async text => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied. Send it to them however you like.');
    } catch {
      prompt('Copy this link:', text);
    }
  };
  const refresh = () => {
    state.rendered = null;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  $('#invite-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const name = form.who.value.trim();
    const pass = form.pass.value;
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      await s.createUser(name, pass);
      const link = jellyfinLink(s, name);
      $('#invite-result').innerHTML = `
        <div class="invite-done">
          <p><strong>Account created for ${esc(name)}.</strong> Send them this link${pass ? ' and their password' : ''}:</p>
          <div class="link-row"><input readonly value="${esc(link)}" aria-label="Sign-in link"><button class="btn small accent" data-copy-new>Copy</button></div>
        </div>`;
      $('[data-copy-new]').addEventListener('click', () => copy(link));
      form.reset();
    } catch (err) {
      $('#invite-result').innerHTML = `<p class="error">Couldn't create the account: ${esc(err.message)}</p>`;
    } finally {
      button.disabled = false;
      button.textContent = 'Create account';
    }
  });

  app().querySelector('.manage').addEventListener('click', async e => {
    const b = e.target.closest('[data-copy],[data-disable],[data-enable],[data-delete]');
    if (!b) return;
    const u = others[b.dataset.copy ?? b.dataset.disable ?? b.dataset.enable ?? b.dataset.delete];
    if (b.hasAttribute('data-copy')) return void copy(jellyfinLink(s, u.Name));
    const action = b.hasAttribute('data-delete') ? 'delete' : b.hasAttribute('data-disable') ? 'disable' : 'enable';
    const question = {
      delete: `Delete ${u.Name}'s account? Their watch history and progress will be lost.`,
      disable: `Remove ${u.Name}'s access? They'll be signed out and can't sign back in until you restore it.`,
      enable: null,
    }[action];
    if (question && !confirm(question)) return;
    b.disabled = true;
    try {
      if (action === 'delete') await s.deleteUser(u.Id);
      else await s.updatePolicy(u.Id, { IsDisabled: action === 'disable' });
      toast({ delete: `Deleted ${u.Name}.`, disable: `${u.Name} no longer has access.`, enable: `${u.Name} has access again.` }[action]);
      refresh();
    } catch (err) {
      b.disabled = false;
      toast(`Couldn't do that: ${err.message}`);
    }
  });
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

  // Every device chooses (or creates) who's watching before picking a server.
  if (!state.profile) return void location.replace('#/profiles');

  mount(seq, shell(`
    <h2>Choose a server</h2>
    <div id="servers" class="server-list">${loading()}</div>
    <p id="connect-error" class="error" role="alert"></p>
    <div class="connect-foot">
      ${state.server ? `<a href="#/">← Back</a>` : '<span></span>'}
      <button class="link" data-action="signout">Sign out</button>
    </div>`));

  const servers = await auth.servers(viewerToken());
  if (stale(seq)) return;
  const list = $('#servers');
  const jellyfinButton = `
    <a class="server" href="#/jellyfin">
      <span class="status jf"></span>
      <span class="server-text"><strong>Jellyfin server…</strong><small>Sign in to a Jellyfin server instead</small></span>
      <span class="server-go">›</span>
    </a>`;
  if (!servers.length) {
    list.innerHTML = `<p class="muted">No Plex Media Server is linked to this account yet. Once you set one up — or a friend shares theirs with you — it'll appear here.</p>${jellyfinButton}`;
    return;
  }
  list.innerHTML = jellyfinButton + servers.map((r, i) => `
    <button class="server" data-i="${i}">
      <span class="status ${r.presence ? 'on' : ''}" title="${r.presence ? 'Online' : 'Offline'}"></span>
      <span class="server-text">
        <strong>${esc(r.name)}</strong>
        <small>${r.owned ? 'Your server' : `Shared by ${esc(r.sourceTitle || 'a friend')}`}</small>
      </span>
      <span class="server-go">›</span>
    </button>`).join('');
  $$('.server[data-i]', list).forEach(b => b.addEventListener('click', () => pickServer(servers[b.dataset.i], b)));
  if (!params.has('pick')) {
    // Reconnect to the last-used server automatically (e.g. after switching profile).
    const last = servers.findIndex(s => s.clientIdentifier === store.get('lastServerId'));
    const auto = last >= 0 ? last : servers.length === 1 ? 0 : -1;
    if (auto >= 0) pickServer(servers[auto], $$('.server[data-i]', list)[auto]);
  }
}

/* ---------- Plex Home profiles ---------- */

export async function profilesView(seq) {
  // Jellyfin users are the profiles, and they live on the server itself.
  if (state.server?.kind === 'jellyfin') return void location.replace(`#/jellyfin?server=${encodeURIComponent(state.server.uri)}`);
  hideHeader();
  pageTitle("Who's watching?");
  if (!mount(seq, `
    <div class="connect">
      <div class="profiles">
        <h1>Who's watching?</h1>
        <div class="profile-grid" id="profiles">${loading()}</div>
        <p id="connect-error" class="error" role="alert"></p>
        <div class="connect-foot">
          ${state.server ? `<a href="#/">← Back</a>` : '<span></span>'}
          <button class="link" data-action="signout">Sign out</button>
        </div>
      </div>
    </div>`)) return;

  const people = await auth.homeUsers(state.userToken);
  if (stale(seq)) return;
  const grid = $('#profiles');
  grid.innerHTML = people.map((p, i) => `
    <button class="profile ${p.uuid === state.profile?.uuid ? 'current' : ''}" data-i="${i}">
      <span class="profile-pic">${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : esc((p.title || '?')[0].toUpperCase())}</span>
      <span class="profile-name">${esc(p.title)}${p.protected ? ' <span aria-label="PIN protected">🔒</span>' : ''}</span>
    </button>`).join('') + `
    <button class="profile add" data-add>
      <span class="profile-pic">+</span>
      <span class="profile-name">Add profile</span>
    </button>`;
  grid.addEventListener('click', e => {
    const b = e.target.closest('.profile');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-add')) addProfile();
    else chooseProfile(people[b.dataset.i]);
  });
}

// Creates a Plex Home profile, gives it the libraries, and switches into it.
function addProfile() {
  if ($('.pin-box')) return;
  const tiles = $$('.profile');
  const error = $('#connect-error');
  error.textContent = '';
  const form = document.createElement('form');
  form.className = 'pin-box';
  form.innerHTML = `
    <p>Add a profile for someone who watches here.</p>
    <input name="title" class="name-input" maxlength="30" autocomplete="off" placeholder="Name" required aria-label="Profile name">
    <div class="actions">
      <button class="btn accent">Create</button>
      <button type="button" class="btn" data-cancel>Cancel</button>
    </div>`;
  $('.profiles').append(form);
  const input = form.querySelector('input');
  input.focus();
  const submit = form.querySelector('button');
  form.querySelector('[data-cancel]').addEventListener('click', () => form.remove());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    tiles.forEach(b => (b.disabled = true));
    submit.disabled = true;
    submit.textContent = 'Creating…';
    error.textContent = '';
    try {
      const person = await auth.createProfile(state.userToken, name);
      await auth.shareLibraries(state.userToken, person.id);
      const token = await auth.switchUser(state.userToken, person.uuid);
      setProfile({ uuid: person.uuid, title: person.title, thumb: person.thumb, token, admin: false });
      location.hash = '#/connect';
    } catch (err) {
      error.textContent = err.status === 401 || err.status === 403
        ? 'Only the main account can add profiles. Ask the server owner to sign in on this device.'
        : `Couldn't add the profile: ${err.message}`;
      tiles.forEach(b => (b.disabled = false));
      submit.disabled = false;
      submit.textContent = 'Create';
    }
  });
}

async function chooseProfile(person) {
  const buttons = $$('.profile');
  const error = $('#connect-error');
  error.textContent = '';
  buttons.forEach(b => (b.disabled = true));
  try {
    const pin = person.protected ? await askPin(person) : undefined;
    if (pin === null) return;
    const token = await auth.switchUser(state.userToken, person.uuid, pin);
    setProfile({ uuid: person.uuid, title: person.title, thumb: person.thumb, token, admin: !!person.admin });
    location.hash = '#/connect';
  } catch (err) {
    error.textContent = err.status === 401 || err.status === 403 ? 'Wrong PIN. Try again.' : `Couldn't switch profile: ${err.message}`;
  } finally {
    buttons.forEach(b => (b.disabled = false));
  }
}

// Resolves with the entered PIN, or null if cancelled.
function askPin(person) {
  return new Promise(resolve => {
    const form = document.createElement('form');
    form.className = 'pin-box';
    form.innerHTML = `
      <p>Enter the PIN for <strong>${esc(person.title)}</strong></p>
      <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required aria-label="PIN">
      <div class="actions">
        <button class="btn accent">Continue</button>
        <button type="button" class="btn" data-cancel>Cancel</button>
      </div>`;
    $('.profiles').append(form);
    form.pin.focus();
    const done = value => {
      form.remove();
      resolve(value);
    };
    form.addEventListener('submit', e => {
      e.preventDefault();
      done(form.pin.value);
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
  });
}

async function pickServer(resource, button) {
  const buttons = $$('.server');
  const error = $('#connect-error');
  buttons.forEach(b => (b.disabled = true));
  button.classList.add('busy');
  error.textContent = '';
  try {
    const uri = await connect(resource);
    setServer({ uri, token: resource.accessToken, name: resource.name, id: resource.clientIdentifier, owned: !!resource.owned });
    location.hash = '#/';
  } catch (err) {
    error.textContent = err.message;
    buttons.forEach(b => (b.disabled = false));
    button.classList.remove('busy');
  }
}

// Sends the browser to Plex's sign-in page (which also offers free sign-up).
async function startPlexSignIn(button, error) {
  button.disabled = true;
  error.textContent = '';
  try {
    const pin = await auth.createPin();
    sessionStorage.setItem('marquee.pin', JSON.stringify({ id: pin.id, code: pin.code }));
    location.href = auth.loginUrl(pin, location.href.split('#')[0]);
  } catch (err) {
    error.textContent = `Couldn't reach plex.tv: ${err.message}`;
    button.disabled = false;
  }
}

/* ---------- joining someone's server from an invite link ---------- */

export function inviteLink(server) {
  const base = location.href.split('#')[0];
  return `${base}#/join?server=${encodeURIComponent(server.id)}&name=${encodeURIComponent(server.name || '')}`;
}

export async function joinView(seq, params) {
  hideHeader();
  // Remember the invite across the trip to Plex's sign-in page and back.
  if (params.get('server')) store.set('join', { server: params.get('server'), name: params.get('name') || '' });
  const join = store.get('join');
  if (!join) return void location.replace('#/connect');
  const name = join.name || 'a DingFlix server';
  pageTitle(`Join ${name}`);

  if (!state.userToken) {
    if (!mount(seq, shell(`
      <h2 class="join-title">You're invited to watch <span>${esc(name)}</span></h2>
      <ol class="join-steps">
        <li>Sign in with Plex. <strong>New to Plex?</strong> Choose <strong>Sign up</strong> on the next screen. It's free.</li>
        <li>Use the <strong>same email address</strong> the invite was sent to.</li>
        <li>You'll come straight back here and can start watching.</li>
      </ol>
      <button class="btn accent block" id="join-signin">Continue with Plex</button>
      <p id="connect-error" class="error" role="alert"></p>`))) return;
    $('#join-signin').addEventListener('click', e => startPlexSignIn(e.target, $('#connect-error')));
    return;
  }

  mount(seq, shell(`
    <h2 class="join-title">Joining <span>${esc(name)}</span></h2>
    <div id="join-body"><div class="sub-busy"><div class="spinner"></div> Checking your invite…</div></div>
    <p id="connect-error" class="error" role="alert"></p>
    <div class="connect-foot"><span></span><button class="link" data-action="signout">Use a different account</button></div>`));
  await completeJoin(seq, join);
}

async function completeJoin(seq, join) {
  const body = $('#join-body');
  const error = $('#connect-error');
  const token = state.userToken;
  const hasServer = async () => (await auth.servers(token)).find(s => s.clientIdentifier === join.server);

  let resource = await hasServer();
  if (!resource) {
    const invites = await auth.receivedInvites(token);
    if (stale(seq)) return;
    // Accept on their behalf only when the invite is clearly for this server; otherwise ask.
    const matching = invites.filter(i => i.serverIds.includes(join.server));
    if (matching.length) {
      for (const invite of matching) await auth.acceptInvite(token, invite.id);
    } else if (invites.length) {
      const picked = await new Promise(resolve => {
        body.innerHTML = `
          <p>Accept the invite to start watching:</p>
          <div class="server-list">${invites.map((inv, i) => `
            <button class="server" data-invite="${i}">
              <span class="server-text"><strong>${esc(inv.serverNames.join(', ') || 'Plex libraries')}</strong><small>From ${esc(inv.from)}</small></span>
              <span class="btn small accent">Accept</span>
            </button>`).join('')}</div>`;
        body.addEventListener('click', e => {
          const b = e.target.closest('[data-invite]');
          if (b) resolve(invites[b.dataset.invite]);
        });
      });
      body.innerHTML = `<div class="sub-busy"><div class="spinner"></div> Accepting…</div>`;
      await auth.acceptInvite(token, picked.id);
    } else {
      body.innerHTML = `
        <p>We couldn't find an invite for this Plex account yet.</p>
        <ul class="join-help">
          <li>Make sure you signed in with the <strong>email address the invite was sent to</strong>.</li>
          <li>If you just signed up, give it a minute and try again.</li>
          <li>Still nothing? Ask for the invite to be sent again.</li>
        </ul>
        <button class="btn accent block" data-action="retry">Try again</button>`;
      return;
    }
    // Shares can take a few seconds to show up after accepting.
    for (let i = 0; i < 10 && !resource; i++) {
      resource = await hasServer();
      if (!resource) await new Promise(r => setTimeout(r, 2000));
    }
    if (stale(seq)) return;
    if (!resource) {
      error.textContent = 'The invite was accepted, but the server isn\'t available to this account yet. Try again in a minute.';
      body.innerHTML = `<button class="btn accent block" data-action="retry">Try again</button>`;
      return;
    }
  }

  // All set: remember the server, pick their profile, and go.
  store.set('lastServerId', resource.clientIdentifier);
  store.del('join');
  const people = await auth.homeUsers(token).catch(() => []);
  if (people.length === 1 && !people[0].protected) {
    const profileToken = await auth.switchUser(token, people[0].uuid);
    setProfile({ uuid: people[0].uuid, title: people[0].title, thumb: people[0].thumb, token: profileToken, admin: !!people[0].admin });
    location.replace('#/connect');
  } else {
    location.replace('#/profiles');
  }
}

/* ---------- Jellyfin: server address, "Who's watching?", sign-in ---------- */

export function jellyfinLink(server, userName) {
  const base = location.href.split('#')[0];
  return `${base}#/jellyfin?server=${encodeURIComponent(server.uri)}${userName ? `&user=${encodeURIComponent(userName)}&invited=1` : ''}`;
}

export async function jellyfinView(seq, params) {
  hideHeader();
  const raw = params.get('server');
  if (!raw) return renderJellyfinAddress(seq);
  const uri = jellyfinAuth.normalize(raw);
  pageTitle('Jellyfin');

  if (location.protocol === 'https:' && uri.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(uri)) {
    return renderJellyfinAddress(seq, uri, "This site is served over HTTPS, so your browser won't connect to an http:// server. Give your Jellyfin server an https:// address (see the README) and use that.");
  }

  mount(seq, shell(loading()));
  let info, people;
  try {
    [info, people] = await Promise.all([jellyfinAuth.info(uri), jellyfinAuth.publicUsers(uri).catch(() => [])]);
  } catch {
    if (!stale(seq)) renderJellyfinAddress(seq, uri, `Couldn't reach a Jellyfin server at ${uri}. Check the address and that the server is running.`);
    return;
  }
  if (stale(seq)) return;
  store.set('jfLastServer', uri);

  const invited = params.has('invited');
  const presetUser = params.get('user') || '';
  // The admin of this server (signed in on this device) can add profiles here.
  const canAdd = state.server?.kind === 'jellyfin' && state.server.uri === uri && state.server.admin;
  const avatar = p => (p.PrimaryImageTag ? `<img src="${esc(`${uri}/Users/${p.Id}/Images/Primary?tag=${p.PrimaryImageTag}&maxWidth=280`)}" alt="">` : esc((p.Name || '?')[0].toUpperCase()));

  if (!mount(seq, `
    <div class="connect">
      <div class="profiles">
        ${invited ? `<p class="muted join-kicker">You're invited to watch <strong>${esc(info.ServerName)}</strong></p>` : ''}
        <h1>Who's watching?</h1>
        <p class="muted server-sub">${esc(info.ServerName)} · Jellyfin</p>
        <div class="profile-grid" id="profiles">
          ${people.map((p, i) => `
            <button class="profile ${p.Id === state.server?.userId ? 'current' : ''}" data-i="${i}">
              <span class="profile-pic">${avatar(p)}</span>
              <span class="profile-name">${esc(p.Name)}${p.HasPassword ? ' <span aria-label="Password protected">🔒</span>' : ''}</span>
            </button>`).join('')}
          <button class="profile add" data-other>
            <span class="profile-pic">?</span>
            <span class="profile-name">Someone else</span>
          </button>
          ${canAdd ? `
            <button class="profile add" data-add>
              <span class="profile-pic">+</span>
              <span class="profile-name">Add profile</span>
            </button>` : ''}
        </div>
        <p id="connect-error" class="error" role="alert"></p>
        <div class="connect-foot">
          ${state.server ? `<a href="#/">← Back</a>` : `<a href="#/connect">← Other servers</a>`}
          <a href="#/jellyfin">Change address</a>
        </div>
      </div>
    </div>`)) return;

  const signIn = (name, hasPassword) => jellyfinSignInForm({ uri, info, name, askName: !name, askPassword: hasPassword !== false });
  $('#profiles').addEventListener('click', e => {
    const b = e.target.closest('.profile');
    if (!b || b.disabled || $('.pin-box')) return;
    if (b.hasAttribute('data-add')) return void jellyfinAddProfile({ uri, info });
    if (b.hasAttribute('data-other')) return void signIn('', true);
    const p = people[b.dataset.i];
    if (p.HasPassword) signIn(p.Name, true);
    else jellyfinLogin({ uri, info, name: p.Name, password: '' });
  });
  if (presetUser) signIn(presetUser, true);
}

function renderJellyfinAddress(seq, value = store.get('jfLastServer') || '', message = '') {
  if (!mount(seq, shell(`
    <h2>Connect to Jellyfin</h2>
    <p class="muted">Enter your Jellyfin server's address. Ask the server owner if you don't know it.</p>
    <form id="jf-address" class="manual">
      <label>Server address<input name="uri" type="text" inputmode="url" placeholder="https://jellyfin.example.com" value="${esc(value)}" required></label>
      <button class="btn accent block">Next</button>
    </form>
    <p id="connect-error" class="error" role="alert">${esc(message)}</p>
    <div class="connect-foot"><a href="#/connect">← Use Plex instead</a><span></span></div>`))) return;
  $('#jf-address').addEventListener('submit', e => {
    e.preventDefault();
    const uri = jellyfinAuth.normalize(e.target.uri.value);
    location.hash = `#/jellyfin?server=${encodeURIComponent(uri)}`;
  });
}

function jellyfinSignInForm({ uri, info, name, askName, askPassword }) {
  const form = document.createElement('form');
  form.className = 'pin-box';
  form.innerHTML = `
    <p>${askName ? 'Sign in' : `Sign in as <strong>${esc(name)}</strong>`}</p>
    ${askName ? `<input name="user" class="name-input" autocomplete="username" placeholder="Username" required aria-label="Username">` : ''}
    ${askPassword ? `<input name="pass" class="name-input" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">` : ''}
    <div class="actions">
      <button class="btn accent">Sign in</button>
      <button type="button" class="btn" data-cancel>Cancel</button>
    </div>`;
  $('.profiles').append(form);
  form.querySelector('input')?.focus();
  form.querySelector('[data-cancel]').addEventListener('click', () => form.remove());
  form.addEventListener('submit', e => {
    e.preventDefault();
    const user = askName ? form.querySelector('[name=user]').value.trim() : name;
    const pass = form.querySelector('[name=pass]')?.value || '';
    jellyfinLogin({ uri, info, name: user, password: pass, form });
  });
}

async function jellyfinLogin({ uri, info, name, password, form }) {
  const error = $('#connect-error');
  const button = form?.querySelector('button');
  error.textContent = '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Signing in…';
  }
  try {
    const session = await jellyfinAuth.login(uri, name, password);
    setServer(jellyfinAuth.serverConfig(uri, info, session));
    location.hash = '#/';
  } catch (err) {
    error.textContent = err.status === 401 ? 'Wrong username or password.' : `Couldn't sign in: ${err.message}`;
    if (button) {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  }
}

// Admin only: create a Jellyfin user for someone, then switch to them.
function jellyfinAddProfile({ uri, info }) {
  const form = document.createElement('form');
  form.className = 'pin-box';
  form.innerHTML = `
    <p>Add a profile for someone who watches here.</p>
    <input name="user" class="name-input" maxlength="40" autocomplete="off" placeholder="Name" required aria-label="Profile name">
    <input name="pass" class="name-input" type="password" autocomplete="new-password" placeholder="Password (optional)" aria-label="Password">
    <div class="actions">
      <button class="btn accent">Create</button>
      <button type="button" class="btn" data-cancel>Cancel</button>
    </div>`;
  $('.profiles').append(form);
  form.querySelector('input').focus();
  form.querySelector('[data-cancel]').addEventListener('click', () => form.remove());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.querySelector('[name=user]').value.trim();
    const pass = form.querySelector('[name=pass]').value;
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      await state.server.createUser(name, pass);
      await jellyfinLogin({ uri, info, name, password: pass });
    } catch (err) {
      $('#connect-error').textContent = `Couldn't add the profile: ${err.message}`;
      button.disabled = false;
      button.textContent = 'Create';
    }
  });
}

function renderSignIn(seq) {
  if (!mount(seq, shell(`
    <p class="muted">Sign in with your Plex account to watch from your server, or from one a friend has shared with you.</p>
    <button class="btn accent block" id="signin">Sign in with Plex</button>
    <a class="btn block jf-btn" href="#/jellyfin">Use a Jellyfin server</a>
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

  $('#signin').addEventListener('click', e => startPlexSignIn(e.target, error));

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
