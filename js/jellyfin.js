import { CONFIG } from './config.js';
import { store } from './util.js';
import { clientId, browser } from './plex.js';
import { buildCategories, featuredOrder, rowItems } from './categories.js';
import { youTubeKey } from './trailers.js';

// Jellyfin talks in 100-nanosecond "ticks"; DingFlix uses milliseconds like Plex.
const TICKS_PER_MS = 10000;
const ms = ticks => (ticks ? Math.round(ticks / TICKS_PER_MS) : undefined);

const ITEM_FIELDS = [
  'Overview', 'Genres', 'People', 'Studios', 'Taglines', 'MediaSources', 'ChildCount',
  'RecursiveItemCount', 'PrimaryImageAspectRatio', 'ParentId', 'DateCreated',
].join(',');

const TYPES = { Movie: 'movie', Series: 'show', Season: 'season', Episode: 'episode' };

const SORTS = {
  titleSort: ['SortName', 'Ascending'],
  'addedAt:desc': ['DateCreated', 'Descending'],
  'originallyAvailableAt:desc': ['PremiereDate', 'Descending'],
  'audienceRating:desc': ['CommunityRating', 'Descending'],
  'lastViewedAt:desc': ['DatePlayed', 'Descending'],
};

// DingFlix's language picker uses 2-letter codes; Jellyfin's subtitle search wants 3-letter ones.
const LANG3 = {
  en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', nl: 'dut', sv: 'swe', pl: 'pol', ru: 'rus',
  tr: 'tur', ar: 'ara', he: 'heb', hi: 'hin', ja: 'jpn', ko: 'kor', zh: 'chi', vi: 'vie', th: 'tha', id: 'ind',
};

const languageName = code => {
  if (!code || code === 'und') return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

function authHeader(token) {
  const parts = [`Client="${CONFIG.appName}"`, `Device="${browser()}"`, `DeviceId="${clientId()}"`, `Version="${CONFIG.version}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

async function request(base, path, { method = 'GET', token, params, json, raw = false, timeout = 20000, keepalive = false } = {}) {
  const url = new URL(base.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Accept: 'application/json', Authorization: authHeader(token) };
  const init = { method, headers, signal: AbortSignal.timeout(timeout), keepalive };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw Object.assign(new Error(`Jellyfin responded ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
  }
  const text = await res.text();
  if (raw) return text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/* ---------- signing in (no server connection yet) ---------- */

export const jellyfinAuth = {
  normalize(uri) {
    let u = uri.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    return u;
  },
  info(uri) { return request(uri, '/System/Info/Public', { timeout: 8000 }); },
  publicUsers(uri) { return request(uri, '/Users/Public'); },
  login(uri, username, password) {
    return request(uri, '/Users/AuthenticateByName', { method: 'POST', json: { Username: username, Pw: password || '' } });
  },
  // Server config for setServer() from a successful login.
  serverConfig(uri, info, session) {
    const admin = !!session.User?.Policy?.IsAdministrator;
    return {
      kind: 'jellyfin',
      uri,
      token: session.AccessToken,
      userId: session.User.Id,
      userName: session.User.Name,
      userImage: session.User.PrimaryImageTag || null,
      name: info.ServerName,
      id: info.Id,
      admin,
      owned: admin,
    };
  },
};

/* ---------- a connected Jellyfin server ---------- */

// Text subtitles can be drawn by the browser (so their size is adjustable);
// image-based ones (PGS, VobSub) have to be burned into the picture.
const TEXT_SUBS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'text', 'sub']);
const IMAGE_SUBS = ['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub'];

export class JellyfinServer {
  kind = 'jellyfin';
  supports = { subtitleSize: true };

  constructor({ uri, token, userId, userName, userImage, name, id, admin, guest }) {
    this.guest = guest || null; // set when signed in through a share link: the one title they can see
    this.uri = uri.replace(/\/+$/, '');
    this.token = token;
    this.userId = userId;
    this.userName = userName;
    this.userImage = userImage;
    this.name = name;
    this.id = id;
    this.admin = !!admin;
    this.owned = this.admin;
  }

  api(path, opts = {}) { return request(this.uri, path, { token: this.token, ...opts }); }

  // The address that goes into share and invite links. At home you may be connected
  // through the server's home-network address, which friends elsewhere can't reach,
  // so the owner can save the public one (Manage → Address for links).
  static isPrivate(uri) {
    try {
      const h = new URL(uri).hostname;
      return h === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local');
    } catch {
      return true;
    }
  }

  linkAddress() { return store.get(`jfLinkAddress.${this.id}`) || this.uri; }

  setLinkAddress(uri) {
    if (uri) store.set(`jfLinkAddress.${this.id}`, uri.replace(/\/+$/, ''));
    else store.del(`jfLinkAddress.${this.id}`);
  }

