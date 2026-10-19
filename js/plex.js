import { CONFIG } from './config.js';
import { store, uuid } from './util.js';

const PLEX_TV = 'https://plex.tv';

export function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = uuid();
    store.set('clientId', id);
  }
  return id;
}

// Plex picks a transcoding profile from X-Plex-Platform, so report the real browser.
export function browser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Chrome';
}

export function identity() {
  return {
    'X-Plex-Product': CONFIG.appName,
    'X-Plex-Version': CONFIG.version,
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Platform': browser(),
    'X-Plex-Device': browser(),
    'X-Plex-Device-Name': `${CONFIG.appName} (${browser()})`,
  };
}

// plex.tv accepts X-Plex-* headers cross-origin. For the media server we pass
// everything as query params instead so requests stay CORS-simple (no preflight).
async function request(url, { method = 'GET', token, plexHeaders = false, timeout = 20000, json, raw = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (plexHeaders) Object.assign(headers, identity());
  if (token) headers['X-Plex-Token'] = token;
  const init = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw Object.assign(new Error(`Plex responded ${res.status} ${res.statusText}`.trim()), { status: res.status });
  }
  const text = await res.text();
  if (raw) return text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Some older plex.tv endpoints only answer in XML.
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');

/* ---------- plex.tv account ---------- */

export const auth = {
  createPin() {
    return request(`${PLEX_TV}/api/v2/pins?strong=true`, { method: 'POST', plexHeaders: true });
  },

  loginUrl(pin, forwardUrl) {
    const p = new URLSearchParams({
      clientID: clientId(),
      code: pin.code,
      forwardUrl,
      'context[device][product]': CONFIG.appName,
    });
    return `https://app.plex.tv/auth#?${p}`;
  },

  async checkPin(pin) {
    const r = await request(`${PLEX_TV}/api/v2/pins/${pin.id}?code=${encodeURIComponent(pin.code)}`, { plexHeaders: true });
    return r?.authToken || null;
  },

  user(token) {
    return request(`${PLEX_TV}/api/v2/user`, { token, plexHeaders: true });
  },

  // Plex Home: the people (profiles) under one account, each with their own watch history.
  async homeUsers(token) {
    const r = await request(`${PLEX_TV}/api/v2/home/users`, { token, plexHeaders: true });
    return r?.users ?? [];
  },

  // Returns a token for that profile. Protected profiles need their PIN.
  async switchUser(token, uuid, pin) {
    const q = pin ? `?pin=${encodeURIComponent(pin)}` : '';
    const r = await request(`${PLEX_TV}/api/v2/home/users/${uuid}/switch${q}`, { method: 'POST', token, plexHeaders: true });
    if (!r?.authToken) throw new Error('Plex did not return a token for that profile.');
    return r.authToken;
  },

  // Adds a managed Plex Home user (no email or password needed).
  async createProfile(token, title) {
    const text = await request(`${PLEX_TV}/api/home/users?title=${encodeURIComponent(title)}`, { method: 'POST', token, plexHeaders: true, raw: true });
    const user = parseXml(text).querySelector('user');
    if (!user?.getAttribute('uuid')) throw new Error('Plex did not create the profile.');
    return { id: user.getAttribute('id'), uuid: user.getAttribute('uuid'), title: user.getAttribute('title'), thumb: user.getAttribute('thumb') };
  },

  // Everyone this account has shared a server with (friends and Home profiles).
  async sharedUsers(token, serverId) {
    const text = await request(`${PLEX_TV}/api/servers/${serverId}/shared_servers`, { token, plexHeaders: true, raw: true });
    return [...parseXml(text).querySelectorAll('SharedServer')].map(s => ({
      shareId: s.getAttribute('id'),
      userId: s.getAttribute('userID'),
      username: s.getAttribute('username') || '',
      email: s.getAttribute('email') || '',
      accepted: s.getAttribute('accepted') !== '0',
      invitedAt: Number(s.getAttribute('invitedAt')) || 0,
      libraries: [...s.querySelectorAll('Section')].filter(x => x.getAttribute('shared') === '1').map(x => x.getAttribute('title')),
    }));
  },

  // Takes away someone's access to the server's libraries (they stay a Plex friend).
  removeShare(token, serverId, shareId) {
    return request(`${PLEX_TV}/api/servers/${serverId}/shared_servers/${shareId}`, { method: 'DELETE', token, plexHeaders: true, raw: true });
  },

  // Deletes a managed Plex Home profile entirely.
  deleteProfile(token, userId) {
    return request(`${PLEX_TV}/api/home/users/${userId}`, { method: 'DELETE', token, plexHeaders: true, raw: true });
  },

  // plex.tv's IDs for every library on a server (sharing uses these, not the server's own keys).
  async librarySectionIds(token, serverId) {
    const text = await request(`${PLEX_TV}/api/servers/${serverId}`, { token, plexHeaders: true, raw: true });
    return [...parseXml(text).querySelectorAll('Section')].map(s => Number(s.getAttribute('id')));
  },

  // Shares every library on a server with a user id, or with an email/username (which sends a Plex invite).
  async shareServer(token, serverId, recipient, sectionIds) {
    sectionIds ??= await this.librarySectionIds(token, serverId);
    if (!sectionIds.length) throw new Error('This server has no libraries to share.');
    await request(`${PLEX_TV}/api/servers/${serverId}/shared_servers`, {
      method: 'POST',
      token,
      plexHeaders: true,
      raw: true,
      json: { server_id: serverId, shared_server: { library_section_ids: sectionIds, ...recipient } },
    });
  },

  // Gives a profile access to every library on each server this account owns.
  async shareLibraries(token, userId) {
    const owned = (await this.servers(token)).filter(s => s.owned);
    for (const server of owned) {
      const sectionIds = await this.librarySectionIds(token, server.clientIdentifier);
      if (sectionIds.length) await this.shareServer(token, server.clientIdentifier, { invited_id: Number(userId) }, sectionIds);
    }
  },

  // Owner side: invites sent that haven't been accepted yet.
  async sentInvites(token) {
    const text = await request(`${PLEX_TV}/api/invites/requested`, { token, plexHeaders: true, raw: true });
    return [...parseXml(text).querySelectorAll('Invite')]
      .filter(i => i.getAttribute('server') === '1')
      .map(i => ({
        id: i.getAttribute('id'),
        who: i.getAttribute('email') || i.getAttribute('username') || i.getAttribute('friendlyName') || i.getAttribute('id'),
        sentAt: Number(i.getAttribute('createdAt')) || 0,
      }));
  },

  cancelInvite(token, id) {
    return request(`${PLEX_TV}/api/invites/requested/${encodeURIComponent(id)}?friend=0&server=1&home=0`, { method: 'DELETE', token, plexHeaders: true, raw: true });
  },

  // Invitee side: server invites waiting for this account to accept.
  async receivedInvites(token) {
    const text = await request(`${PLEX_TV}/api/invites/requests`, { token, plexHeaders: true, raw: true });
    return [...parseXml(text).querySelectorAll('Invite')]
      .filter(i => i.getAttribute('server') === '1')
      .map(i => ({
        id: i.getAttribute('id'),
        from: i.getAttribute('friendlyName') || i.getAttribute('username') || i.getAttribute('email') || 'Someone',
        // Which servers the invite covers, when plex.tv says so.
        serverIds: [...i.querySelectorAll('[machineIdentifier]')].map(s => s.getAttribute('machineIdentifier')),
        serverNames: [...i.querySelectorAll('Server')].map(s => s.getAttribute('name')).filter(Boolean),
      }));
  },

  acceptInvite(token, id) {
    return request(`${PLEX_TV}/api/invites/requests/${encodeURIComponent(id)}?friend=0&server=1&home=0`, { method: 'PUT', token, plexHeaders: true, raw: true });
  },

  async servers(token) {
    const list = await request(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`, { token, plexHeaders: true });
    return (list || []).filter(r => (r.provides || '').split(',').includes('server'));
  },
};

// Race every advertised address for a server and return the first that answers.
// Direct connections win over Plex's (bandwidth-limited) relay.
export async function connect(resource) {
  const secureOnly = location.protocol === 'https:';
  const conns = (resource.connections || []).filter(c => !secureOnly || c.protocol === 'https');
  const probe = c => request(`${c.uri}/identity?X-Plex-Token=${encodeURIComponent(resource.accessToken)}`, { timeout: 6000 }).then(() => c.uri);
  for (const group of [conns.filter(c => !c.relay), conns.filter(c => c.relay)]) {
    if (!group.length) continue;
    try {
      return await Promise.any(group.map(probe));
    } catch {}
  }
  throw new Error(`Couldn't reach "${resource.name}". Make sure the server is running and Remote Access is enabled.`);
}

/* ---------- Plex Media Server ---------- */

const AUDIO = 2;
const SUBTITLE = 3;
const streamsOf = (part, type) => (part?.Stream || []).filter(s => s.streamType === type);

// Browsers can play H.264/AAC in MP4 natively — no server work needed — but only
// with the file's first audio track and no subtitles.
function canDirectPlay(item) {
  const media = item.Media?.[0];
  const part = media?.Part?.[0];
  if (!media || (media.Part?.length ?? 0) > 1) return false;
  if (streamsOf(part, SUBTITLE).some(s => s.selected)) return false;
  const audio = streamsOf(part, AUDIO);
  const chosen = audio.find(s => s.selected);
  if (audio.length > 1 && chosen && chosen !== audio[0]) return false;
  const container = (media.container || '').toLowerCase();
  const video = (media.videoCodec || '').toLowerCase();
  const audioCodec = (media.audioCodec || '').toLowerCase();
  return ['mp4', 'm4v', 'mov'].includes(container) && video === 'h264' && ['aac', 'mp3'].includes(audioCodec);
}

// The server's specific reason is in transcodeDecisionText; the general text is vague.
function unplayableReason(decision) {
  const detail = decision.transcodeDecisionText || decision.generalDecisionText || '';
  if (/DoVi \(Profile 5\)/i.test(detail)) {
    return 'This file uses Dolby Vision Profile 5, which has no regular HDR/SDR picture for the server to convert. '
      + 'Replace it with an HDR10 or SDR version of the movie. (With Plex Pass, the server\'s HDR tone mapping may be able to convert it.)';
  }
  return detail || "The server can't play this file.";
}

export class PlexServer {
  kind = 'plex';
  supports = { subtitleSize: true };

  constructor({ uri, token, name, id, owned }) {
    this.uri = uri.replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.id = id;
    this.owned = owned; // undefined when connected manually (unknown)
  }

  /* --- playback (the player only talks to these) --- */

  // Decides how to play an item: straight from the file, or through the transcoder as HLS.
  async playback(item, { quality, subSize, forceTranscode }) {
    const part = item.Media?.[0]?.Part?.[0];
    if (!quality.bitrate && !forceTranscode && canDirectPlay(item)) {
      return { mode: 'direct', url: this.url(part.key) };
    }
    const session = uuid();
    const params = {
      path: item.key,
      mediaIndex: 0,
      partIndex: 0,
      protocol: 'hls',
      fastSeek: 1,
      directPlay: 0,
      directStream: 1,
      directStreamAudio: 1,
      videoQuality: 100,
      // Subtitles are drawn into the video by the server, which handles every
      // format (text and image-based PGS/VobSub alike).
      subtitles: 'burn',
      subtitleSize: subSize,
      audioBoost: 100,
      hasMDE: 1,
      session,
      'X-Plex-Session-Identifier': session,
      ...identity(),
    };
    if (quality.bitrate) Object.assign(params, { maxVideoBitrate: quality.bitrate, videoResolution: quality.res });
    // The server must be asked how it will play the file before a stream can start.
    const decision = await this.get('/video/:/transcode/universal/decision', params);
    if (decision.generalDecisionCode >= 2000) throw new Error(unplayableReason(decision));
    return { mode: 'hls', url: this.url('/video/:/transcode/universal/start.m3u8', params), session };
  }

  stopPlayback(plan) {
    if (plan?.session) this.stopTranscode(plan.session).catch(() => {});
  }

  // Tells the server where we are, so "Continue Watching" and watched status stay in sync.
  reportPlayback(item, plan, playState, timeMs) {
    return this.timeline({
      ratingKey: item.ratingKey,
      key: item.key,
      state: playState,
      time: Math.round(timeMs),
      duration: item.duration,
      'X-Plex-Session-Identifier': plan?.session || '',
    });
  }

  // Segment and playlist URLs inside a stream come back without the token.
  authorizeUrl(url) {
    return url.includes('X-Plex-Token=') ? url : this.withToken(url);
  }

  url(path, params = {}) {
    const u = new URL(this.uri + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    u.searchParams.set('X-Plex-Token', this.token);
    return u.toString();
  }

  withToken(absoluteUrl) {
    const u = new URL(absoluteUrl);
    u.searchParams.set('X-Plex-Token', this.token);
    return u.toString();
  }

  image(path, width, height) {
    if (!path) return '';
    return this.url('/photo/:/transcode', { width, height, minSize: 1, upscale: 1, url: path });
  }

  async get(path, params = {}) {
    const data = await request(this.url(path, { ...identity(), ...params }));
    return data?.MediaContainer ?? {};
  }

  // Persists the chosen audio/subtitle track for this file on the server
  // (Plex's own apps work the same way). subtitleStreamID 0 turns subtitles off.
  selectStreams(partId, ids) {
    return this.send(`/library/parts/${partId}`, { ...ids, allParts: 1 }, 'PUT');
  }

  send(path, params = {}, method = 'GET') {
    return request(this.url(path, { ...identity(), ...params }), { method });
  }

  info() { return this.get('/'); }

  async sections() { return (await this.get('/library/sections')).Directory ?? []; }

  // Look for new/removed files in every library. Only the server owner may do this.
  scanAll() { return this.send('/library/sections/all/refresh'); }
  async isScanning() { return (await this.sections()).some(s => s.refreshing); }

  async items(sectionId, { sort, start = 0, size = 60 } = {}) {
    const mc = await this.get(`/library/sections/${sectionId}/all`, {
      sort,
      includeCollections: 0,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
    });
    return { items: mc.Metadata ?? [], total: mc.totalSize ?? mc.size ?? 0 };
  }

  async hubs() { return (await this.get('/hubs', { count: 20 })).Hub ?? []; }
  async sectionHubs(id) { return (await this.get(`/hubs/sections/${id}`, { count: 20 })).Hub ?? []; }
  async related(id) { return (await this.get(`/hubs/metadata/${id}/related`, { count: 20 })).Hub ?? []; }
  async onDeck() { return (await this.get('/library/onDeck')).Metadata ?? []; }
  async search(query) { return (await this.get('/hubs/search', { query, limit: 30 })).Hub ?? []; }

  async metadata(id) {
    const item = (await this.get(`/library/metadata/${id}`)).Metadata?.[0];
    if (!item) throw new Error('That title is no longer on the server.');
    return item;
  }

  async children(id) { return (await this.get(`/library/metadata/${id}/children`)).Metadata ?? []; }
  async allLeaves(id) { return (await this.get(`/library/metadata/${id}/allLeaves`)).Metadata ?? []; }

  // Online subtitle search through the server's OpenSubtitles integration.
  async searchSubtitles(ratingKey, language) {
    return (await this.get(`/library/metadata/${ratingKey}/subtitles`, { language, hearingImpaired: 0, forced: 0 })).Stream ?? [];
  }

  // The server downloads the chosen result and adds it to the file as a subtitle track.
  downloadSubtitle(ratingKey, result, language) {
    return this.send(`/library/metadata/${ratingKey}/subtitles`, {
      key: result.key,
      codec: result.codec,
      language,
      hearingImpaired: result.hearingImpaired ? 1 : 0,
      forced: result.forced ? 1 : 0,
      providerTitle: result.providerTitle,
    }, 'PUT');
  }

  // Owner-only: what's playing right now, and who finished what.
  async sessions() { return (await this.get('/status/sessions')).Metadata ?? []; }
  async history(accountID, size = 20) {
    return (await this.get('/status/sessions/history/all', {
      accountID,
      sort: 'viewedAt:desc',
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': size,
    })).Metadata ?? [];
  }

  scrobble(key) { return this.send('/:/scrobble', { identifier: 'com.plexapp.plugins.library', key }); }
  unscrobble(key) { return this.send('/:/unscrobble', { identifier: 'com.plexapp.plugins.library', key }); }
  timeline(params) { return this.send('/:/timeline', params); }
  stopTranscode(session) { return this.send('/video/:/transcode/universal/stop', { session }); }
}
