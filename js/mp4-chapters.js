// Reads the chapter marks inside an .m4b / .m4a / .mp4 file. Jellyfin doesn't read
// audiobook chapters itself, so DingFlix fetches the few small pieces of the file that
// hold them (HTTP range requests), never the whole file.
//
// Two places chapters live in these files:
//  - a Nero "chpl" list (moov/udta/chpl): start times and titles in one small box;
//  - a QuickTime chapter track: a text track the audio track points to (tref/chap),
//    whose samples are the titles and whose timing is the chapter starts.

const BLOCK = 64 * 1024;
const MAX_CHAPTERS = 3000;

function reader(url, signal) {
  const blocks = new Map();

  // Exactly these bytes (or fewer at the end of the file).
  async function raw(start, length) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal });
    if (res.status === 416) return new Uint8Array(0);
    if (res.status !== 206) {
      // The server sent the whole file instead of a piece: stop before it downloads.
      try { await res.body?.cancel(); } catch {}
      throw new Error('The server doesn’t send parts of files.');
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  // Small reads (box headers) share 64 KB blocks, so walking the file takes few requests.
  const block = i => {
    if (!blocks.has(i)) blocks.set(i, raw(i * BLOCK, BLOCK));
    return blocks.get(i);
  };
  async function bytes(start, length) {
    const out = new Uint8Array(length);
    let got = 0;
    for (let i = Math.floor(start / BLOCK); got < length; i++) {
      const b = await block(i);
      const from = start + got - i * BLOCK;
      if (from >= b.length) break;
      const n = Math.min(b.length - from, length - got);
      out.set(b.subarray(from, from + n), got);
      got += n;
      if (b.length < BLOCK) break;
    }
    return out.subarray(0, got);
  }
  return { raw, bytes };
}

const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const fourcc = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

// The boxes between `start` and `end` (end may be Infinity: to the end of the file).
async function boxes(r, start, end) {
  const out = [];
  let pos = start;
  while (pos < end && out.length < 500) {
    const h = await r.bytes(pos, 16);
    if (h.length < 8) break;
    const v = view(h);
    let size = v.getUint32(0);
    let head = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(v.getBigUint64(8));
      head = 16;
    } else if (size === 0) size = Infinity;
    if (size < head) break;
    out.push({ type: fourcc(h, 4), start: pos, body: pos + head, end: pos + size });
    if (size === Infinity) break;
    pos += size;
  }
  return out;
}

const child = (list, type) => list.find(b => b.type === type);
const body = (r, box, max = 4 * 1024 * 1024) => r.bytes(box.body, Math.min(box.end - box.body, max));

// Nero chapter list: version, flags, (4 more bytes in version 1), count, then for each:
// start (100 ns units, 64-bit), title length (1 byte), title.
function parseChpl(u8) {
  const v = view(u8);
  let at = 4 + (u8[0] ? 4 : 0);
  const count = u8[at++];
  const list = [];
  for (let i = 0; i < count && at + 9 <= u8.length; i++) {
    const start = Number(v.getBigUint64(at)) / 10000;
    const len = u8[at + 8];
    const name = new TextDecoder().decode(u8.subarray(at + 9, at + 9 + len));
    list.push({ name, start });
    at += 9 + len;
  }
  return list;
}

async function trackInfo(r, trak) {
  const kids = await boxes(r, trak.body, trak.end);
  const info = { id: 0, chap: [], timescale: 0, handler: '', minf: null };
  const tkhd = child(kids, 'tkhd');
  if (tkhd) {
    const u8 = await body(r, tkhd, 64);
    info.id = view(u8).getUint32(u8[0] === 1 ? 20 : 12);
  }
  const tref = child(kids, 'tref');
  if (tref) {
    for (const ref of await boxes(r, tref.body, tref.end)) {
      if (ref.type !== 'chap') continue;
      const u8 = await body(r, ref, 4096);
      for (let at = 0; at + 4 <= u8.length; at += 4) info.chap.push(view(u8).getUint32(at));
    }
  }
  const mdia = child(kids, 'mdia');
  if (mdia) {
    const m = await boxes(r, mdia.body, mdia.end);
    const mdhd = child(m, 'mdhd');
    if (mdhd) {
      const u8 = await body(r, mdhd, 64);
      info.timescale = view(u8).getUint32(u8[0] === 1 ? 20 : 12);
    }
    const hdlr = child(m, 'hdlr');
    if (hdlr) info.handler = fourcc(await body(r, hdlr, 64), 8);
    info.minf = child(m, 'minf') || null;
  }
  return info;
}