  url(path, params = {}) {
    const u = new URL(this.uri + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    u.searchParams.set('api_key', this.token);
    return u.toString();
  }

  authorizeUrl(url) {
    if (/[?&](api_key|ApiKey)=/i.test(url)) return url;
    const u = new URL(url, this.uri);
    u.searchParams.set('api_key', this.token);
    return u.toString();
  }

  // Image "paths" from the adapter below look like /Items/{id}/Images/Primary?tag=...
  image(path, width) {
    if (!path) return '';
    if (/^https?:/.test(path)) return path;
    const u = new URL(this.uri + path);
    if (width) u.searchParams.set('maxWidth', width);
    u.searchParams.set('quality', 90);
    return u.toString();
  }

  userAvatar() {
    return this.userImage ? this.image(`/Users/${this.userId}/Images/Primary?tag=${this.userImage}`, 96) : '';
  }

  /* --- translate Jellyfin items into the shape the pages use (Plex-like) --- */

  toItem(i) {
    if (!i) return null;
    const type = TYPES[i.Type] || (i.Type || '').toLowerCase();
    const img = (id, kind, tag) => (id && tag ? `/Items/${id}/Images/${kind}?tag=${tag}` : null);
    const ud = i.UserData || {};
    const backdrop = i.BackdropImageTags?.length
      ? img(i.Id, 'Backdrop', i.BackdropImageTags[0])
      : i.ParentBackdropImageTags?.length ? img(i.ParentBackdropItemId, 'Backdrop', i.ParentBackdropImageTags[0]) : null;
    const seriesPoster = img(i.SeriesId, 'Primary', i.SeriesPrimaryImageTag);
    const people = kind => (i.People || []).filter(p => p.Type === kind).map(p => ({
      tag: p.Name,
      id: p.Id,
      thumb: p.PrimaryImageTag ? `/Items/${p.Id}/Images/Primary?tag=${p.PrimaryImageTag}` : null,
    }));
    const unplayed = ud.UnplayedItemCount || 0;

    const item = {
      ratingKey: i.Id,
      key: i.Id,
      type,
      title: i.Name,
      year: i.ProductionYear,
      summary: i.Overview,
      tagline: i.Taglines?.[0],
      contentRating: i.OfficialRating,
      audienceRating: i.CommunityRating,
      studio: i.Studios?.[0]?.Name,
      duration: ms(i.RunTimeTicks),
      viewOffset: ms(ud.PlaybackPositionTicks),
      viewCount: ud.Played ? 1 : 0,
      lastViewedAt: ud.LastPlayedDate ? Date.parse(ud.LastPlayedDate) / 1000 : undefined,
      // Shows/seasons: these two give the unwatched badge and the "watched" state.
      leafCount: unplayed + (ud.Played ? 1 : 0),
      viewedLeafCount: ud.Played ? 1 : 0,
      childCount: i.ChildCount,
      thumb: img(i.Id, 'Primary', i.ImageTags?.Primary) || (type === 'season' ? seriesPoster : null),
      art: backdrop,
      index: i.IndexNumber,
      parentIndex: i.ParentIndexNumber,
      Genre: (i.Genres || []).map(tag => ({ tag })),
      Role: people('Actor'),
      Director: people('Director'),
      Image: i.ImageTags?.Logo ? [{ type: 'clearLogo', url: img(i.Id, 'Logo', i.ImageTags.Logo) }] : [],
      // For category rows and client-side sorting.
      countries: i.ProductionLocations || [],
      keywords: i.Tags || [],
      addedAt: i.DateCreated ? Date.parse(i.DateCreated) / 1000 : undefined,
      releasedAt: i.PremiereDate ? Date.parse(i.PremiereDate) / 1000 : undefined,
      // Only single-title lookups ask for these.
      trailers: (i.RemoteTrailers || []).map(t => t.Url),
      chapters: (i.Chapters || []).map(c => ({ name: c.Name || '', start: ms(c.StartPositionTicks) || 0 })),
      Guid: Object.entries(i.ProviderIds || {}).map(([k, v]) => ({ id: `${k.toLowerCase()}://${v}` })),
    };
    if (type === 'season') {
      Object.assign(item, { parentRatingKey: i.SeriesId || i.ParentId, parentTitle: i.SeriesName, parentThumb: seriesPoster });
    }
    if (type === 'episode') {
      Object.assign(item, {
        parentRatingKey: i.SeasonId,
        grandparentRatingKey: i.SeriesId,
        grandparentTitle: i.SeriesName,
        grandparentThumb: seriesPoster,
        grandparentArt: i.ParentBackdropImageTags?.length ? img(i.ParentBackdropItemId, 'Backdrop', i.ParentBackdropImageTags[0]) : null,
      });
    }
    const source = i.MediaSources?.[0];
    if (source) {
      const streams = source.MediaStreams || [];
      const video = streams.find(s => s.Type === 'Video');
      const audio = streams.find(s => s.Type === 'Audio' && s.Index === source.DefaultAudioStreamIndex) || streams.find(s => s.Type === 'Audio');
      item.Media = [{
        container: source.Container,
        videoCodec: video?.Codec,
        audioCodec: audio?.Codec,
        Part: [{ id: i.Id, mediaSourceId: source.Id, Stream: this.toStreams(i.Id, source) }],
      }];
    }
    return item;
  }

  toStreams(itemId, source) {
    const choice = store.get(`jfTracks.${itemId}`) || {};
    const defaultAudio = choice.audio ?? source.DefaultAudioStreamIndex;
    const streams = source.MediaStreams || [];
    // Until they pick (or turn off) subtitles on this device, do what Jellyfin's own
    // apps do: its default track (forced subtitles, such as translations of the bits
    // in another language), else a forced track in the audio's language.
    let defaultSub = choice.subtitle;
    if (!('subtitle' in choice)) {
      const audioLang = streams.find(s => s.Index === defaultAudio)?.Language;
      const forced = streams.filter(s => s.Type === 'Subtitle' && s.IsForced);
      defaultSub = source.DefaultSubtitleStreamIndex >= 0
        ? source.DefaultSubtitleStreamIndex
        : (forced.find(s => s.Language && s.Language === audioLang) || forced.find(s => !s.Language || s.Language === 'und') || null)?.Index;
    }
    return streams
      .filter(s => ['Video', 'Audio', 'Subtitle'].includes(s.Type))
      .map(s => {
        const streamType = { Video: 1, Audio: 2, Subtitle: 3 }[s.Type];
        const lang = languageName(s.Language);
        const codec = (s.Codec || '').toUpperCase().replace('SUBRIP', 'SRT').replace('PGSSUB', 'PGS');
        const channels = s.Channels ? ` ${s.Channels === 2 ? 'Stereo' : s.Channels === 1 ? 'Mono' : `${s.Channels - 1}.1`}` : '';
        const label = streamType === 2
          ? `${lang || 'Unknown'} (${codec}${channels})`
          : `${lang || s.Title || 'Unknown'}${s.IsForced ? ' Forced' : ''}${s.IsHearingImpaired ? ' SDH' : ''}${s.IsExternal ? ' (downloaded)' : ''}`;
        return {
          id: s.Index,
          index: s.Index,
          streamType,
          codec: s.Codec,
          language: lang,
          languageCode: s.Language,
          displayTitle: label,
          title: s.Title,
          forced: s.IsForced,
          selected: streamType === 2 ? s.Index === defaultAudio : streamType === 3 ? s.Index === defaultSub : false,
        };
      });
  }

  // Wraps a list in the "hub" shape the home page renders as a row.
  hub(title, type, items, id) {
    return { title, type, hubIdentifier: id || title, Metadata: items.map(x => this.toItem(x)).filter(Boolean) };
  }

  query(params) {
    return this.api('/Items', { params: { userId: this.userId, Fields: ITEM_FIELDS, EnableUserData: true, ...params } });
  }

  /* --- the same methods the pages call on PlexServer --- */

  async info() {
    const i = await request(this.uri, '/System/Info/Public');
    return { friendlyName: i.ServerName, machineIdentifier: i.Id };
  }

  async sections() {
    const views = await this.api('/UserViews', { params: { userId: this.userId } });
    return (views.Items || [])
      .filter(v => v.CollectionType === 'movies' || v.CollectionType === 'tvshows')
      .map(v => ({ key: v.Id, title: v.Name, type: v.CollectionType === 'movies' ? 'movie' : 'show' }));
  }

  scanAll() { return this.api('/Library/Refresh', { method: 'POST', raw: true }); }

  async isScanning() {
    const tasks = await this.api('/ScheduledTasks', { params: { isHidden: false } });
    return (tasks || []).some(t => t.Key === 'RefreshLibrary' && t.State === 'Running');
  }

  async items(sectionId, { sort = 'titleSort', start = 0, size = 60 } = {}) {
    const [by, order] = SORTS[sort] || SORTS.titleSort;
    const r = await this.query({
      ParentId: sectionId, Recursive: true, IncludeItemTypes: 'Movie,Series',
      SortBy: by === 'SortName' ? 'SortName' : `${by},SortName`, SortOrder: order, StartIndex: start, Limit: size,
    });
    return { items: (r.Items || []).map(x => this.toItem(x)), total: r.TotalRecordCount ?? 0 };
  }

  async latest(sectionId, limit = 20) {
    return this.api('/Items/Latest', { params: { userId: this.userId, ParentId: sectionId, Limit: limit, Fields: ITEM_FIELDS, GroupItems: true } });
  }

  // Every title in a library (with genres, countries and keywords), kept for a few
  // minutes so category rows and the full grid don't refetch on every page.
  async catalog(sectionId) {
    this.catalogs ??= new Map();
    const cached = this.catalogs.get(sectionId);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.items;
    const section = (await this.sections()).find(s => s.key === sectionId);
    const r = await this.query({
      ParentId: sectionId, Recursive: true, IncludeItemTypes: section?.type === 'show' ? 'Series' : 'Movie',
      SortBy: 'SortName', Limit: 10000, Fields: `${ITEM_FIELDS},Tags,ProductionLocations,PremiereDate`,
    });
    const items = (r.Items || []).map(x => this.toItem(x));
    this.catalogs.set(sectionId, { at: Date.now(), items });
    return items;
  }

  // Category rows (Korean, Action, Revenge, …) for a library, in a varied order.
  async categories(sectionId) {
    const section = (await this.sections()).find(s => s.key === sectionId);
    const noun = section?.type === 'show' ? 'Shows' : 'Movies';
    return featuredOrder(buildCategories(await this.catalog(sectionId), { noun }));
  }

  async hubs() {
    const sections = await this.sections();
    const [nextUp, latest, categories] = await Promise.all([
      this.api('/Shows/NextUp', { params: { userId: this.userId, Limit: 20, Fields: ITEM_FIELDS } }).catch(() => ({ Items: [] })),
      Promise.all(sections.map(s => this.latest(s.key).catch(() => []))),
      Promise.all(sections.map(s => this.categories(s.key).catch(() => []))),
    ]);
    // A taste of each library's categories on the home page; the library page has them all.
    const categoryRows = sections.flatMap((s, i) => categories[i].slice(0, s.type === 'movie' ? 6 : 3).map(cat => ({
      title: cat.kind === 'genre' ? `${cat.label} ${s.type === 'show' ? 'Shows' : 'Movies'}` : cat.label,
      type: s.type,
      hubIdentifier: `cat-${s.key}-${cat.key}`,
      link: `#/library/${s.key}?cat=${cat.key}`,
      Metadata: rowItems(cat),
    })));
    return [
      this.hub('Next Up', 'episode', nextUp.Items || [], 'nextup'),
      ...sections.map((s, i) => this.hub(`Recently Added ${s.title}`, s.type, latest[i] || [])),
      ...categoryRows,
    ];
  }

  async sectionHubs(id) {
    const section = (await this.sections()).find(s => s.key === id);
    const type = section?.type || 'movie';
    const kinds = type === 'movie' ? 'Movie' : 'Series';
    const [latest, released, rated] = await Promise.all([
      this.latest(id).catch(() => []),
      this.query({ ParentId: id, Recursive: true, IncludeItemTypes: kinds, SortBy: 'PremiereDate', SortOrder: 'Descending', Limit: 20 }).catch(() => ({})),
      this.query({ ParentId: id, Recursive: true, IncludeItemTypes: kinds, SortBy: 'CommunityRating', SortOrder: 'Descending', Limit: 20 }).catch(() => ({})),
    ]);
    return [
      this.hub('Recently Added', type, latest),
      this.hub('Recently Released', type, released.Items || []),
      this.hub('Top Rated', type, rated.Items || []),
    ];
  }

  // Recommendation rows for a title page: Jellyfin's "similar" list, more from the same
  // director, and more from the title's most specific categories (country, themes, genre).
  async recommendations(item) {
    const rows = await this.related(item.ratingKey).catch(() => []);
    const sections = (await this.sections()).filter(s => s.type === item.type);
    let section, catalog;
    for (const s of sections) {
      const list = await this.catalog(s.key).catch(() => []);
      if (list.some(x => x.ratingKey === item.ratingKey)) [section, catalog] = [s, list];
    }
    if (!catalog) return rows;
    const others = catalog.filter(x => x.ratingKey !== item.ratingKey);

    const director = item.Director?.[0]?.tag;
    if (director) {
      const byDirector = others.filter(x => x.Director?.some(d => d.tag === director));
      if (byDirector.length) rows.push({ title: `More from ${director}`, type: item.type, hubIdentifier: 'director', Metadata: byDirector.slice(0, 20) });
    }

    const noun = section.type === 'show' ? 'Shows' : 'Movies';
    const mine = (await this.categories(section.key)).filter(c => c.items.some(x => x.ratingKey === item.ratingKey));
    // Country first, then the most distinctive themes (Revenge, Anime, …), then genres.
    const kindRank = { country: 0, theme: 1, genre: 2 };
    const picks = mine.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.rank - b.rank || b.items.length - a.items.length).slice(0, 3);
    for (const c of picks) {
      const list = c.items.filter(x => x.ratingKey !== item.ratingKey);
      if (!list.length) continue;
      const label = c.kind === 'genre' ? `${c.label} ${noun}` : c.label;
      rows.push({ title: `More ${label}`, type: item.type, hubIdentifier: `rec-${c.key}`, link: `#/library/${section.key}?cat=${c.key}`, Metadata: list.slice(0, 20) });
    }
    return rows;
  }

