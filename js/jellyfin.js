import { CONFIG } from './config.js';
import { store } from './util.js';
import { clientId, browser } from './plex.js';

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

async function request(base, path, { method = 'GET', token, params, json, raw = false, timeout = 20000 } = {}) {
  const url = new URL(base.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Accept: 'application/json', Authorization: authHeader(token) };
  const init = { method, headers, signal: AbortSignal.timeout(timeout) };
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
    const people = kind => (i.People || []).filter(p => p.Type === kind).map(p => ({ tag: p.Name }));
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
    return (source.MediaStreams || [])
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
          selected: streamType === 2 ? s.Index === defaultAudio : streamType === 3 ? s.Index === choice.subtitle : false,
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

  async hubs() {
    const sections = await this.sections();
    const [nextUp, ...latest] = await Promise.all([
      this.api('/Shows/NextUp', { params: { userId: this.userId, Limit: 20, Fields: ITEM_FIELDS } }).catch(() => ({ Items: [] })),
      ...sections.map(s => this.latest(s.key).catch(() => [])),
    ]);
    return [
      this.hub('Next Up', 'episode', nextUp.Items || [], 'nextup'),
      ...sections.map((s, i) => this.hub(`Recently Added ${s.title}`, s.type, latest[i] || [])),
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
    const item = await this.api(`/Items/${id}`, { params: { userId: this.userId, Fields: ITEM_FIELDS } }).catch(err => {
      if (err.status === 404) throw new Error('That title is no longer on the server.');
      throw err;
    });
    return this.toItem(item);
  }

  async children(id) {
    const r = await this.query({ ParentId: id, SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
    return (r.Items || []).map(x => this.toItem(x));
  }

  async allLeaves(seriesId) {
    const r = await this.api(`/Shows/${seriesId}/Episodes`, { params: { userId: this.userId, Fields: ITEM_FIELDS } });
    return (r.Items || []).map(x => this.toItem(x));
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

  /* --- online subtitles (needs Jellyfin's Open Subtitles plugin) --- */

  async searchSubtitles(itemId, language) {
    const noProvider = new Error('Jellyfin needs its Open Subtitles plugin for this. In Jellyfin go to Dashboard → Plugins → Catalog, install "Open Subtitles", restart Jellyfin, then sign the plugin in to a free OpenSubtitles.com account');
    let results;
    try {
      results = await this.api(`/Items/${itemId}/RemoteSearch/Subtitles/${LANG3[language] || language}`, { timeout: 45000 });
    } catch {
      throw noProvider;
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
  async createUser(name, password) {
    const user = await this.api('/Users/New', { method: 'POST', json: { Name: name, Password: password || '' } });
    await this.updatePolicy(user.Id, { IsHidden: false, EnableAllFolders: true });
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

  // Shares one movie or show: tags it (a show's seasons and episodes too), then
  // creates a hidden guest account that can only see items with that tag.
  async createShare(itemId, { note = '', days = 0 } = {}) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tag = `dfshare-${id}`;
    const expires = days ? Date.now() + days * 86400000 : 0;
    const cleanNote = note.replace(/[^\w .'@+-]/g, '').trim().slice(0, 30);
    const name = `share-${id}-${expires ? expires.toString(36) : 'never'}${cleanNote ? ` ${cleanNote}` : ''}`;
    const password = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 28);

    const item = await this.api(`/Items/${itemId}`, { params: { userId: this.userId } });
    const targets = [itemId];
    if (item.Type === 'Series' || item.Type === 'Season') {
      const kids = await this.api('/Items', { params: { userId: this.userId, ParentId: itemId, Recursive: true, IncludeItemTypes: 'Season,Episode' } });
      targets.push(...(kids.Items || []).map(k => k.Id));
    }
    for (const target of targets) await this.setTag(target, tag, true);

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
    return { id, userId: user.Id, link: { s: this.uri, u: name, p: password, i: itemId, x: expires } };
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