// The chapter titles and start times from a QuickTime chapter (text) track.
async function textTrackChapters(r, track) {
  const stbl = child(await boxes(r, track.minf.body, track.minf.end), 'stbl');
  if (!stbl || !track.timescale) return [];
  const kids = await boxes(r, stbl.body, stbl.end);
  const get = async type => (child(kids, type) ? body(r, child(kids, type)) : null);
  const [stts, stsc, stsz, stco, co64] = await Promise.all(['stts', 'stsc', 'stsz', 'stco', 'co64'].map(get));
  if (!stts || !stsc || !stsz || !(stco || co64)) return [];

  // Start time of each sample.
  const starts = [];
  {
    const v = view(stts);
    let t = 0;
    for (let i = 0, n = v.getUint32(4); i < n; i++) {
      const count = v.getUint32(8 + i * 8);
      const delta = v.getUint32(12 + i * 8);
      for (let k = 0; k < count && starts.length < MAX_CHAPTERS; k++, t += delta) starts.push(t);
    }
  }
  // Size of each sample.
  const sizes = [];
  {
    const v = view(stsz);
    const fixed = v.getUint32(4);
    const n = Math.min(v.getUint32(8), MAX_CHAPTERS);
    for (let i = 0; i < n; i++) sizes.push(fixed || v.getUint32(12 + i * 4));
  }
  // Where each chunk starts in the file, and how many samples each chunk holds.
  const chunks = [];
  {
    const v = view(stco || co64);
    for (let i = 0, n = v.getUint32(4); i < n; i++) chunks.push(stco ? v.getUint32(8 + i * 4) : Number(v.getBigUint64(8 + i * 8)));
  }
  const runs = [];
  {
    const v = view(stsc);
    for (let i = 0, n = v.getUint32(4); i < n; i++) runs.push({ first: v.getUint32(8 + i * 12), per: v.getUint32(12 + i * 12) });
  }
  const offsets = [];
  for (let c = 0; c < chunks.length && offsets.length < sizes.length; c++) {
    const run = [...runs].reverse().find(x => x.first <= c + 1);
    let at = chunks[c];
    for (let k = 0; k < (run?.per || 1) && offsets.length < sizes.length; k++) {
      offsets.push(at);
      at += sizes[offsets.length - 1];
    }
  }

  // Each sample is a 2-byte length and the title (UTF-8, or UTF-16 with a byte-order mark).
  const titles = new Array(offsets.length).fill('');
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = next++;
      const u8 = await r.raw(offsets[i], Math.min(sizes[i], 1024));
      if (u8.length < 2) continue;
      const len = Math.min(view(u8).getUint16(0), u8.length - 2);
      const text = u8.subarray(2, 2 + len);
      titles[i] = (text[0] === 0xfe && text[1] === 0xff
        ? new TextDecoder('utf-16be').decode(text.subarray(2))
        : new TextDecoder().decode(text)).trim();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return offsets.map((_, i) => ({ name: titles[i], start: (starts[i] || 0) / track.timescale * 1000 }));
}

export async function mp4Chapters(url, { signal } = {}) {
  const r = reader(url, signal);
  const moov = child(await boxes(r, 0, Infinity), 'moov');
  if (!moov) return [];
  const kids = await boxes(r, moov.body, moov.end);

  // The quick one first.
  const udta = child(kids, 'udta');
  if (udta) {
    const chpl = child(await boxes(r, udta.body, udta.end), 'chpl');
    if (chpl) {
      const list = parseChpl(await body(r, chpl, 1024 * 1024));
      if (list.length > 1) return list;
    }
  }

  const tracks = await Promise.all(kids.filter(b => b.type === 'trak').map(t => trackInfo(r, t)));
  const wanted = new Set(tracks.flatMap(t => t.chap));
  const chapterTrack = tracks.find(t => wanted.has(t.id) && t.minf)
    || tracks.find(t => (t.handler === 'text' || t.handler === 'sbtl') && t.minf && !tracks.some(o => o.chap.length && !o.chap.includes(t.id)));
  if (!chapterTrack) return [];
  return textTrackChapters(r, chapterTrack);
}