  async related(id) {
    const r = await this.api(`/Items/${id}/Similar`, { params: { userId: this.userId, Limit: 16, Fields: ITEM_FIELDS } });
    const items = r.Items || [];
    return items.length ? [this.hub('More Like This', TYPES[items[0].Type] || 'movie', items)] : [];
  }

  async onDeck() {
    const r = await this.api('/UserItems/Resume', { params: { userId: this.userId, Limit: 20, MediaTypes: 'Video', Fields: ITEM_FIELDS } });
    return (r.Items || []).map(x => this.toItem(x));
  }

  async search(query) {
    const r = await this.query({ searchTerm: query, Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', Limit: 60 });
    const of = t => (r.Items || []).filter(x => x.Type === t);
    return [this.hub('Movies', 'movie', of('Movie')), this.hub('Shows', 'show', of('Series')), this.hub('Episodes', 'episode', of('Episode'))];
  }

  async metadata(id) {
    const item = await this.api(`/Items/${id}`, { params: { userId: this.userId, Fields: `${ITEM_FIELDS},RemoteTrailers,ProviderIds,Tags,Chapters` } }).catch(err => {
      if (err.status === 404) throw new Error('That title is no longer on the server.');
      throw err;
    });
    return this.toItem(item);
  }

  // The title plus the YouTube id of its trailer (null if it has none), for previews.
  trailer(id) {
    this.trailers ??= new Map();
    if (!this.trailers.has(id)) {
      this.trailers.set(id, this.metadata(id).then(item => ({ item, key: youTubeKey(item.trailers) })).catch(() => {
        this.trailers.delete(id);
        return { key: null };
      }));
    }
    return this.trailers.get(id);
  }

  async children(id) {
    const r = await this.query({ ParentId: id, SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
    return (r.Items || []).map(x => this.toItem(x));
  }

  async allLeaves(seriesId) {
    const r = await this.api(`/Shows/${seriesId}/Episodes`, { params: { userId: this.userId, Fields: ITEM_FIELDS } });
    return (r.Items || []).map(x => this.toItem(x));
  }

  /* --- what plays next --- */

  // When the end credits start (ms): Jellyfin's media segments (from a plugin such
  // as Intro Skipper), else a chapter called "Credits" or similar in the second half.
  async creditsStart(item) {
    const r = await this.api(`/MediaSegments/${item.ratingKey}`, { params: { includeSegmentTypes: 'Outro' } }).catch(() => null);
    const outro = (r?.Items || []).map(x => ms(x.StartTicks)).filter(Boolean).sort((a, b) => a - b)[0];
    if (outro) return outro;
    const half = (item.duration || 0) / 2;
    return (item.chapters || []).find(c => c.start > half && /credits|outro|ending/i.test(c.name))?.start ?? null;
  }

  // The next film in the same collection (TMDb's, e.g. "The Matrix Collection"), by release date.
  async sequel(item) {
    const coll = item.Guid?.find(g => g.id.startsWith('tmdbcollection://'))?.id.slice('tmdbcollection://'.length);
    if (!coll) return null;
    if (!this.movieIds || Date.now() - this.movieIds.at > 10 * 60 * 1000) {
      const r = await this.query({ IncludeItemTypes: 'Movie', Recursive: true, Fields: 'ProviderIds,PremiereDate', EnableUserData: false, EnableImages: false });
      this.movieIds = { at: Date.now(), items: r.Items || [] };
    }
    const released = m => (m.PremiereDate ? Date.parse(m.PremiereDate) : m.ProductionYear ? Date.UTC(m.ProductionYear, 0) : Infinity);
    const films = this.movieIds.items.filter(m => m.ProviderIds?.TmdbCollection === coll).sort((a, b) => released(a) - released(b));
    const i = films.findIndex(m => m.Id === item.ratingKey);
    return i >= 0 && films[i + 1] ? this.metadata(films[i + 1].Id) : null;
  }

  scrobble(id) { return this.api(`/UserPlayedItems/${id}`, { method: 'POST', params: { userId: this.userId } }); }
  unscrobble(id) { return this.api(`/UserPlayedItems/${id}`, { method: 'DELETE', params: { userId: this.userId } }); }

  // Jellyfin doesn't store track choices per file, so remember them on this device.
  async selectStreams(itemId, ids) {
    const choice = store.get(`jfTracks.${itemId}`) || {};
    if ('audioStreamID' in ids) choice.audio = ids.audioStreamID;
    if ('subtitleStreamID' in ids) choice.subtitle = ids.subtitleStreamID || null;
    store.set(`jfTracks.${itemId}`, choice);
  }

  /* --- playback --- */

  deviceProfile(maxBitrate) {
    return {
      MaxStreamingBitrate: maxBitrate,
      MaxStaticBitrate: maxBitrate,
      DirectPlayProfiles: [{ Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' }],
      TranscodingProfiles: [{
        Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls',
        Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true,
      }],
      // Text subtitles come as a separate WebVTT file the browser draws (resizable);
      // image subtitles are burned into the picture.
      SubtitleProfiles: [
        ...[...TEXT_SUBS].map(Format => ({ Format, Method: 'External' })),
        ...IMAGE_SUBS.map(Format => ({ Format, Method: 'Encode' })),
      ],
      CodecProfiles: [],
      ContainerProfiles: [],
    };
  }

  async playback(item, { quality, forceTranscode, startAt = 0 }) {
    const part = item.Media?.[0]?.Part?.[0];
    if (!part) throw new Error('This title has no playable file.');
    const audio = part.Stream.find(s => s.streamType === 2 && s.selected);
    const sub = part.Stream.find(s => s.streamType === 3 && s.selected);
    const textSub = sub && TEXT_SUBS.has((sub.codec || '').toLowerCase());
    const firstAudio = part.Stream.find(s => s.streamType === 2);
    const maxBitrate = quality.bitrate ? quality.bitrate * 1000 : 120000000;
    // A text subtitle doesn't stop the file playing as-is; a burned-in one does.
    const allowDirect = !quality.bitrate && !forceTranscode && (!sub || textSub) && (!audio || audio === firstAudio);
    const info = await this.api(`/Items/${item.ratingKey}/PlaybackInfo`, {
      method: 'POST',
      params: {
        userId: this.userId,
        mediaSourceId: part.mediaSourceId,
        audioStreamIndex: audio?.id,
        subtitleStreamIndex: sub ? sub.id : -1,
        maxStreamingBitrate: maxBitrate,
        startTimeTicks: Math.round(startAt * 1000 * TICKS_PER_MS),
        isPlayback: true,
        autoOpenLiveStream: true,
      },
      json: {
        DeviceProfile: this.deviceProfile(maxBitrate),
        EnableDirectPlay: allowDirect,
        EnableDirectStream: false,
        EnableTranscoding: true,
        AllowVideoStreamCopy: true,
        AllowAudioStreamCopy: true,
      },
    });
    if (info.ErrorCode) throw new Error(`The server can't play this file (${info.ErrorCode}).`);
    const source = info.MediaSources?.[0];
    if (!source) throw new Error("The server didn't return anything to play.");
    const base = { playSessionId: info.PlaySessionId, mediaSourceId: source.Id, audio: audio?.id, sub: sub?.id };
    if (textSub) {
      base.textTrack = {
        url: this.url(`/Videos/${item.ratingKey}/${source.Id}/Subtitles/${sub.id}/0/Stream.vtt`),
        label: sub.displayTitle,
        language: sub.languageCode,
      };
    }
    if (allowDirect && source.SupportsDirectPlay) {
      return {
        ...base,
        mode: 'direct',
        method: 'DirectPlay',
        url: this.url(`/Videos/${item.ratingKey}/stream`, { static: true, mediaSourceId: source.Id, deviceId: clientId(), playSessionId: info.PlaySessionId }),
      };
    }
    if (!source.TranscodingUrl) {
      throw new Error(`The server can't convert this file for your browser${source.TranscodeReasons?.length ? ` (${source.TranscodeReasons.join(', ')})` : ''}.`);
    }
    return { ...base, mode: 'hls', method: 'Transcode', url: this.authorizeUrl(this.uri + source.TranscodingUrl) };
  }

  stopPlayback(plan) {
    if (!plan?.playSessionId) return;
    this.api('/Videos/ActiveEncodings', { method: 'DELETE', params: { deviceId: clientId(), playSessionId: plan.playSessionId } }).catch(() => {});
  }

  reportPlayback(item, plan, playState, timeMs) {
    if (!plan) return;
    const body = {
      ItemId: item.ratingKey,
      MediaSourceId: plan.mediaSourceId,
      PlaySessionId: plan.playSessionId,
      PositionTicks: Math.round(timeMs * TICKS_PER_MS),
      IsPaused: playState === 'paused',
      PlayMethod: plan.method,
      AudioStreamIndex: plan.audio,
      SubtitleStreamIndex: plan.sub ?? -1,
      CanSeek: true,
    };
    let path = '/Sessions/Playing/Progress';
    if (playState === 'stopped') path = '/Sessions/Playing/Stopped';
    else if (!plan.started) {
      plan.started = true;
      path = '/Sessions/Playing';
    }
    return this.api(path, { method: 'POST', json: body, raw: true });
  }

  /* --- watching together ---
     Jellyfin pushes messages to each DingFlix tab over a WebSocket. Parties use
     Jellyfin's "display a message" command to talk between tabs, and the session
     list to see what friends are watching. Both need Jellyfin's "Allow remote
     control of other users" permission (Manage → Watch together). */

  socketUrl() {
    const u = new URL(`${this.uri}/socket`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('api_key', this.token);
    u.searchParams.set('deviceId', clientId());
    return u.toString();
  }

  // Tells Jellyfin this tab can receive messages. It offers nothing to play, so it
  // doesn't show up as a "Play on" target in other Jellyfin apps.
  announce() {
    return this.api('/Sessions/Capabilities/Full', {
      method: 'POST',
      json: { PlayableMediaTypes: [], SupportedCommands: ['DisplayMessage'], SupportsMediaControl: true, SupportsPersistentIdentifier: false },
      raw: true,
    });
  }

  async mySessionId() {
    const list = await this.api('/Sessions', { params: { deviceId: clientId() } });
    return (list || []).find(x => x.UserId === this.userId)?.Id || null;
  }

  sendMessage(sessionId, data, { keepalive = false } = {}) {
    return this.api(`/Sessions/${sessionId}/Message`, {
      method: 'POST',
      json: { Header: 'dingflix', Text: JSON.stringify(data), TimeoutMs: 1000 },
      raw: true,
      keepalive,
      timeout: 8000,
    });
  }

  // Other people's sessions that are playing something (only ones this account may reach).
  async watchSessions() {
    const list = await this.api('/Sessions', { params: { controllableByUserId: this.userId, activeWithinSeconds: 600 } });
    return (list || []).filter(x => x.NowPlayingItem && x.UserId !== this.userId && !JellyfinServer.parseShareName(x.UserName));
  }

  // What friends are watching right now, as cards for the home page.
  async friendsWatching() {
    const live = await this.watchSessions();
    if (!live.length) return [];
    // Asking for the titles as this person leaves out anything hidden from them.
    const r = await this.query({ Ids: [...new Set(live.map(x => x.NowPlayingItem.Id))].join(',') });
    const items = new Map((r.Items || []).map(x => [x.Id, x]));
    return live.filter(x => items.has(x.NowPlayingItem.Id)).map(x => ({
      ...this.toItem(items.get(x.NowPlayingItem.Id)),
      friend: {
        name: x.UserName,
        sessionId: x.Id,
        dingflix: x.Client === CONFIG.appName,
        paused: !!x.PlayState?.IsPaused,
        position: ms(x.PlayState?.PositionTicks) || 0,
      },
    }));
  }

  // Watch together is on when everyone (other than admins, who can already) has the permission.
  static togetherOn(users) {
    const people = users.filter(u => !u.Policy?.IsAdministrator && !JellyfinServer.parseShareName(u.Name));
    return people.length > 0 && people.every(u => u.Policy?.EnableRemoteControlOfOtherUsers);
  }

  async setTogether(on) {
    const users = await this.users();
    for (const u of users) {
      if (JellyfinServer.parseShareName(u.Name)) continue;
      if (u.Policy?.IsAdministrator && !on) continue; // admins keep it
      if (!!u.Policy?.EnableRemoteControlOfOtherUsers !== on) await this.updatePolicy(u.Id, { EnableRemoteControlOfOtherUsers: on });
    }
  }

  /* --- online subtitles (needs Jellyfin's Open Subtitles plugin) --- */

  async searchSubtitles(itemId, language) {
    const noProvider = new Error('Jellyfin needs its Open Subtitles plugin for this. In Jellyfin go to Dashboard → Plugins → Catalog, install "Open Subtitles", restart Jellyfin, then sign the plugin in to a free OpenSubtitles.com account');
    let results;
    try {
      results = await this.api(`/Items/${itemId}/RemoteSearch/Subtitles/${LANG3[language] || language}`, { timeout: 45000 });
    } catch (err) {
      if (err.status === 404) throw noProvider;
      // Usually the plugin isn't signed in yet, or its account hit OpenSubtitles' daily limit.
      throw new Error(`Jellyfin couldn't search (${err.name === 'TimeoutError' ? 'it took too long' : err.message}). Check that the Open Subtitles plugin is signed in to your OpenSubtitles.com account (Dashboard → Plugins → Open Subtitles), then restart Jellyfin`);
    }
    // An empty list can mean "nothing found" or "no provider installed"; tell them apart.
    if (!results?.length) {
      const plugins = await this.api('/Plugins').catch(() => null);
      if (plugins && !plugins.some(p => /subtitle/i.test(p.Name))) throw noProvider;
    }
    return (results || []).map(r => ({
      key: r.Id,
      title: r.Name,
      codec: r.Format,
      perfectMatch: r.IsHashMatch,
      hearingImpaired: r.HearingImpaired,
      providerTitle: r.ProviderName,
    }));
  }

  downloadSubtitle(itemId, result) {
    return this.api(`/Items/${itemId}/RemoteSearch/Subtitles/${encodeURIComponent(result.key)}`, { method: 'POST', raw: true, timeout: 45000 });
  }

  /* --- owner tools (Manage tab) --- */

  async sessions() {
    const list = await this.api('/Sessions', { params: { activeWithinSeconds: 960 } });
    return (list || []).filter(s => s.NowPlayingItem).map(s => ({
      ...this.toItem(s.NowPlayingItem),
      viewOffset: ms(s.PlayState?.PositionTicks),
      User: { title: s.UserName },
      Player: { state: s.PlayState?.IsPaused ? 'paused' : 'playing', product: s.Client, title: s.DeviceName },
    }));
  }

  async history(userId, size = 20) {
    const r = await this.api('/Items', {
      params: {
        userId, Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending', Recursive: true,
        IncludeItemTypes: 'Movie,Episode', Limit: size, Fields: ITEM_FIELDS, EnableUserData: true,
      },
    });
    return (r.Items || []).map(x => ({ ...this.toItem(x), viewedAt: x.UserData?.LastPlayedDate ? Date.parse(x.UserData.LastPlayedDate) / 1000 : 0 }));
  }

  users() { return this.api('/Users'); }

  // New accounts are shown on the "Who's watching?" screen and can see every library.
  // `together` also lets them watch along with everyone else (see Watch together below).
  async createUser(name, password, { together = false } = {}) {
    const user = await this.api('/Users/New', { method: 'POST', json: { Name: name, Password: password || '' } });
    await this.updatePolicy(user.Id, { IsHidden: false, EnableAllFolders: true, BlockedTags: ['dfhide-all'], EnableRemoteControlOfOtherUsers: together });
    return user;
  }

  async updatePolicy(userId, changes) {
    const user = await this.api(`/Users/${userId}`);
    return this.api(`/Users/${userId}/Policy`, { method: 'POST', json: { ...user.Policy, ...changes }, raw: true });
  }

  deleteUser(userId) { return this.api(`/Users/${userId}`, { method: 'DELETE', raw: true }); }

  /* --- share links: one title, no sign-up (owner only) --- */

  async setTag(itemId, tag, on) {
    const item = await this.api(`/Items/${itemId}`, { params: { userId: this.userId } });
    const tags = new Set(item.Tags || []);
    if (on) tags.add(tag);
    else tags.delete(tag);
    item.Tags = [...tags];
    await this.api(`/Items/${itemId}`, { method: 'POST', json: item, raw: true });
  }

  // Tags a movie, or a show with all its seasons and episodes.
  async tagTree(itemId, tag, on) {
    const item = await this.api(`/Items/${itemId}`, { params: { userId: this.userId } });
    const targets = [itemId];
    if (item.Type === 'Series' || item.Type === 'Season') {
      const kids = await this.api('/Items', { params: { userId: this.userId, ParentId: itemId, Recursive: true, IncludeItemTypes: 'Season,Episode' } });
      targets.push(...(kids.Items || []).map(k => k.Id));
    }
    for (const target of targets) await this.setTag(target, tag, on);
  }

  // Shares one movie or show: tags it (a show's seasons and episodes too), then
  // creates a hidden guest account that can only see items with that tag.
  async createShare(itemId, { note = '', days = 0 } = {}) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tag = `dfshare-${id}`;
    const expires = days ? Date.now() + days * 86400000 : 0;
    const cleanNote = note.replace(/[^\w .'@+-]/g, '').trim().slice(0, 30);
    const name = `share-${id}-${expires ? expires.toString(36) : 'never'}${cleanNote ? ` ${cleanNote}` : ''}`;
    const password = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 28);

    await this.tagTree(itemId, tag, true);

    const user = await this.api('/Users/New', { method: 'POST', json: { Name: name, Password: password } });
    await this.updatePolicy(user.Id, {
      IsHidden: true,
      IsAdministrator: false,
      EnableAllFolders: true,
      AllowedTags: [tag],
      EnableContentDownloading: false,
      EnableContentDeletion: false,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableLiveTvAccess: false,
      EnableLiveTvManagement: false,
      MaxActiveSessions: 2,
    });
    return { id, userId: user.Id, link: { s: this.linkAddress(), u: name, p: password, i: itemId, x: expires } };
  }

  // Everything DingFlix needs about a share is in its guest account's name.
  static parseShareName(name) {
    const m = /^share-([a-z0-9]+)-([a-z0-9]+)(?: (.*))?$/.exec(name || '');
    if (!m) return null;
    return { id: m[1], tag: `dfshare-${m[1]}`, expires: m[2] === 'never' ? 0 : parseInt(m[2], 36), note: m[3] || '', created: parseInt(m[1].slice(0, -4), 36) };
  }

  async shares() {
    const users = await this.users();
    const list = users.map(u => ({ ...JellyfinServer.parseShareName(u.Name), user: u })).filter(s => s.id);
    await Promise.all(list.map(async s => {
      const r = await this.api('/Items', { params: { userId: this.userId, Tags: s.tag, Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: ITEM_FIELDS } }).catch(() => ({}));
      s.item = this.toItem((r.Items || [])[0]);
      s.lastUsed = s.user.LastActivityDate ? Date.parse(s.user.LastActivityDate) : 0;
      s.expired = !!s.expires && s.expires < Date.now();
    }));
    return list.sort((a, b) => b.created - a.created);
  }

  async revokeShare(share) {
    await this.deleteUser(share.user.Id).catch(err => { if (err.status !== 404) throw err; });
    const r = await this.api('/Items', { params: { userId: this.userId, Tags: share.tag, Recursive: true } }).catch(() => ({}));
    for (const item of r.Items || []) await this.setTag(item.Id, share.tag, false).catch(() => {});
  }

  /* --- hiding titles from people (owner only) ---
     A hidden title gets a `dfhide-all` or `dfhide-<user id>` tag, and those people's
     accounts block that tag, so it's gone for them in every Jellyfin app too. */

  // Everyone who isn't an administrator or a share-link guest.
  async people() {
    return (await this.users()).filter(u => !u.Policy?.IsAdministrator && !JellyfinServer.parseShareName(u.Name));
  }

  async blockTag(user, tag) {
    const blocked = user.Policy?.BlockedTags || [];
    if (blocked.includes(tag)) return;
    await this.api(`/Users/${user.Id}/Policy`, { method: 'POST', json: { ...user.Policy, BlockedTags: [...blocked, tag] }, raw: true });
  }

  // `who` is 'all' or a user id.
  async hide(itemId, who) {
    const tag = `dfhide-${who}`;
    await this.tagTree(itemId, tag, true);
    const users = who === 'all' ? await this.people() : [await this.api(`/Users/${who}`)];
    for (const u of users) await this.blockTag(u, tag);
  }

  unhide(itemId, tag) { return this.tagTree(itemId, tag, false); }

  // Who each hide tag is for, by name.
  async hideTags() {
    const users = await this.users();
    return new Map([['dfhide-all', 'everyone'], ...users.map(u => [`dfhide-${u.Id}`, u.Name])]);
  }

  async hidden() {
    const names = await this.hideTags();
    const r = await this.api('/Items', {
      params: { userId: this.userId, Tags: [...names.keys()].join('|'), Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: `${ITEM_FIELDS},Tags` },
    });
    return (r.Items || []).map(x => ({
      item: this.toItem(x),
      from: (x.Tags || []).filter(t => names.has(t)).map(tag => ({ tag, name: names.get(tag) })),
    }));
  }

  // Accounts made after something was hidden from everyone need the block too.
  async syncHidden() {
    for (const u of await this.people()) await this.blockTag(u, 'dfhide-all');
  }

  /* --- requests: titles people would like added ---
     Kept in each person's own Jellyfin display preferences, which the owner (an
     administrator) can read and update too, so no extra server is needed. */

  prefs(userId) {
    return this.api('/DisplayPreferences/dingflix', { params: { userId, client: 'dingflix' } });
  }

  async requests(userId = this.userId) {
    const prefs = await this.prefs(userId);
    try {
      return JSON.parse(prefs?.CustomPrefs?.requests || '[]');
    } catch {
      return [];
    }
  }

  async editRequests(userId, change) {
    const prefs = (await this.prefs(userId)) || {};
    let list;
    try {
      list = JSON.parse(prefs.CustomPrefs?.requests || '[]');
    } catch {
      list = [];
    }
    prefs.CustomPrefs = { ...prefs.CustomPrefs, requests: JSON.stringify(change(list)) };
    await this.api('/DisplayPreferences/dingflix', { method: 'POST', params: { userId, client: 'dingflix' }, json: prefs, raw: true });
  }

  addRequest({ title, kind, note }) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return this.editRequests(this.userId, list => [{ id, title, kind, note, at: Date.now(), status: 'open' }, ...list].slice(0, 50));
  }

  removeRequest(userId, id) { return this.editRequests(userId, list => list.filter(r => r.id !== id)); }

  setRequestStatus(userId, id, status) {
    return this.editRequests(userId, list => list.map(r => (r.id === id ? { ...r, status, doneAt: Date.now() } : r)));
  }

  // Everyone's requests, open ones first (owner only).
  async allRequests() {
    const users = (await this.users()).filter(u => !JellyfinServer.parseShareName(u.Name));
    const lists = await Promise.all(users.map(u => this.requests(u.Id).then(l => l.map(r => ({ ...r, user: u })), () => [])));
    return lists.flat().sort((a, b) => (a.status !== 'open') - (b.status !== 'open') || b.at - a.at);
  }

  /* --- coming up: episodes not out yet, for shows in the library --- */

  async upcoming(limit = 40) {
    const r = await this.api('/Shows/Upcoming', { params: { userId: this.userId, Limit: limit, Fields: `${ITEM_FIELDS},PremiereDate` } });
    return (r.Items || [])
      .map(x => ({ ...this.toItem(x), upcoming: true, airsAt: x.PremiereDate ? Date.parse(x.PremiereDate) : 0 }))
      .filter(x => x.airsAt);
  }

  /* --- people: everything in the library with an actor or director --- */

  async person(id) {
    const titles = types => this.query({ PersonIds: id, PersonTypes: types, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' })
      .then(r => (r.Items || []).map(x => this.toItem(x)));
    const [p, directed, acted] = await Promise.all([
      this.api(`/Items/${id}`, { params: { userId: this.userId } }).catch(() => ({})),
      titles('Director'),
      titles('Actor,GuestStar'),
    ]);
    return {
      name: p.Name,
      summary: p.Overview,
      thumb: p.ImageTags?.Primary ? `/Items/${id}/Images/Primary?tag=${p.ImageTags.Primary}` : null,
      born: p.PremiereDate ? new Date(p.PremiereDate).getFullYear() : null,
      place: p.ProductionLocations?.[0],
      directed,
      acted,
    };
  }
}

// Share links carry the guest login (server, username, password, title) in the URL.
export const shareCode = {
  encode(data) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(code) {
    try {
      const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch {
      return null;
    }
  },
};
