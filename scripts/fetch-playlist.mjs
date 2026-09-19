// scripts/fetch-playlist.mjs
//
// Pulls the most recent additions to a public Spotify playlist, converts
// each album cover to ASCII art, looks up a matching Apple Music link for
// every track, and writes the result to playlist.json.
//
// Runs in GitHub Actions (see update-playlist.yml) — never in the browser —
// because Spotify's CDN images can't be read pixel-by-pixel from client-side
// JS due to CORS.
//
// NO SPOTIFY CREDENTIALS NEEDED. The track list comes from the public embed
// page (https://open.spotify.com/embed/playlist/<id>) — the same page Spotify
// serves for its "Share > Embed" iframe. That's unofficial: Spotify can change
// the page at any time, and its developer terms are not friendly to scraping.
// If a run fails, see the "Embed page" section and the DEBUG_EMBED note below.
//
// What the embed page gives us:   track id, title, artists, duration.
// What it does NOT give us:       album name, release year, cover art, or the
//                                 date a track was added. So:
//   - cover art  -> Spotify's public oEmbed endpoint (exact cover), falling
//                   back to the iTunes artwork for the matched song
//   - album/year -> the iTunes Search API match (blank if no confident match)
//   - "added"    -> the first time THIS script saw the track, remembered in
//                   playlist.json under `seen` (see "First-seen dates")
//
// The widget shows the first TRACK_LIMIT (20) tracks in the playlist's own
// order, plus a "listen to more" link that opens the playlist's first track
// in Spotify (with the playlist as its context, so it plays on down the list).
//
// Covers, albums and Apple Music links are looked up once per track and then
// reused from the previous playlist.json, so a normal run makes almost no
// iTunes/oEmbed calls. (Apple asks for ~20 iTunes calls a minute at most.)
// Anything that failed or fell back to a search link is retried next run, and
// covers drawn with older ASCII settings are re-rendered (cover download only).
//
// Optional env vars:
//   SPOTIFY_PLAYLIST_ID     override the playlist
//   APPLE_MUSIC_PLAYLIST_URL  link for the widget's Apple Music chip
//   SPOTIFY_TRACK_ORDER     "playlist" (default): the FIRST TRACK_LIMIT tracks
//                           in playlist order. "reverse": the LAST TRACK_LIMIT
//                           tracks, last one first — since Spotify appends new
//                           songs to the bottom, that's "newest first".
//   REFRESH_ALL=1           ignore the cache and re-look-up every track.
//                           (Not needed after changing the ASCII settings: each
//                           track remembers which settings drew its art, and
//                           stale art is re-rendered automatically.)
//   ITUNES_GAP_MS           pause between iTunes lookups (default 3100)
//   DEBUG_EMBED=1           also write embed-debug.json (the raw embed data),
//                           handy for seeing what changed if parsing breaks

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// "This Is: Owen Lantz"
const PLAYLIST_ID = process.env.SPOTIFY_PLAYLIST_ID || "2OHqnM8dMtMsEdGEqrbRTe";

// Optional: if you make a mirrored playlist on Apple Music, put its URL in
// the APPLE_MUSIC_PLAYLIST_URL secret/env and the widget header will link to
// it. Left empty, the header falls back to an Apple Music search.
const APPLE_PLAYLIST_URL =
  process.env.APPLE_MUSIC_PLAYLIST_URL ||
  "https://music.apple.com/us/playlist/this-is-owen-lantz/pl.u-BNA6z9jsRNM0DJ1";

const TRACK_ORDER = (process.env.SPOTIFY_TRACK_ORDER || "playlist").toLowerCase();

const TRACK_LIMIT = 20;     // how many tracks to render
const APPLE_STOREFRONT = "us";

// Apple documents the iTunes Search API at "approximately 20 calls per minute"
// (per IP, and GitHub's runners share IPs), so uncached lookups are spaced out.
const ITUNES_GAP_MS = process.env.ITUNES_GAP_MS ? Number(process.env.ITUNES_GAP_MS) : 3100;

