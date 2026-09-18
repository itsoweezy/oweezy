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
// Optional env vars:
//   SPOTIFY_PLAYLIST_ID     override the playlist
//   APPLE_MUSIC_PLAYLIST_URL  link for the widget's Apple Music chip
//   SPOTIFY_TRACK_ORDER     "newest-last" (default; Spotify appends new songs
//                           to the bottom) or "newest-first"
//   DEBUG_EMBED=1           also write embed-debug.json (the raw embed data),
//                           handy for seeing what changed if parsing breaks

import fs from "node:fs/promises";
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

const TRACK_ORDER = (process.env.SPOTIFY_TRACK_ORDER || "newest-last").toLowerCase();

const TRACK_LIMIT = 8;      // how many recent additions to render
const ART_WIDTH = 44;       // characters wide
const CHAR_ASPECT = 0.5;    // monospace chars are ~2x taller than wide
const APPLE_STOREFRONT = "us";

// Embed pages appear to cap how many tracks they list (reports say 50 or 100).
// If we get exactly one of these back we warn, because a playlist longer than
// the cap would make "newest-last" show the wrong songs.
const KNOWN_EMBED_CAPS = [50, 100];

// Brightness -> character, light to dense. Dark source pixels map to
// space (fade into the black background); bright pixels map to the
// densest character. Flip the string to invert.
const ASCII_RAMP = " .:-=+*#%@";

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

async function findAppleMusic(trackName, artistName) {
  const term = `${artistName} ${trackName}`;
  const searchUrl = `https://music.apple.com/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(term)}`;
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=song&limit=5&country=${APPLE_STOREFRONT}`;

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

async function imageToAscii(imageUrl) {
  const res = await fetchWithTimeout(imageUrl);
  if (!res.ok) throw new Error(`Could not download cover: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(buffer).metadata();
  const height = Math.max(
    1,
    Math.round((meta.height / meta.width) * ART_WIDTH * CHAR_ASPECT)
  );

  const { data, info } = await sharp(buffer)
    .resize(ART_WIDTH, height, { fit: "fill" })
    .grayscale()
    .normalise() // album covers are often low-contrast; this keeps the ramp readable
    .raw()
    .toBuffer({ resolveWithObject: true });

  let art = "";
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const brightness = data[y * info.width + x] / 255;
      art += ASCII_RAMP[Math.round(brightness * (ASCII_RAMP.length - 1))];
    }
    art += "\n";
  }
  return art.trimEnd();
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

async function main() {
  const [nextData, previous] = await Promise.all([fetchEmbedData(), readPrevious()]);

  if (process.env.DEBUG_EMBED) {
    await fs.writeFile("embed-debug.json", JSON.stringify(nextData, null, 2));
    console.log("Wrote embed-debug.json");
  }

  const { playlist, tracks: allTracks } = parseEmbed(nextData);

  if (KNOWN_EMBED_CAPS.includes(allTracks.length)) {
    console.warn(
      `The embed returned exactly ${allTracks.length} tracks, which may be its cap. ` +
        `If the playlist is longer, "recent additions" could be wrong.`
    );
  }

  const nowIso = new Date().toISOString();
  const seen = buildSeenMap(allTracks, previous, nowIso);

  const ordered = TRACK_ORDER === "newest-first" ? allTracks : [...allTracks].reverse();

  const tracks = [];
  for (const t of ordered.slice(0, TRACK_LIMIT)) {
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

    tracks.push({
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: stripAlbumSuffix(apple.match?.collectionName),
      year: (apple.match?.releaseDate || "").slice(0, 4),
      duration: duration(t.durationMs),
      addedAt: seen[t.id] ?? null,
      timeAgo: timeAgo(seen[t.id]),
      spotifyUrl: `https://open.spotify.com/track/${t.id}`,
      appleMusicUrl: apple.url,
      art,
    });
  }

  const feed = {
    generatedAt: nowIso,
    profile: { username: "jamesowenlantz" },
    playlist: {
      name: playlist.name,
      description: playlist.description,
      owner: playlist.owner,
      total: allTracks.length,
      spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
