// scripts/fetch-playlist.mjs
//
// Pulls the most recent additions to a public Spotify playlist, converts
// each album cover to ASCII art, looks up a matching Apple Music link for
// every track, and writes the result to playlist.json.
//
// Runs in GitHub Actions (see update-playlist.yml) — never in the browser —
// because (a) the client secret is a secret and (b) Spotify's CDN images
// can't be read pixel-by-pixel from client-side JS due to CORS.
//
// Requires: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment
// variables (see SETUP.md). No user login, no token refresh dance — the
// client-credentials flow reads public playlists and the token it returns
// is fetched fresh on every run.

import fs from "node:fs/promises";
import sharp from "sharp";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing SPOTIFY_CLIENT_ID and/or SPOTIFY_CLIENT_SECRET.");
  process.exit(1);
}

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

const TRACK_LIMIT = 8;      // how many recent additions to render
const ART_WIDTH = 44;       // characters wide
const CHAR_ASPECT = 0.5;    // monospace chars are ~2x taller than wide
const APPLE_STOREFRONT = "us";

// Brightness -> character, light to dense. Dark source pixels map to
// space (fade into the black background); bright pixels map to the
// densest character. Flip the string to invert.
const ASCII_RAMP = " .:-=+*#%@";

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Spotify auth failed ${res.status}: ${await res.text()}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

async function spotify(path, token) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify API error ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchPlaylistMeta(token) {
  const fields = "name,description,external_urls,owner(display_name),tracks(total)";
  return spotify(`/playlists/${PLAYLIST_ID}?fields=${encodeURIComponent(fields)}`, token);
}

async function fetchAllItems(token) {
  const fields =
    "next,items(added_at,track(id,name,duration_ms,external_urls,artists(name),album(name,release_date,images)))";
  const items = [];
  let path = `/playlists/${PLAYLIST_ID}/tracks?limit=100&fields=${encodeURIComponent(fields)}`;

  while (path) {
    const page = await spotify(path, token);
    items.push(...(page.items || []));
    // `next` comes back as a full URL; strip the base so spotify() can reuse it.
    path = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Apple Music
// ---------------------------------------------------------------------------

// The public iTunes Search API needs no key and returns Apple Music URLs.
// We match on artist + title; if nothing convincing comes back we fall back
// to a prefilled Apple Music search so the link is never dead.
async function findAppleMusicUrl(trackName, artistName) {
  const term = `${artistName} ${trackName}`;
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=song&limit=5&country=${APPLE_STOREFRONT}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { results = [] } = await res.json();

    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wantTrack = norm(trackName);
    const wantArtist = norm(artistName);

    const hit =
      results.find(
        (r) =>
          norm(r.trackName || "").includes(wantTrack) &&
          norm(r.artistName || "").includes(wantArtist)
      ) ||
      results.find((r) => norm(r.trackName || "").includes(wantTrack)) ||
      null;

    if (hit?.trackViewUrl) {
      // Strip iTunes affiliate/campaign noise, keep the clean Apple Music link.
      return hit.trackViewUrl.split("?")[0];
    }
  } catch (err) {
    console.warn(`Apple Music lookup failed for "${trackName}": ${err.message}`);
  }

  return `https://music.apple.com/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(term)}`;
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

async function imageToAscii(imageUrl) {
  const res = await fetch(imageUrl);
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

function pickCover(album) {
  const images = album?.images || [];
  // Prefer a mid-size image — 640px is overkill for a 44-char render.
  return (images.find((i) => i.width && i.width <= 400) || images[0])?.url || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = await getAccessToken();
  const [meta, items] = await Promise.all([
    fetchPlaylistMeta(token),
    fetchAllItems(token),
  ]);

  const usable = items.filter((i) => i.track && i.track.id);

  // Newest additions first. Playlists with no added_at (some algorithmic ones)
  // fall back to reverse playlist order, which is the next best guess.
  const hasDates = usable.some((i) => i.added_at);
  const ordered = hasDates
    ? [...usable].sort((a, b) => new Date(b.added_at) - new Date(a.added_at))
    : [...usable].reverse();

  const tracks = [];
  for (const item of ordered.slice(0, TRACK_LIMIT)) {
    const t = item.track;
    const artist = (t.artists || []).map((a) => a.name).join(", ") || "Unknown artist";
    const cover = pickCover(t.album);

    try {
      tracks.push({
        id: t.id,
        name: t.name,
        artist,
        album: t.album?.name || "",
        year: (t.album?.release_date || "").slice(0, 4),
        duration: duration(t.duration_ms),
        addedAt: item.added_at || null,
        timeAgo: timeAgo(item.added_at),
        spotifyUrl: t.external_urls?.spotify || "",
        appleMusicUrl: await findAppleMusicUrl(t.name, (t.artists || [])[0]?.name || artist),
        art: cover ? await imageToAscii(cover) : "",
      });
    } catch (err) {
      console.warn(`Skipping "${t.name}": ${err.message}`);
    }
  }

  const feed = {
    generatedAt: new Date().toISOString(),
    profile: { username: "jamesowenlantz" },
    playlist: {
      name: meta.name || "",
      description: meta.description || "",
      owner: meta.owner?.display_name || "",
      total: meta.tracks?.total ?? null,
      spotifyUrl: meta.external_urls?.spotify || `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      appleMusicUrl:
        APPLE_PLAYLIST_URL ||
        `https://music.apple.com/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(meta.name || "")}`,
    },
    tracks,
  };

  await fs.writeFile("playlist.json", JSON.stringify(feed, null, 2));
  console.log(`Wrote playlist.json with ${tracks.length} track(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