// Embed pages appear to cap how many tracks they list (reports say 50 or 100).
// That only matters in "reverse" order, where we want the END of the playlist:
// if we get exactly one of these back we warn, because a longer playlist would
// be cut off and the "newest" songs would be missing.
const KNOWN_EMBED_CAPS = [50, 100];

const EMBED_URL = `https://open.spotify.com/embed/playlist/${PLAYLIST_ID}`;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function fetchWithTimeout(url, options = {}, ms = 20000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// ---------------------------------------------------------------------------
// Embed page
// ---------------------------------------------------------------------------

// The embed page is a Next.js app; the playlist data is inlined as JSON in a
// <script id="__NEXT_DATA__"> tag. We don't rely on the exact path to the data
// (it has moved before) — we just search the JSON for the object that owns a
// `trackList` array.

async function fetchEmbedData() {
  const res = await fetchWithTimeout(EMBED_URL, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    throw new Error(`Embed page returned HTTP ${res.status} (${EMBED_URL})`);
  }
  const html = await res.text();
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(
      "Embed page loaded but has no __NEXT_DATA__ block. Spotify may have " +
        "changed the page, or served a bot check to this IP."
    );
  }
  return JSON.parse(match[1]);
}

function findEntity(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node.trackList)) return node;
  for (const value of Object.values(node)) {
    const found = findEntity(value);
    if (found) return found;
  }
  return null;
}

// Spotify pads multi-artist strings with non-breaking spaces.
const clean = (s) => String(s ?? "").replace(/\u00a0/g, " ").trim();

function parseEmbed(nextData) {
  const entity = findEntity(nextData);
  if (!entity) {
    throw new Error(
      "Could not find a trackList in the embed data. Re-run with DEBUG_EMBED=1 " +
        "and look at embed-debug.json to see what Spotify is serving now."
    );
  }

  const tracks = entity.trackList
    .map((t) => {
      const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(t?.uri || "")?.[1];
      if (!id) return null; // episodes, local files, etc.

      // Durations are milliseconds; if a value looks like seconds, convert.
      const raw = Number(t.duration) || 0;
      return {
        id,
        name: clean(t.title) || "untitled",
        artist: clean(t.subtitle) || "Unknown artist",
        durationMs: raw > 0 && raw < 10000 ? raw * 1000 : raw,
      };
    })
    .filter(Boolean);

  if (tracks.length === 0) {
    throw new Error("The embed's trackList was empty or had no playable tracks.");
  }

  return {
    playlist: {
      name: clean(entity.name || entity.title),
      description: clean(entity.description),
      owner: clean(entity.subtitle),
    },
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------

// Spotify's public oEmbed endpoint returns a thumbnail of the track's cover.
async function findSpotifyCover(trackId) {
  try {
    const url =
      "https://open.spotify.com/oembed?url=" +
      encodeURIComponent(`https://open.spotify.com/track/${trackId}`);
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { thumbnail_url } = await res.json();
    return thumbnail_url || null;
  } catch (err) {
    console.warn(`Spotify cover lookup failed for ${trackId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apple Music
// ---------------------------------------------------------------------------

// The public iTunes Search API needs no key and returns Apple Music URLs.
// We match on artist + title. A "strict" match (both agree) is trusted for
// album/year/artwork too; a "loose" match (title only) is only used for the
// link, as before. If nothing comes back we fall back to a prefilled Apple
// Music search so the link is never dead.
const norm = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const overlaps = (a, b) => Boolean(a && b && (a.includes(b) || b.includes(a)));

let lastItunesCall = 0;
async function throttleItunes() {
  const wait = lastItunesCall + ITUNES_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastItunesCall = Date.now();
}

async function findAppleMusic(trackName, artistName) {
  const term = `${artistName} ${trackName}`;
  const searchUrl = `https://music.apple.com/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(term)}`;
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=song&limit=5&country=${APPLE_STOREFRONT}`;

  await throttleItunes();
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { results = [] } = await res.json();

    const wantTrack = norm(trackName);
    const wantArtist = norm(artistName);

    const strict = results.find(
      (r) => overlaps(norm(r.trackName), wantTrack) && overlaps(norm(r.artistName), wantArtist)
    );
    const hit = strict || results.find((r) => overlaps(norm(r.trackName), wantTrack));

    if (hit?.trackViewUrl) {
      // Strip iTunes affiliate/campaign noise, keep the clean Apple Music link.
      return { url: hit.trackViewUrl.split("?")[0], match: strict || null };
    }
  } catch (err) {
    console.warn(`Apple Music lookup failed for "${trackName}": ${err.message}`);
  }

  return { url: searchUrl, match: null };
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

// Geometry. These three numbers describe how the widget draws a character
// cell, and the art is only proportioned correctly when they match the CSS
// for `.apf-art-well pre` in index.html:
//   - ART_WIDTH   : characters per row. index.html sizes the font so this many
//                   columns exactly fill the widget (see the font-size calc()
//                   there, which divides by ART_WIDTH * CELL_ADVANCE).
//   - CELL_ADVANCE: character width in em (0.6 for IBM Plex Mono and Courier).
//   - LINE_HEIGHT : CSS line-height in em. Also keeps solid blocks seamless.
// Covers are square, so with a 0.6 x 1.1 cell the art needs ~0.545 rows per
// column. (The previous version assumed cells were exactly twice as tall as
// wide, but the CSS drew them ~1.7x, which squashed every cover by ~14%.)
const ART_WIDTH = 88;
const CELL_ADVANCE = 0.6;
const LINE_HEIGHT = 1.1;
const CELL_ASPECT = CELL_ADVANCE / LINE_HEIGHT; // width / height of one character

// Palette. Every glyph is described by how much of each quadrant it fills:
// [top-left, top-right, bottom-left, bottom-right], 0 = empty, 1 = solid.
// The five shade characters are the same ones the header portrait uses. The
// four half blocks add real *shape* to the palette: at a hard edge (a letter,
// a horizon, the rim of a circle) a cell can be "top half lit" instead of
// having to pick a shade that's wrong on both sides. They live in the same
// Unicode block as the shades, so they render in the same font.
const GLYPHS = [
  { ch: " ", q: [0, 0, 0, 0] },
  { ch: "░", q: [0.25, 0.25, 0.25, 0.25] },
  { ch: "▒", q: [0.5, 0.5, 0.5, 0.5] },
  { ch: "▓", q: [0.75, 0.75, 0.75, 0.75] },
  { ch: "█", q: [1, 1, 1, 1] },
  { ch: "▀", q: [1, 1, 0, 0] },
  { ch: "▄", q: [0, 0, 1, 1] },
  { ch: "▌", q: [1, 0, 1, 0] },
  { ch: "▐", q: [0, 1, 0, 1] },
];

// Tone. Album covers are wildly different (a blown-out photo, a near-black
// moody one, a flat graphic), so each image is levelled on its own.
const LEVELS_LOW = 0.03;   // darkest 3% of pixels -> black
const LEVELS_HIGH = 0.99;  // brightest 1% -> white
const GAMMA = 1.35;        // >1 darkens midtones: shade blocks glow on black, so
                           // this keeps dark backgrounds clean and subjects popping
const CLARITY = 0.45;      // wide-radius local contrast (separates subject from ground)
const SHARPEN = 0.9;       // fine-radius unsharp mask (edges, lettering)
const FLAT_TOLERANCE = 0.07; // brightness error smaller than this is ignored rather than
                           // diffused. Flat areas then stay one calm tone instead of
                           // dithering into a checkerboard, while real gradients (whose
                           // error is larger) still dither smoothly. 0 = plain Floyd-Steinberg.

// Bumped automatically whenever any setting above changes. It's saved with each
// track so main() knows which cached covers were drawn with older settings and
// need re-rendering.
const ART_SPEC = [
  "v2", ART_WIDTH, CELL_ASPECT.toFixed(3), GLYPHS.map((g) => g.ch).join(""),
  LEVELS_LOW, LEVELS_HIGH, GAMMA, CLARITY, SHARPEN, FLAT_TOLERANCE,
].join("|");

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Separable Gaussian blur on a float image (edges clamp).
function gaussianBlur(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += src[y * w + Math.min(w - 1, Math.max(0, x + k))] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// Grayscale bytes -> tone-mapped floats in 0..1: per-image levels, then local
// contrast, then gamma.
function toneMap(gray, w, h) {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const percentile = (p) => {
    const target = p * gray.length;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  let lo = percentile(LEVELS_LOW);
  let hi = percentile(LEVELS_HIGH);
  if (hi - lo < 0.08) {
    // A nearly flat image (an all-black or all-white cover, say): stretching
    // would only blow sensor noise up to full contrast, and would drag a black
    // cover to mid-grey. Keep its real brightness instead.
    lo = 0;
    hi = 1;
  }

  const f = new Float32Array(gray.length);
  for (let i = 0; i < f.length; i++) f[i] = clamp01((gray[i] / 255 - lo) / (hi - lo));

  const wide = gaussianBlur(f, w, h, w / 14);
  const fine = gaussianBlur(f, w, h, 1.1);
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i] + CLARITY * (f[i] - wide[i]) + SHARPEN * (f[i] - fine[i]);
    out[i] = Math.pow(clamp01(v), GAMMA);
  }
  return out;
}

// Turns a tone-mapped image (2 samples per character across, 2 down) into text.
//
// For each character cell we look at its four samples and pick the glyph whose
// quadrants best match them, so lettering and edges keep their shape instead of
// being averaged into a shade. The leftover *brightness* error (how much
// lighter or darker the chosen glyph is than the cell wanted) is then diffused
// into neighbouring cells, Floyd-Steinberg style (minus a small dead zone, see
// FLAT_TOLERANCE), so gradients still read as smooth shading. The scan direction alternates every row (serpentine) to avoid
// the diagonal "worm" streaks a one-way scan leaves in flat areas.
function cellsToText(f, cols, rows) {
  const hw = cols * 2;
  const carry = new Float32Array(cols * rows);
  const lines = [];

  for (let y = 0; y < rows; y++) {
    const dir = y % 2 === 0 ? 1 : -1;
    const row = new Array(cols);

    for (let n = 0; n < cols; n++) {
      const x = dir === 1 ? n : cols - 1 - n;
      const c = carry[y * cols + x];
      const i = y * 2 * hw + x * 2;
      const t = [
        clamp01(f[i] + c),
        clamp01(f[i + 1] + c),
        clamp01(f[i + hw] + c),
        clamp01(f[i + hw + 1] + c),
      ];

      let best = GLYPHS[0];
      let bestCost = Infinity;
      for (const g of GLYPHS) {
        let cost = 0;
        for (let k = 0; k < 4; k++) cost += (t[k] - g.q[k]) ** 2;
        if (cost < bestCost) {
          bestCost = cost;
          best = g;
        }
      }
      row[x] = best.ch;

      const want = (t[0] + t[1] + t[2] + t[3]) / 4;
      const got = (best.q[0] + best.q[1] + best.q[2] + best.q[3]) / 4;
      const miss = want - got;
      const err = Math.sign(miss) * Math.max(0, Math.abs(miss) - FLAT_TOLERANCE);
      const at = y * cols + x;
      const ahead = x + dir;
      const behind = x - dir;
      if (ahead >= 0 && ahead < cols) carry[at + dir] += err * (7 / 16);
      if (y + 1 < rows) {
        if (behind >= 0 && behind < cols) carry[at + cols - dir] += err * (3 / 16);
        carry[at + cols] += err * (5 / 16);
        if (ahead >= 0 && ahead < cols) carry[at + cols + dir] += err * (1 / 16);
      }
    }
    lines.push(row.join(""));
  }
  return lines.join("\n");
}

// Image bytes -> ASCII. Exported so the converter can be tested on its own.
export async function coverToAscii(buffer) {
  const meta = await sharp(buffer).metadata();
  const rows = Math.max(1, Math.round((meta.height / meta.width) * ART_WIDTH * CELL_ASPECT));

  // Sample at 2x the character grid; cellsToText uses the extra resolution to
  // pick shape-aware glyphs.
  const { data, info } = await sharp(buffer)
    .flatten({ background: "#000" }) // transparent PNG covers: treat as black
    .resize(ART_WIDTH * 2, rows * 2, { fit: "fill", kernel: "lanczos3" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tone = toneMap(data, info.width, info.height);
  return cellsToText(tone, ART_WIDTH, rows);
}

async function imageToAscii(imageUrl) {
  const res = await fetchWithTimeout(imageUrl);
  if (!res.ok) throw new Error(`Could not download cover: ${res.status}`);
  return coverToAscii(Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// First-seen dates
// ---------------------------------------------------------------------------

// The embed page doesn't say when a track was added, so we remember when this
// script first saw each track. playlist.json carries a `seen` map
// ({ trackId: ISO date | null }) for every track in the playlist.
//
// The first run has no history, so every existing track is recorded as `null`
// (unknown — the widget just hides the "3d" label) rather than pretending they
// were all added today. Anything that shows up after that gets a real date.
// If an older playlist.json (from the Spotify-API version) is present, its
// real `addedAt` values are carried over.

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile("playlist.json", "utf8"));
  } catch {
    return null;
  }
}

function buildSeenMap(allTracks, previous, nowIso) {
  let prevSeen = previous?.seen;
  let isBaseline = false;

  if (!prevSeen) {
    isBaseline = true;
    prevSeen = Object.fromEntries(
      (previous?.tracks || []).map((t) => [t.id, t.addedAt ?? null])
    );
  }

  const seen = {};
  for (const t of allTracks) {
    seen[t.id] = t.id in prevSeen ? prevSeen[t.id] : isBaseline ? null : nowIso;
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const hours = Math.round((Date.now() - new Date(timestamp).getTime()) / 36e5);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

function duration(ms) {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const hiRes = (url) => url?.replace(/\/\d+x\d+bb\./, "/400x400bb.");
const stripAlbumSuffix = (s) => String(s || "").replace(/ - (Single|EP)$/i, "");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Album / year / Apple link / cover art for one track. This is the slow part
// (three network calls), so main() reuses the previous result when it can.
async function lookUpExtras(t) {
  const firstArtist = t.artist.split(",")[0].trim();

  const [apple, spotifyCover] = await Promise.all([
    findAppleMusic(t.name, firstArtist),
    findSpotifyCover(t.id),
  ]);

  // Prefer Spotify's own cover; fall back to iTunes artwork for a confident match.
  const coverUrl = spotifyCover || hiRes(apple.match?.artworkUrl100) || null;
  let art = "";
  if (coverUrl) {
    try {
      art = await imageToAscii(coverUrl);
    } catch (err) {
      console.warn(`No art for "${t.name}": ${err.message}`);
    }
  }

  return {
    album: stripAlbumSuffix(apple.match?.collectionName),
    year: (apple.match?.releaseDate || "").slice(0, 4),
    appleMusicUrl: apple.url,
    art,
    artSpec: art ? ART_SPEC : null,
  };
}

// Re-draws just the cover (one Spotify oEmbed call plus the image download) for
// a track whose other details are already cached. If that fails we keep the old
// art rather than losing it, and it'll be tried again next run.
async function refreshArt(t, cached) {
  const coverUrl = await findSpotifyCover(t.id);
  if (coverUrl) {
    try {
      return { art: await imageToAscii(coverUrl), artSpec: ART_SPEC };
    } catch (err) {
      console.warn(`Could not redraw art for "${t.name}": ${err.message}`);
    }
  }
  return { art: cached.art, artSpec: cached.artSpec ?? null };
}

async function main() {
  const [nextData, previous] = await Promise.all([fetchEmbedData(), readPrevious()]);

  if (process.env.DEBUG_EMBED) {
    await fs.writeFile("embed-debug.json", JSON.stringify(nextData, null, 2));
    console.log("Wrote embed-debug.json");
  }

  const { playlist, tracks: allTracks } = parseEmbed(nextData);

  if (TRACK_ORDER === "reverse" && KNOWN_EMBED_CAPS.includes(allTracks.length)) {
    console.warn(
      `The embed returned exactly ${allTracks.length} tracks, which may be its cap. ` +
        `If the playlist is longer, the newest songs could be missing.`
    );
  }

  const nowIso = new Date().toISOString();
  const seen = buildSeenMap(allTracks, previous, nowIso);

  const ordered = TRACK_ORDER === "reverse" ? [...allTracks].reverse() : allTracks;

  // Reuse what we looked up for a track on a previous run, unless that result
  // is incomplete (no art, or only a search-link fallback) — those are retried.
  const cache = new Map((previous?.tracks || []).map((t) => [t.id, t]));
  const isComplete = (p) =>
    Boolean(p?.art && p.appleMusicUrl && !p.appleMusicUrl.includes("/search?term="));

  const tracks = [];
  for (const t of ordered.slice(0, TRACK_LIMIT)) {
    const cached = process.env.REFRESH_ALL ? null : cache.get(t.id);
    let extras;
    if (isComplete(cached)) {
      extras = {
        album: cached.album || "",
        year: cached.year || "",
        appleMusicUrl: cached.appleMusicUrl,
        art: cached.art,
        artSpec: cached.artSpec ?? null,
      };
      if (extras.artSpec !== ART_SPEC) Object.assign(extras, await refreshArt(t, cached));
    } else {
      extras = await lookUpExtras(t);
      // A transient cover failure shouldn't blank art we already had.
      if (!extras.art && cached?.art) {
        extras.art = cached.art;
        extras.artSpec = cached.artSpec ?? null;
      }
    }

    tracks.push({
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: extras.album,
      year: extras.year,
      duration: duration(t.durationMs),
      addedAt: seen[t.id] ?? null,
      timeAgo: timeAgo(seen[t.id]),
      spotifyUrl: `https://open.spotify.com/track/${t.id}`,
      appleMusicUrl: extras.appleMusicUrl,
      art: extras.art,
      artSpec: extras.artSpec, // bookkeeping: which ASCII settings drew `art`; the widget ignores it
    });
  }

  // "Click here to listen to more": the playlist's FIRST track, opened with the
  // playlist as its context so Spotify plays on down the list in order. Spotify
  // decides whether a link autoplays (see the note in the widget) — of all link
  // types, track links are the ones it will start playing.
  const playFirstUrl =
    `https://open.spotify.com/track/${allTracks[0].id}` +
    `?context=${encodeURIComponent(`spotify:playlist:${PLAYLIST_ID}`)}`;

  const feed = {
    generatedAt: nowIso,
    profile: { username: "jamesowenlantz" },
    playlist: {
      name: playlist.name,
      description: playlist.description,
      owner: playlist.owner,
      total: allTracks.length,
      spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      playFirstUrl,
      appleMusicUrl:
        APPLE_PLAYLIST_URL ||
        `https://music.apple.com/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(playlist.name || "")}`,
    },
    tracks,
    seen, // bookkeeping for "added" times; the widget ignores it
  };

  await fs.writeFile("playlist.json", JSON.stringify(feed, null, 2));
  console.log(`Wrote playlist.json with ${tracks.length} track(s).`);
}

// Only run when executed directly (node fetch-playlist.mjs), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
