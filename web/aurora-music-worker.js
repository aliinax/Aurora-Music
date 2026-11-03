// ============================================================
// Aurora Music — Sonic Stream Engine
// High-performance, thin-server, thick-client music streaming
// platform powered by Cloudflare Workers & YouTube Music.
// ============================================================

const APP_NAME = "Aurora Music";
const APP_TAGLINE = "Sonic Stream Engine";
const VERSION = "1.0.0";
const MAX_SEARCH_RESULTS = 30;

const YTM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const YTM_CV = "1.20241028.01.00";
const YTM_SEARCH_PARAMS = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"; // Filter by songs only

// Memory cache for stream URLs (keyed by videoId, valid for 3 hours)
const STREAM_CACHE = new Map();
const CACHE_TTL_MS = 3 * 3600 * 1000;

// Internal Security Headers against Clickjacking, MIME sniffing, XSS & data leaks
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

// Strict YouTube video ID validation (strictly 11 chars: alphanumeric, _, -)
const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const TRACK_ID_REGEX = /^[a-zA-Z0-9_\-\.\/]{4,128}$/;
function isValidTrackOrVideoId(id) {
  return typeof id === "string" && TRACK_ID_REGEX.test(id);
}

function isValidVideoId(vid) {
  return typeof vid === "string" && YOUTUBE_ID_REGEX.test(vid);
}

// Whitelisted hosts for thumbnail proxying (prevents SSRF attacks against internal networks and cloud metadata)
const ALLOWED_THUMB_HOSTS = new Set([
  "i.ytimg.com",
  "ytimg.com",
  "music.youtube.com",
  "music.aurorax.site",
  "aurorax.site"
]);

function isAllowedThumbUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    // Block internal loopback & RFC 1918 / cloud metadata IPs
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "169.254.169.254" || h === "::1") return false;
    if (h.startsWith("10.") || h.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return false;
    if (ALLOWED_THUMB_HOSTS.has(h)) return true;
    if (h.endsWith(".googleusercontent.com") || h.endsWith(".ggpht.com") || h.endsWith(".aurorax.site") || h.endsWith(".r2.cloudflarestorage.com")) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Memory cache for resolved R2 keys and object sizes (persists across requests in warm worker)
const R2_RESOLVE_CACHE = new Map();

// Rate limiting map per IP (sliding 1-min window)
const RATE_LIMIT_MAP = new Map();

function isRateLimited(ip, maxReq = 90) {
  const now = Date.now();
  if (RATE_LIMIT_MAP.size > 2000) {
    for (const [k, v] of RATE_LIMIT_MAP.entries()) {
      if (now - v.start > 60000) RATE_LIMIT_MAP.delete(k);
    }
  }
  let entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now - entry.start > 60000) {
    entry = { start: now, count: 1 };
    RATE_LIMIT_MAP.set(ip, entry);
    return false;
  }
  entry.count++;
  return entry.count > maxReq;
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "127.0.0.1";
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

// ------------------------------------------------------------
// Core YouTube Music Search (WEB_REMIX Innertube + D1 Catalog)
// ------------------------------------------------------------
async function fetchYTMSearch(query, searchParams = null) {
  try {
    const bodyObj = {
      context: { client: { clientName: "WEB_REMIX", clientVersion: YTM_CV, hl: "es", gl: "US" } },
      query,
    };
    if (searchParams) bodyObj.params = searchParams;
    const res = await fetch("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": YTM_UA,
        "origin": "https://music.youtube.com",
        "referer": "https://music.youtube.com/",
      },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { songs: [], albums: [], artists: [] };
    const json = await res.json();

    const shelves = [];
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      if (node.musicShelfRenderer) shelves.push(node.musicShelfRenderer);
      if (node.musicCardShelfRenderer) shelves.push(node.musicCardShelfRenderer);
      for (const k in node) walk(node[k]);
    })(json.contents || {});

    const songs = [];
    for (const sh of shelves) {
      const items = sh.contents || (sh.buttons ? [sh] : []);
      for (const it of items) {
        const row = parseShelfItem(it);
        if (row) songs.push(row);
      }
    }

    const albums = [];
    const seenAlbums = new Set();
    const artists = [];
    const seenArtists = new Set();

    (function findEntities(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) findEntities(n); return; }

      // Two-row item renderers (often cards for Albums / Artists)
      if (node.musicTwoRowItemRenderer) {
        const r = node.musicTwoRowItemRenderer;
        const pageType = r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
          const title = r.title?.runs?.map(x => x.text).join("").trim() || "Álbum";
          const subtitle = r.subtitle?.runs?.map(x => x.text).join("").trim() || "";
          const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || "";
          const thumb = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
          if (title && !seenAlbums.has(title.toLowerCase())) {
            seenAlbums.add(title.toLowerCase());
            albums.push({ title, subtitle, browseId, thumb });
          }
        } else if (pageType === "MUSIC_PAGE_TYPE_ARTIST") {
          const name = r.title?.runs?.map(x => x.text).join("").trim() || "";
          const subtitle = r.subtitle?.runs?.map(x => x.text).join("").trim() || "Artista";
          const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || "";
          const thumb = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
          if (name && !seenArtists.has(name.toLowerCase())) {
            seenArtists.add(name.toLowerCase());
            artists.push({ name, subtitle, browseId, thumb });
          }
        }
      }

      // Responsive list item renderers (rows for Albums / Artists)
      if (node.musicResponsiveListItemRenderer) {
        const r = node.musicResponsiveListItemRenderer;
        const pageType = r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
          const cols = r.flexColumns || [];
          const title = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join("").trim() || "Álbum";
          const subtitle = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join("").trim() || "";
          const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || "";
          const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
          if (title && !seenAlbums.has(title.toLowerCase())) {
            seenAlbums.add(title.toLowerCase());
            albums.push({ title, subtitle, browseId, thumb });
          }
        } else if (pageType === "MUSIC_PAGE_TYPE_ARTIST") {
          const cols = r.flexColumns || [];
          const name = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join("").trim() || "";
          const subtitle = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join("").trim() || "Artista";
          const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || "";
          const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
          if (name && !seenArtists.has(name.toLowerCase())) {
            seenArtists.add(name.toLowerCase());
            artists.push({ name, subtitle, browseId, thumb });
          }
        }
      }

      for (const k in node) findEntities(node[k]);
    })(json.contents || {});

    return { songs, albums, artists };
  } catch (_) {
    return { songs: [], albums: [], artists: [] };
  }
}

async function searchYouTubeMusic(query, env = null) {
  const dbResults = [];
  const seen = new Set();
  const cleanQ = (query || "").replace(/\s+/g, " ").trim();
  if (!cleanQ) return { results: [], albums: [], artists: [] };

  // Search local D1 catalog first (instant R2-ready tracks)
  if (env && env.DB) {
    try {
      const qLike = `%${cleanQ}%`;
      const rows = await env.DB.prepare(
        "SELECT s.vid, s.title, s.artist, s.album, s.duration, s.plays FROM songs s JOIN tracks t ON t.id = s.track_id WHERE t.ext = 'mp3' AND (LOWER(s.title) LIKE LOWER(?) OR LOWER(s.artist) LIKE LOWER(?) OR LOWER(s.album) LIKE LOWER(?)) ORDER BY s.plays DESC LIMIT 8"
      ).bind(qLike, qLike, qLike).all();
      if (rows && rows.results) {
        for (const r of rows.results) {
          if (!seen.has(r.vid)) {
            seen.add(r.vid);
            dbResults.push({
              id: r.vid,
              title: r.title,
              artist: r.artist || "Artista Aurora",
              album: r.album || "Catálogo Aurora",
              duration: r.duration || 210,
              duration_text: formatDuration(r.duration || 210),
              thumb: `https://i.ytimg.com/vi/${r.vid}/hqdefault.jpg`,
              r2Ready: true,
              plays: r.plays || 0
            });
          }
        }
      }
    } catch (_) {}
  }

  // 1. Broad search first to capture top songs, albums, and artists
  let res = await fetchYTMSearch(cleanQ, null);
  let songs = res.songs || [];
  let albums = res.albums || [];
  let artists = res.artists || [];

  // 2. Fetch full songs catalog if broad search returned few songs
  if (songs.length < 15) {
    const songOnlyRes = await fetchYTMSearch(cleanQ, YTM_SEARCH_PARAMS);
    if (songOnlyRes.songs && songOnlyRes.songs.length) {
      for (const s of songOnlyRes.songs) {
        if (!songs.some(existing => existing.id === s.id)) {
          songs.push(s);
        }
      }
    }
    if (!albums.length && songOnlyRes.albums) albums = songOnlyRes.albums;
    if (!artists.length && songOnlyRes.artists) artists = songOnlyRes.artists;
  }

  const ytResults = [];
  for (const it of songs) {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      ytResults.push(it);
      if (ytResults.length >= MAX_SEARCH_RESULTS) break;
    }
  }

  const allSongs = [...dbResults, ...ytResults];

  // Synthesize artists from songs if none returned from YTM
  if (artists.length === 0 && allSongs.length > 0) {
    const artistMap = new Map();
    for (const s of allSongs) {
      if (s.artist && s.artist !== "Artista" && s.artist !== "YouTube") {
        const key = s.artist.toLowerCase();
        if (!artistMap.has(key)) {
          artistMap.set(key, {
            name: s.artist,
            subtitle: "Artista",
            thumb: s.thumb,
            trackCount: 1
          });
        } else {
          artistMap.get(key).trackCount++;
        }
      }
    }
    for (const a of artistMap.values()) {
      artists.push({
        name: a.name,
        subtitle: `Artista • ${a.trackCount} temas`,
        thumb: a.thumb
      });
      if (artists.length >= 10) break;
    }
  }

  // Synthesize albums from songs if none returned from YTM
  if (albums.length === 0 && allSongs.length > 0) {
    const albumMap = new Map();
    for (const s of allSongs) {
      if (s.album && s.album !== "Single" && s.album !== "Catálogo Aurora" && s.album !== s.title) {
        const key = (s.album + "::" + s.artist).toLowerCase();
        if (!albumMap.has(key)) {
          albumMap.set(key, {
            title: s.album,
            subtitle: `Álbum • ${s.artist}`,
            thumb: s.thumb
          });
        }
      }
    }
    for (const alb of albumMap.values()) {
      albums.push(alb);
      if (albums.length >= 12) break;
    }
  }

  return { results: allSongs, albums: albums.slice(0, 12), artists: artists.slice(0, 10) };
}

function parseShelfItem(it) {
  const r = it.musicResponsiveListItemRenderer;
  if (!r) return null;

  let vid = r.playlistItemData?.videoId;
  if (!vid && r.doubleTapCommand?.watchEndpoint?.videoId) {
    vid = r.doubleTapCommand.watchEndpoint.videoId;
  }
  if (!vid || typeof vid !== "string" || vid.length !== 11) return null;

  const cols = r.flexColumns || [];
  let title = "Canción";
  let artist = "Artista";
  let album = "";
  let duration = 0;
  let duration_text = "";

  try {
    const tRuns = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    if (tRuns && tRuns[0] && tRuns[0].text) title = tRuns[0].text.trim();

    const sRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    if (sRuns) {
      const parts = sRuns.map(x => x.text).filter(x => x && x !== " • " && x !== " & " && x !== ", ");
      if (parts[0]) artist = parts[0].trim();
      if (parts[1] && isNaN(parseInt(parts[1], 10))) album = parts[1].trim();
      const durStr = parts.find(p => /^\d{1,2}:\d{2}$/.test(p));
      if (durStr) {
        duration_text = durStr;
        const [m, s] = durStr.split(":").map(Number);
        duration = m * 60 + s;
      }
    }
  } catch (_) {}

  let thumb = "";
  try {
    const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    if (thumbs && thumbs.length) {
      thumb = thumbs[thumbs.length - 1].url;
      // Upgrade resolution if applicable (w120-h120 -> w544-h544)
      thumb = thumb.replace(/=w\d+-h\d+/, "=w544-h544");
    }
  } catch (_) {}

  return {
    id: vid,
    title,
    artist,
    album,
    duration,
    duration_text: duration_text || "3:30",
    thumb: thumb || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
  };
}

// ------------------------------------------------------------
// Audio Stream Resolution via ANDROID_VR Client
// ------------------------------------------------------------
// ------------------------------------------------------------
// Streaming via la VM conv (yt-dlp android_testsuite): el unico
// camino que resuelve videos de YouTube desde IP datacenter (los
// default clients de innertube dan LOGIN_REQUIRED desde Cloudflare).
// La VM convierte a MP3, streamea al vuelo y cachea en disco, asi
// que la 2a reproduccion es instantanea. Soporta Range (seek).
// ------------------------------------------------------------
function convBaseUrl(env) {
  let u = String((env && env.CONV_URL) || "");
  u = u.replace(/\/+$/, "");
  if (u.endsWith("/convert")) u = u.slice(0, -8);
  return u.replace(/\/+$/, "");
}

async function streamViaConvVM(request, env, vid, method, ctx) {
  const base = convBaseUrl(env);
  if (!base || !env.CONV_KEY) return null;
  const upHeaders = { authorization: "Bearer " + env.CONV_KEY };
  const range = request.headers.get("range");
  // la VM no implementa HEAD: para prefetch usamos Range 0-0 (calienta
  // cache si es conversion fresca: el body completo se consume abajo)
  if (method === "HEAD") upHeaders.range = "bytes=0-0";
  else if (range) upHeaders.range = String(range).slice(0, 64);
  let up = null;
  try {
    up = await fetch(base + "/play?id=" + encodeURIComponent(vid), {
      method: "GET",
      headers: upHeaders,
      signal: AbortSignal.timeout(240000),
    });
  } catch (_) {
    return null;
  }
  if (up.status !== 200 && up.status !== 206) {
    try { if (up.body) await up.body.cancel(); } catch (_) {}
    return null;
  }
  let total = "";
  const cr = up.headers.get("content-range");
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) total = m[1];
  }
  if (!total) total = up.headers.get("content-length") || "";

  if (method === "HEAD") {
    // 206 (1 byte) = cache hit. 200 = conversion fresca en curso:
    // dejamos que el body siga fluyendo en background para que la VM
    // termine de cachear la cancion (prefetch real de la siguiente).
    if (up.status === 200 && ctx) {
      try { ctx.waitUntil(up.arrayBuffer().catch(() => {})); } catch (_) {}
    } else {
      try { if (up.body) await up.body.cancel(); } catch (_) {}
    }
    const h = {
      "Content-Type": "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, max-age=3600",
    };
    if (total) h["Content-Length"] = total;
    return new Response(null, { status: 200, headers: h });
  }

  const respHeaders = new Headers();
  respHeaders.set("Content-Type", "audio/mpeg");
  respHeaders.set("Accept-Ranges", "bytes");
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
  respHeaders.set("Cache-Control", "private, max-age=3600");
  if (up.headers.has("content-range")) respHeaders.set("Content-Range", up.headers.get("content-range"));
  if (up.headers.has("content-length")) respHeaders.set("Content-Length", up.headers.get("content-length"));
  return new Response(up.body, { status: up.status, headers: respHeaders });
}

async function resolveAudioStream(vid) {
  const cached = STREAM_CACHE.get(vid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    if (cached.failed) return null;
    return cached.data;
  }

  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Linux; Android 12; Quest 2) AppleWebKit/537.36",
      },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID_VR", clientVersion: "1.56.21", hl: "es", gl: "US" } },
        videoId: vid,
      }),
      signal: AbortSignal.timeout(2500),
    });

    if (!res.ok) {
      STREAM_CACHE.set(vid, { at: Date.now(), failed: true });
      return null;
    }
    const json = await res.json();
    if (!json.streamingData || !json.streamingData.adaptiveFormats) {
      STREAM_CACHE.set(vid, { at: Date.now(), failed: true });
      return null;
    }

    const formats = json.streamingData.adaptiveFormats.filter(f => f.mimeType && f.mimeType.startsWith("audio/"));
    let chosen = formats.find(f => f.itag === 140 && f.url);
    if (!chosen) chosen = formats.find(f => f.url);
    if (!chosen || !chosen.url) {
      STREAM_CACHE.set(vid, { at: Date.now(), failed: true });
      return null;
    }

    const data = {
      url: chosen.url,
      mime: chosen.mimeType.split(";")[0] || "audio/mp4",
      bitrate: chosen.bitrate || 128000,
      contentLength: chosen.contentLength ? parseInt(chosen.contentLength, 10) : null,
      ext: chosen.mimeType.includes("webm") ? "webm" : "m4a",
    };

    STREAM_CACHE.set(vid, { at: Date.now(), data });
    return data;
  } catch (_) {
    STREAM_CACHE.set(vid, { at: Date.now(), failed: true });
    return null;
  }
}

// ------------------------------------------------------------
// Audio Stream Proxy with HTTP Range (206 Partial Content)
// ------------------------------------------------------------
async function proxyAudioStream(request, streamInfo, isDownload = false, fileName = "song.m4a") {
  const upHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
  };

  const range = request.headers.get("range");
  if (range && !isDownload) {
    upHeaders["Range"] = range;
  }

  try {
    const upstream = await fetch(streamInfo.url, {
      method: "GET",
      headers: upHeaders,
      signal: AbortSignal.timeout(25000),
    });

    const status = upstream.status === 206 ? 206 : 200;
    const respHeaders = new Headers();

    respHeaders.set("Content-Type", streamInfo.mime);
    respHeaders.set("Accept-Ranges", "bytes");
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    respHeaders.set("Cache-Control", "private, max-age=7200");

    if (upstream.headers.has("content-range")) {
      respHeaders.set("Content-Range", upstream.headers.get("content-range"));
    }
    if (upstream.headers.has("content-length")) {
      respHeaders.set("Content-Length", upstream.headers.get("content-length"));
    }

    if (isDownload) {
      const safeName = (fileName || `track.${streamInfo.ext || "m4a"}`).replace(/[\r\n\t\\/:*?"<>|]/g, " ").trim().slice(0, 80) || "track.m4a";
      const asciiName = safeName.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "").trim() || "track.m4a";
      respHeaders.set("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    }

    return new Response(upstream.body, {
      status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response("Upstream audio stream error", { status: 502 });
  }
}

// ------------------------------------------------------------
// Audio Stream from Cloudflare R2 Bucket (Lossless, 0-Latency, Range 206)
// ------------------------------------------------------------
async function streamFromR2(request, env, vid, isDownload = false, fileName = "song.mp3") {
  if (!env || !env.MP3) return null;

  let resolved = R2_RESOLVE_CACHE.get(vid);

  if (!resolved) {
    // Check common R2 key patterns in PARALLEL via Promise.all
    // Priority: 'y/' prefix first as most tracks in library are stored under y/{vid}.mp3
    const candidateKeys = [
      vid,
      'y/' + vid + '.mp3',
      'g/' + vid + '.mp3',
      'y/' + vid + '.m4a',
    ];

    const checks = await Promise.all(
      candidateKeys.map(async (k) => {
        try {
          const h = await env.MP3.head(k);
          if (h) return { key: k, size: h.size };
        } catch (_) {}
        return null;
      })
    );

    const found = checks.find(c => c !== null);
    if (found) {
      const ext = found.key.endsWith('.m4a') ? 'm4a' : 'mp3';
      const ctype = ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
      resolved = { key: found.key, size: found.size, ctype, ext };
      R2_RESOLVE_CACHE.set(vid, resolved);
    }
  }

  // If not found directly, check D1 database
  if (!resolved && env.DB) {
    try {
      let r2Key = null;
      // 1. By song vid
      const s = await env.DB.prepare(
        "SELECT t.r2_key, t.ext FROM songs s JOIN tracks t ON t.id = s.track_id WHERE s.vid = ? LIMIT 1"
      ).bind(vid).first();
      if (s && s.r2_key) r2Key = s.r2_key;

      // 2. By track id directly
      if (!r2Key) {
        const tById = await env.DB.prepare(
          "SELECT r2_key, ext FROM tracks WHERE id = ? LIMIT 1"
        ).bind(vid).first();
        if (tById && tById.r2_key) r2Key = tById.r2_key;
      }

      // 3. By candidate r2_key in tracks table
      if (!r2Key) {
        const t = await env.DB.prepare(
          "SELECT r2_key, ext FROM tracks WHERE r2_key = ? OR r2_key LIKE ? OR r2_key LIKE ? LIMIT 1"
        ).bind('y/' + vid + '.mp3', '%/' + vid + '.mp3', '%/' + vid + '.m4a').first();
        if (t && t.r2_key) r2Key = t.r2_key;
      }

      if (r2Key) {
        const h = await env.MP3.head(r2Key);
        if (h) {
          const ext = r2Key.endsWith('.m4a') ? 'm4a' : 'mp3';
          const ctype = ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
          resolved = { key: r2Key, size: h.size, ctype, ext };
          R2_RESOLVE_CACHE.set(vid, resolved);
        }
      }
    } catch (_) {}
  }

  if (!resolved) return null;

  const { key, size, ctype, ext } = resolved;
  const method = request.method;

  // Instant response for HEAD requests (connection warming and metadata)
  if (method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": ctype,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  }

  const range = request.headers.get("range");
  if (range && !isDownload) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      try {
        let start = 0;
        let end = size - 1;
        if (m[1] === "") {
          const suffix = Math.min(parseInt(m[2], 10), size);
          start = size - suffix;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
        }

        if (start <= end && start >= 0 && start < size) {
          // Direct range slice fetch from R2 without redundant HEAD calls!
          const part = await env.MP3.get(key, { range: { offset: start, length: end - start + 1 } });
          if (part && part.body) {
            return new Response(part.body, {
              status: 206,
              headers: {
                "Content-Type": ctype,
                "Content-Length": String(end - start + 1),
                "Content-Range": `bytes ${start}-${end}/${size}`,
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "Range, Content-Type",
                "Cache-Control": "public, max-age=604800, immutable",
              },
            });
          }
        }
      } catch (_) {}
    }
  }

  try {
    const obj = await env.MP3.get(key);
    if (!obj) return null;

    const respHeaders = new Headers();
    respHeaders.set("Content-Type", ctype);
    respHeaders.set("Content-Length", String(obj.size || size));
    respHeaders.set("Accept-Ranges", "bytes");
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    respHeaders.set("Cache-Control", "public, max-age=604800, immutable");

    if (isDownload) {
      const safeName = (fileName || `track.${ext}`).replace(/[\r\n\t\\/:*?"<>|]/g, " ").trim().slice(0, 80) || `track.${ext}`;
      const asciiName = safeName.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "").trim() || `track.${ext}`;
      respHeaders.set("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    }

    return new Response(obj.body, {
      status: 200,
      headers: respHeaders,
    });
  } catch (_) {
    return null;
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60) || 0;
  const s = Math.floor(sec % 60) || 0;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Curated home collections (D1 Database + Cloudflare R2 + Fast Curated Trending)
const DEFAULT_TRENDING = [
  { id: "kIft-LUHHVA", title: "Espresso", artist: "Sabrina Carpenter", album: "Short n' Sweet", duration: 176, duration_text: "2:56", thumb: "https://i.ytimg.com/vi/kIft-LUHHVA/hqdefault.jpg", r2Ready: true, rank: 1 },
  { id: "kPa7bsKwL-c", title: "Die With A Smile", artist: "Lady Gaga, Bruno Mars", album: "Die With A Smile", duration: 252, duration_text: "4:12", thumb: "https://i.ytimg.com/vi/kPa7bsKwL-c/hqdefault.jpg", r2Ready: true, rank: 2 },
  { id: "V9PVRfjEBTI", title: "BIRDS OF A FEATHER", artist: "Billie Eilish", album: "HIT ME HARD AND SOFT", duration: 194, duration_text: "3:14", thumb: "https://i.ytimg.com/vi/V9PVRfjEBTI/hqdefault.jpg", r2Ready: true, rank: 3 },
  { id: "KEG7b851Ric", title: "Taste", artist: "Sabrina Carpenter", album: "Short n' Sweet", duration: 158, duration_text: "2:38", thumb: "https://i.ytimg.com/vi/KEG7b851Ric/hqdefault.jpg", r2Ready: true, rank: 4 },
  { id: "VZ-oGLluGAc", title: "Good Luck, Babe!", artist: "Chappell Roan", album: "Good Luck, Babe!", duration: 219, duration_text: "3:39", thumb: "https://i.ytimg.com/vi/VZ-oGLluGAc/hqdefault.jpg", r2Ready: true, rank: 5 },
  { id: "phLb_SoPBlA", title: "Not Like Us", artist: "Kendrick Lamar", album: "Not Like Us", duration: 275, duration_text: "4:35", thumb: "https://i.ytimg.com/vi/phLb_SoPBlA/hqdefault.jpg", r2Ready: true, rank: 6 },
  { id: "mi-JD4jGVUQ", title: "Si Antes Te Hubiera Conocido", artist: "KAROL G", album: "Si Antes Te Hubiera Conocido", duration: 196, duration_text: "3:16", thumb: "https://i.ytimg.com/vi/mi-JD4jGVUQ/hqdefault.jpg", r2Ready: true, rank: 7 },
  { id: "UWn9RdueB7E", title: "Gata Only", artist: "FloyyMenor, Cris Mj", album: "Gata Only", duration: 222, duration_text: "3:42", thumb: "https://i.ytimg.com/vi/UWn9RdueB7E/hqdefault.jpg", r2Ready: true, rank: 8 },
  { id: "TiebZllW8As", title: "DtMF", artist: "Bad Bunny", album: "nadie sabe lo que va a pasar mañana", duration: 238, duration_text: "3:58", thumb: "https://i.ytimg.com/vi/TiebZllW8As/hqdefault.jpg", r2Ready: true, rank: 9 },
  { id: "HekrZ0QcI3g", title: "PERRO NEGRO", artist: "Bad Bunny, Feid", album: "nadie sabe lo que va a pasar mañana", duration: 163, duration_text: "2:43", thumb: "https://i.ytimg.com/vi/HekrZ0QcI3g/hqdefault.jpg", r2Ready: true, rank: 10 },
  { id: "3_g2un5M350", title: "Starboy", artist: "The Weeknd, Daft Punk", album: "Starboy", duration: 231, duration_text: "3:51", thumb: "https://i.ytimg.com/vi/3_g2un5M350/hqdefault.jpg", r2Ready: true, rank: 11 },
  { id: "J7p4bzqLvCw", title: "Blinding Lights", artist: "The Weeknd", album: "After Hours", duration: 202, duration_text: "3:22", thumb: "https://i.ytimg.com/vi/J7p4bzqLvCw/hqdefault.jpg", r2Ready: true, rank: 12 },
  { id: "Cl5Vkd4N03Q", title: "After Dark", artist: "Mr.Kitty", album: "Time", duration: 257, duration_text: "4:17", thumb: "https://i.ytimg.com/vi/Cl5Vkd4N03Q/hqdefault.jpg", r2Ready: true, rank: 13 },
  { id: "qSxHbFKp-Wo", title: "Reggaeton Champagne", artist: "Bellakath", album: "Kittyponeo", duration: 165, duration_text: "2:45", thumb: "https://i.ytimg.com/vi/qSxHbFKp-Wo/hqdefault.jpg", r2Ready: true, rank: 14 },
  { id: "irmc5n4ZIrM", title: "HOLY WAR FUNK", artist: "DJ Vz7", album: "Single", duration: 124, duration_text: "2:04", thumb: "https://i.ytimg.com/vi/irmc5n4ZIrM/hqdefault.jpg", r2Ready: true, rank: 15 },
  { id: "2Qt-h5gqbn8", title: "Feeling", artist: "Juice WRLD", album: "Death Race for Love", duration: 212, duration_text: "3:32", thumb: "https://i.ytimg.com/vi/2Qt-h5gqbn8/hqdefault.jpg", r2Ready: true, rank: 16 }
];

let TRENDING_CACHE = { at: Date.now(), items: DEFAULT_TRENDING };

async function getTrendingTracks(env) {
  if (TRENDING_CACHE.items && TRENDING_CACHE.items.length) {
    return { results: TRENDING_CACHE.items };
  }
  return { results: DEFAULT_TRENDING };
}

async function getCuratedHome(env) {
  let popularFromDb = [];
  let freshFromDb = [];

  if (env && env.DB) {
    try {
      const topRows = await env.DB.prepare(
        "SELECT s.vid, s.title, s.artist, s.album, s.duration, s.plays FROM songs s JOIN tracks t ON t.id = s.track_id WHERE t.ext = 'mp3' ORDER BY s.plays DESC LIMIT 16"
      ).all();
      if (topRows && topRows.results && topRows.results.length) {
        popularFromDb = topRows.results.map(r => ({
          id: r.vid,
          title: r.title,
          artist: r.artist || "Artista Aurora",
          album: r.album || "Aurora Hits",
          duration: r.duration || 210,
          duration_text: formatDuration(r.duration || 210),
          thumb: `https://i.ytimg.com/vi/${r.vid}/hqdefault.jpg`,
          r2Ready: true,
          plays: r.plays || 0
        }));
      }

      const freshRows = await env.DB.prepare(
        "SELECT s.vid, s.title, s.artist, s.album, s.duration, s.plays FROM songs s JOIN tracks t ON t.id = s.track_id WHERE t.ext = 'mp3' ORDER BY s.created_at DESC LIMIT 16"
      ).all();
      if (freshRows && freshRows.results && freshRows.results.length) {
        freshFromDb = freshRows.results.map(r => ({
          id: r.vid,
          title: r.title,
          artist: r.artist || "Artista Aurora",
          album: r.album || "Novedad",
          duration: r.duration || 210,
          duration_text: formatDuration(r.duration || 210),
          thumb: `https://i.ytimg.com/vi/${r.vid}/hqdefault.jpg`,
          r2Ready: true
        }));
      }
    } catch (_) {}
  }

  const defaultFeatured = [
    { id: "Cl5Vkd4N03Q", title: "After Dark", artist: "Mr.Kitty", album: "Time", duration_text: "4:17", thumb: "https://i.ytimg.com/vi/Cl5Vkd4N03Q/hqdefault.jpg", r2Ready: true },
    { id: "qSxHbFKp-Wo", title: "Reggaeton Champagne", artist: "Bellakath", album: "Kittyponeo", duration_text: "2:45", thumb: "https://i.ytimg.com/vi/qSxHbFKp-Wo/hqdefault.jpg", r2Ready: true },
    { id: "irmc5n4ZIrM", title: "HOLY WAR FUNK", artist: "DJ Vz7", album: "Single", duration_text: "2:04", thumb: "https://i.ytimg.com/vi/irmc5n4ZIrM/hqdefault.jpg", r2Ready: true },
    { id: "2Qt-h5gqbn8", title: "Feeling", artist: "Juice WRLD", album: "Death Race for Love", duration_text: "3:32", thumb: "https://i.ytimg.com/vi/2Qt-h5gqbn8/hqdefault.jpg", r2Ready: true },
    { id: "jvm6DpqqbLk", title: "Sad Girl", artist: "Lana Del Rey", album: "Ultraviolence", duration_text: "5:17", thumb: "https://i.ytimg.com/vi/jvm6DpqqbLk/hqdefault.jpg", r2Ready: true },
    { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artist: "Rick Astley", album: "Whenever You Need Somebody", duration_text: "3:33", thumb: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", r2Ready: true }
  ];

  const trendingRes = await getTrendingTracks(env);

  return {
    featured: popularFromDb.length ? popularFromDb.slice(0, 12) : defaultFeatured,
    fresh: freshFromDb.length ? freshFromDb.slice(0, 10) : defaultFeatured.slice(2),
    trending: trendingRes.results ? trendingRes.results.slice(0, 12) : [],
    categories: [
      { id: "all", name: "Todos", query: "" },
      { id: "workout", name: "Para entrenar", query: "Gym Workout Motivation Reggaeton" },
      { id: "energy", name: "Energ\u00EDa", query: "Musica Electronica Dance Energy" },
      { id: "relax", name: "Relajaci\u00F3n", query: "Musica Relajante Chill Acustica" },
      { id: "focus", name: "Para concentrarse", query: "Lofi Focus Study Beats Instrumental" },
      { id: "party", name: "De fiesta", query: "Fiesta Party Hits 2026 Latin Pop" },
      { id: "commute", name: "En el auto", query: "Musica para Viajar en Auto Hits" },
      { id: "rock", name: "Rock", query: "Rock Clasico Grandes Exitos" },
      { id: "urban", name: "Trap & Urbano", query: "Trap Latino Urbano Hits" },
    ],
  };
}

// ------------------------------------------------------------
// Worker Request Router
// ------------------------------------------------------------
// ------------------------------------------------------------
// YouTube Music Official Radio Queue (youtubei/v1/next)
// ------------------------------------------------------------
async function fetchYTMRadioQueue(vid) {
  try {
    const bodyObj = {
      context: { client: { clientName: "WEB_REMIX", clientVersion: YTM_CV, hl: "es", gl: "US" } },
      videoId: vid,
      playlistId: "RDAMVM" + vid,
      isAudioOnly: true,
    };
    const res = await fetch("https://music.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": YTM_UA,
        "origin": "https://music.youtube.com",
        "referer": "https://music.youtube.com/",
      },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const json = await res.json();

    const tabs = json.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
    const queueRenderer = tabs[0]?.tabRenderer?.content?.musicQueueRenderer;
    const panelRenderer = queueRenderer?.content?.playlistPanelRenderer;
    const contents = panelRenderer?.contents || [];

    const radioTracks = [];
    const seen = new Set();
    seen.add(vid);

    for (const entry of contents) {
      const r = entry.playlistPanelVideoRenderer;
      if (!r || !r.videoId || seen.has(r.videoId)) continue;
      seen.add(r.videoId);

      const title = r.title?.runs?.map(x => x.text).join("").trim() || "Canci\u00F3n";
      const bylines = r.longBylineText?.runs?.map(x => x.text) || [];
      const artist = bylines[0]?.trim() || "Artista";
      const album = bylines.length > 2 ? bylines[2]?.trim() : "";
      const duration_text = r.lengthText?.runs?.map(x => x.text).join("").trim() || "3:30";
      
      let duration = 210;
      if (/^\d{1,2}:\d{2}$/.test(duration_text)) {
        const [m, s] = duration_text.split(":").map(Number);
        duration = m * 60 + s;
      }

      let thumb = `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;
      const thumbs = r.thumbnail?.thumbnails;
      if (thumbs && thumbs.length) {
        thumb = thumbs[thumbs.length - 1].url;
      }

      radioTracks.push({
        id: r.videoId,
        title,
        artist,
        album,
        duration,
        duration_text,
        thumb
      });

      if (radioTracks.length >= 40) break;
    }

    return radioTracks;
  } catch (_) {
    return [];
  }
}

const VID_ALIASES = {
  "kPa7bsKwL-8": "kPa7bsKwL-c", // Die With A Smile (typo fix to official)
  "DlFXDl_ROAM": "kPa7bsKwL-c",
  "d5gf9dXFKXE": "V9PVRfjEBTI", // BIRDS OF A FEATHER (official)
  "WKZO-CWeOVA": "V9PVRfjEBTI",
  "-uX3QdG9x00": "KEG7b851Ric", // Taste (official)
  "-5GI38vWew8": "KEG7b851Ric",
  "e-ORhEE9VVg": "kIft-LUHHVA"  // Espresso
};

// Rate limit del puente (por IP, ventana 60s)
const BRIDGE_RL = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const ip = clientIp(request);

    // Handle CORS Preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Range",
        },
      });
    }

    // Rate limiting (exempt static HTML shell)
    if (path.startsWith("/api/") && isRateLimited(ip, 120)) {
      return jsonResponse({ error: "Rate limit exceeded. Please slow down." }, 429);
    }

    // ---------- API Endpoints ----------
    if (path === "/api/search" && (method === "GET" || method === "HEAD")) {
      let q = (url.searchParams.get("q") || "").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
      if (q.length > 120) q = q.slice(0, 120);
      if (!q) return jsonResponse({ error: "Parámetro 'q' requerido" }, 400);
      const data = await searchYouTubeMusic(q, env);
      return jsonResponse(data);
    }

    if (path === "/api/home" && (method === "GET" || method === "HEAD")) {
      const homeData = await getCuratedHome(env);
      return jsonResponse(homeData);
    }

    if (path === "/api/trending" && (method === "GET" || method === "HEAD")) {
      const trendingData = await getTrendingTracks(env);
      return jsonResponse(trendingData);
    }

    if (path === "/api/radio" && (method === "GET" || method === "HEAD")) {
      let vid = (url.searchParams.get("vid") || url.searchParams.get("id") || "").trim();
      if (VID_ALIASES[vid]) vid = VID_ALIASES[vid];
      if (!isValidVideoId(vid)) return jsonResponse({ results: [] });
      const tracks = await fetchYTMRadioQueue(vid);
      return jsonResponse({ results: tracks });
    }

    if (path === "/api/related" && (method === "GET" || method === "HEAD")) {
      let vid = (url.searchParams.get("vid") || url.searchParams.get("id") || "").trim();
      if (VID_ALIASES[vid]) vid = VID_ALIASES[vid];
      if (isValidVideoId(vid)) {
        const radioTracks = await fetchYTMRadioQueue(vid);
        if (radioTracks && radioTracks.length) return jsonResponse({ results: radioTracks });
      }
      const artist = (url.searchParams.get("artist") || "").trim();
      const genre = (url.searchParams.get("genre") || "").trim();
      const query = artist || genre || "Top Global Hits";
      const data = await searchYouTubeMusic(query, env);
      return jsonResponse(data);
    }



    if (path === "/api/track" && (method === "GET" || method === "HEAD")) {
      let vid = (url.searchParams.get("vid") || url.searchParams.get("id") || "").trim();
      vid = VID_ALIASES[vid] || vid;
      if (!vid || vid.length !== 11) return jsonResponse({ error: "ID de video inválido" }, 400);

      // Check if in DEFAULT_TRENDING
      const trendingMatch = DEFAULT_TRENDING.find(t => t.id === vid);
      if (trendingMatch) return jsonResponse(trendingMatch);

      // Check in D1 Database
      if (env && env.DB) {
        try {
          const row = await env.DB.prepare(
            "SELECT s.vid, s.title, s.artist, s.album, s.duration FROM songs s JOIN tracks t ON t.id = s.track_id WHERE s.vid = ? LIMIT 1"
          ).bind(vid).first();
          if (row) {
            return jsonResponse({
              id: row.vid,
              title: row.title,
              artist: row.artist || "Artista Aurora",
              album: row.album || "Aurora Hits",
              duration: row.duration || 210,
              duration_text: formatDuration(row.duration || 210),
              thumb: `https://i.ytimg.com/vi/${row.vid}/hqdefault.jpg`,
              r2Ready: true
            });
          }
        } catch (_) {}
      }

      // Query via search fallback
      const searchRes = await searchYouTubeMusic(vid, env);
      if (searchRes && searchRes.results && searchRes.results.length) {
        return jsonResponse(searchRes.results[0]);
      }

      return jsonResponse({
        id: vid,
        title: "Pista Aurora",
        artist: "Artista",
        album: "Aurora Music",
        duration: 210,
        duration_text: "3:30",
        thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
      });
    }

    if (path === "/api/stream" && (method === "GET" || method === "HEAD")) {
      let vid = (url.searchParams.get("vid") || url.searchParams.get("id") || "").trim();
      vid = VID_ALIASES[vid] || vid;
      if (!vid || vid.length !== 11) return jsonResponse({ error: "ID de video inválido" }, 400);

      // 1. Fast Path: Stream from Cloudflare R2 Bucket
      const r2Res = await streamFromR2(request, env, vid, false);
      if (r2Res) return r2Res;

      // 2. Conv VM Path: yt-dlp android_testsuite desde la VM (resuelve
      //    desde IP datacenter y cachea el MP3 en disco; Range -> seek)
      const convRes = await streamViaConvVM(request, env, vid, method, ctx);
      if (convRes) return convRes;

      // 3. Direct Path: Stream via YouTube Innertube
      const streamInfo = await resolveAudioStream(vid);
      if (streamInfo) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Content-Type": streamInfo.mime,
              "Accept-Ranges": "bytes",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        return proxyAudioStream(request, streamInfo, false);
      }

      // 4. Fallback instruction for client adaptive bridge
      return jsonResponse({ error: "stream_unavailable", fallback: "yt_bridge", vid }, 502);
    }

    if (path === "/api/bridge" && method === "POST") {
      // Puente: el navegador del usuario resolvio la URL de googlevideo
      // con su IP residencial (el servidor tiene IP datacenter y YouTube
      // se la bloquea). La VM la descarga por rangos, convierte a MP3 y
      // la cachea para todos. Solo acepta googlevideo (anti-SSRF).
      const ipB = clientIp(request);
      if (!BRIDGE_RL.has(ipB)) BRIDGE_RL.set(ipB, []);
      const nowB = Date.now();
      const hitsB = BRIDGE_RL.get(ipB).filter((t) => nowB - t < 60000);
      if (hitsB.length >= 12) return jsonResponse({ error: "slow down" }, 429);
      hitsB.push(nowB);
      BRIDGE_RL.set(ipB, hitsB);

      let bodyB = null;
      try { bodyB = await request.json(); } catch (_) { return jsonResponse({ error: "bad json" }, 400); }
      const vidB = String((bodyB && bodyB.vid) || "").trim();
      const uB = String((bodyB && bodyB.u) || "").trim();
      const uaB = String((bodyB && bodyB.ua) || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)").slice(0, 300);
      if (!isValidVideoId(vidB) || !uB) return jsonResponse({ error: "bad request" }, 400);
      let targetB;
      try { targetB = new URL(uB); } catch (_) { return jsonResponse({ error: "invalid url" }, 400); }
      const hostOkB = targetB.protocol === "https:" &&
        (targetB.hostname === "googlevideo.com" || targetB.hostname.endsWith(".googlevideo.com"));
      if (!hostOkB) return jsonResponse({ error: "forbidden url" }, 403);

      const baseB = convBaseUrl(env);
      if (!baseB || !env.CONV_KEY) return jsonResponse({ error: "bridge not configured" }, 503);
      try {
        const upB = await fetch(baseB + "/put", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + env.CONV_KEY },
          body: JSON.stringify({ id: vidB, u: uB, ua: uaB }),
          signal: AbortSignal.timeout(240000),
        });
        const txtB = await upB.text();
        let jB = null;
        try { jB = JSON.parse(txtB); } catch (_) {}
        if (upB.status !== 200 || !jB || !jB.ok) {
          return jsonResponse({ error: (jB && jB.error) || ("conv HTTP " + upB.status) }, 502);
        }
        return jsonResponse({ ok: true, cached: !!jB.cached });
      } catch (_) {
        return jsonResponse({ error: "stream server unreachable" }, 502);
      }
    }

    if (path === "/api/download") {
      return jsonResponse({ error: "Descargas deshabilitadas" }, 404);
    }

    if (path === "/aurora.apk" || path === "/AuroraMusic.apk" || path === "/app.apk" || path === "/download/app" || path === "/download/apk") {
      if (!env || !env.MP3) return new Response("R2 not configured", { status: 500 });
      const APK_KEY = "AuroraMusic.apk";
      // HEAD: solo metadatos, sin leer el objeto
      if (method === "HEAD") {
        const h = await env.MP3.head(APK_KEY);
        if (!h) return new Response("APK not found", { status: 404 });
        const hh = new Headers();
        hh.set("Content-Type", "application/vnd.android.package-archive");
        hh.set("Content-Disposition", 'attachment; filename="AuroraMusic.v1.0.0.apk"');
        hh.set("Content-Length", h.size.toString());
        hh.set("Accept-Ranges", "bytes");
        hh.set("Cache-Control", "public, max-age=3600");
        hh.set("Access-Control-Allow-Origin", "*");
        return new Response(null, { status: 200, headers: hh });
      }
      // Range: descargas reanudables (la APK es grande; en movil corta y
      // reanuda en vez de empezar de cero). Rango simple unico; multi-rango
      // o rango raro -> se sirve el archivo completo.
      const rangeHeader = request.headers.get("range");
      let rangeMatch = null;
      if (rangeHeader) {
        const rm = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (rm && (rm[1] !== "" || rm[2] !== "")) rangeMatch = rm;
      }
      if (rangeMatch) {
        try {
          const h = await env.MP3.head(APK_KEY);
          if (!h) return new Response("APK not found", { status: 404 });
          const totalSize = h.size;
          let rangeStart = 0, rangeLen = 0;
          if (rangeMatch[1] === "") {
            const n = parseInt(rangeMatch[2], 10);
            if (!Number.isFinite(n) || n <= 0) return new Response("Range not satisfiable", { status: 416 });
            rangeLen = Math.min(n, totalSize);
            rangeStart = totalSize - rangeLen;
          } else {
            const start = parseInt(rangeMatch[1], 10);
            const endIncl = rangeMatch[2] === "" ? totalSize - 1 : parseInt(rangeMatch[2], 10);
            if (!Number.isFinite(start) || start < 0 || start >= totalSize) return new Response("Range not satisfiable", { status: 416 });
            rangeLen = Math.min(endIncl, totalSize - 1) - start + 1;
            if (rangeLen <= 0) return new Response("Range not satisfiable", { status: 416 });
            rangeStart = start;
          }
          const robj = await env.MP3.get(APK_KEY, { range: { offset: rangeStart, length: rangeLen } });
          if (robj) {
            const rheaders = new Headers();
            rheaders.set("Content-Type", "application/vnd.android.package-archive");
            rheaders.set("Content-Disposition", 'attachment; filename="AuroraMusic.v1.0.0.apk"');
            rheaders.set("Content-Length", rangeLen.toString());
            rheaders.set("Content-Range", "bytes " + rangeStart + "-" + (rangeStart + rangeLen - 1) + "/" + totalSize);
            rheaders.set("Accept-Ranges", "bytes");
            rheaders.set("Cache-Control", "public, max-age=3600");
            rheaders.set("Access-Control-Allow-Origin", "*");
            return new Response(robj.body, { status: 206, headers: rheaders });
          }
        } catch (_) { /* rango rechazado por R2: servir completo abajo */ }
      }
      const obj = await env.MP3.get(APK_KEY);
      if (!obj) return new Response("APK not found", { status: 404 });
      const headers = new Headers();
      headers.set("Content-Type", "application/vnd.android.package-archive");
      headers.set("Content-Disposition", 'attachment; filename="AuroraMusic.v1.0.0.apk"');
      headers.set("Content-Length", obj.size.toString());
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "public, max-age=3600");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(obj.body, { status: 200, headers });
    }

    if (path === "/api/thumb" && method === "GET") {
      const targetUrl = url.searchParams.get("u");
      if (!targetUrl || !isAllowedThumbUrl(targetUrl)) {
        return jsonResponse({ error: "URL no permitida por politica de seguridad SSRF" }, 403);
      }
      try {
        const thumbRes = await fetch(targetUrl, { signal: AbortSignal.timeout(8000) });
        return new Response(thumbRes.body, {
          status: thumbRes.status,
          headers: {
            "Content-Type": thumbRes.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=604800, immutable",
            "Access-Control-Allow-Origin": "*",
            ...SECURITY_HEADERS,
          },
        });
      } catch (_) {
        return new Response("Thumbnail fetch failed", { status: 502, headers: SECURITY_HEADERS });
      }
    }

    if (path === "/api/health" && (method === "GET" || method === "HEAD")) {
      return jsonResponse({ ok: true, service: "aurora-music", ts: Date.now() });
    }

    if (path === "/sw.js" && method === "GET") {
      return new Response(AURORA_SW_JS, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache, max-age=0, must-revalidate",
          "Service-Worker-Allowed": "/",
        },
      });
    }

    if (path === "/manifest.json" && method === "GET") {
      return jsonResponse({
        name: "Aurora Music",
        short_name: "AuroraMusic",
        start_url: "/",
        display: "standalone",
        background_color: "#07090e",
        theme_color: "#07090e",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
        ],
      });
    }

    if (path === "/icon.svg" && method === "GET") {
      return new Response(WOLF_LOGO_SVG, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // ---------- Main Web Application ----------
    if (path === "/" || path === "/index.html" || path === "/watch" || path === "/terms" || path === "/legal" || path === "/dmca" || path === "/app" || path === "/get-app" || path === "/download") {
      return new Response(AURORA_MUSIC_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          ...SECURITY_HEADERS,
          "Content-Security-Policy": "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; media-src 'self' blob: https: data:; img-src 'self' data: blob: https:;",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ------------------------------------------------------------
// Brand Assets & Vector Icons
// ------------------------------------------------------------
// ------------------------------------------------------------
// Service Worker: shell offline + auto-recuperacion
// Red-first en navegaciones: si no hay red sirve el shell cacheado
// (la app abre offline y muestra su propio aviso bonito).
// API (incluido /api/stream) NUNCA se cachea.
// ------------------------------------------------------------
const AURORA_SW_JS = `
// Aurora Music Service Worker
var SHELL_CACHE = 'aurora-shell-v1';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.add('/').catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return; // artwork/fonts externos: fuera
  if (url.pathname.indexOf('/api/') === 0) return; // APIs: siempre red

  if (req.mode === 'navigate') {
    // Red primero; sin red -> shell cacheado (adios "web sin conexion")
    e.respondWith(
      fetch(req).then(function (res) {
        try {
          var clone = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put('/', clone); }).catch(function () {});
        } catch (_) {}
        return res;
      }).catch(function () {
        return caches.open(SHELL_CACHE).then(function (c) {
          return c.match('/', { ignoreSearch: true, ignoreVary: true });
        }).then(function (shell) {
          if (shell) return shell;
          return new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        });
      })
    );
    return;
  }

  // Assets propios (icon.svg, manifest.json): cache-first con revalidacion
  e.respondWith(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) {
            try { var clone = res.clone(); c.put(req, clone).catch(function () {}); } catch (_) {}
          }
          return res;
        }).catch(function () { return hit || Response.error(); });
        return hit || net;
      });
    })
  );
});
`;

const WOLF_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <defs>
    <linearGradient id="auroraGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
    <filter id="neonBlur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <circle cx="50" cy="50" r="46" fill="#0d111a" stroke="url(#auroraGlow)" stroke-width="2"/>
  <path d="M50 16 L65 34 L78 28 L72 45 L82 54 L68 60 L62 76 L50 67 L38 76 L32 60 L18 54 L28 45 L22 28 L35 34 Z" fill="url(#auroraGlow)" filter="url(#neonBlur)"/>
  <path d="M37 46 L43 49 L39 52 Z M63 46 L57 49 L61 52 Z" fill="#07090e"/>
  <path d="M47 57 L53 57 L50 62 Z" fill="#38bdf8"/>
</svg>`;

// ------------------------------------------------------------
// Full SPA Frontend HTML + CSS + JS
// ------------------------------------------------------------

const AURORA_MUSIC_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
  <meta name="theme-color" content="#030303">
  <meta name="description" content="Aurora Music — Tu plataforma de música de alta fidelidad con audio Ultra HQ sin interrupciones.">
  <title>Aurora Music</title>
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <link rel="manifest" href="/manifest.json">
  <script src="https://www.youtube.com/iframe_api"></script>
  <style>
    :root {
      --bg: #030303;
      --surface: #0f0f0f;
      --surface-card: rgba(255, 255, 255, 0.04);
      --surface-hover: rgba(255, 255, 255, 0.08);
      --surface-active: rgba(255, 255, 255, 0.12);
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.35);
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.35);
      --accent: #10b981;
      --danger: #ef4444;
      --ytm-red: #ff0000;
      --ytm-heart: #f43f5e;
      --text: #f8fafc;
      --text-dim: #aaa;
      --text-muted: #717171;
      --sidebar-w: 240px;
      --player-h: 76px;
      --header-h: 64px;
    }
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
      -webkit-tap-highlight-color: transparent !important; 
      outline: none !important;
      -webkit-focus-ring-color: transparent !important;
    }
    *:focus, *:focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Oxygen, Ubuntu, Cantarell, sans-serif;
      overflow-x: hidden;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-user-select: none;
      -moz-user-select: none;
      -ms-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
    body.modal-open {
      overflow: hidden !important;
      height: 100vh !important;
      overscroll-behavior: none !important;
    }
    input, textarea {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      user-select: text !important;
    }
    ::selection {
      background: transparent;
    }
    /* Scrollbars */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.35); }

    /* Left Sidebar Navigation (Desktop YouTube Music style) */
    .ytm-sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: var(--player-h);
      width: var(--sidebar-w);
      background: #030303;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 16px 12px;
      z-index: 60;
    }
    .ytm-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px 22px;
      cursor: pointer;
      user-select: none;
    }
    .ytm-logo svg { width: 32px; height: 32px; filter: drop-shadow(0 0 10px var(--primary-glow)); }
    .ytm-logo-text { font-size: 19px; font-weight: 800; letter-spacing: -0.02em; color: #fff; }
    .ytm-logo-badge {
      font-size: 10px;
      font-weight: 700;
      color: var(--primary);
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid var(--border-accent);
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 2px;
    }
    .ytm-nav-group { display: flex; flex-direction: column; gap: 4px; }
    .ytm-nav-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 11px 16px;
      border-radius: 10px;
      color: #e2e8f0;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: transparent;
      border: none;
      transition: all 0.2s;
      width: 100%;
      text-align: left;
    }
    .ytm-nav-item:hover { background: var(--surface-hover); color: #fff; }
    .ytm-nav-item.active {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
      font-weight: 700;
    }
    .ytm-nav-divider {
      height: 1px;
      background: var(--border);
      margin: 14px 12px;
    }
    .ytm-sidebar-footer {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 12px;
    }

    /* Main Container */
    .ytm-main {
      margin-left: var(--sidebar-w);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding-bottom: calc(var(--player-h) + 40px);
    }

    /* Sticky Top Header */
    .ytm-header {
      position: sticky;
      top: 0;
      height: var(--header-h);
      background: rgba(3, 3, 3, 0.92);
      backdrop-filter: blur(24px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      z-index: 50;
      gap: 20px;
    }
    .ytm-mobile-brand {
      display: none;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .ytm-mobile-brand svg { width: 28px; height: 28px; }
    .ytm-mobile-brand span { font-weight: 800; font-size: 16px; color: #fff; }

    /* Pill Search Bar */
    .ytm-search-box {
      flex: 1;
      max-width: 520px;
      position: relative;
      display: flex;
      align-items: center;
    }
    .ytm-search-box input {
      width: 100%;
      height: 42px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 9999px;
      padding: 0 44px 0 42px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }
    .ytm-search-box input:focus {
      background: rgba(255, 255, 255, 0.14);
      border-color: var(--primary);
      box-shadow: 0 0 16px var(--primary-glow);
    }
    .ytm-search-icon {
      position: absolute;
      left: 14px;
      color: var(--text-dim);
      pointer-events: none;
    }
    .ytm-clear-btn {
      position: absolute;
      right: 14px;
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 18px;
      display: none;
    }
    .ytm-header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ytm-btn-pill {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      padding: 7px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .ytm-btn-pill:hover { background: rgba(255, 255, 255, 0.15); border-color: var(--primary); }

    /* Sticky Category Chips Row */
    .ytm-chips-bar {
      position: sticky;
      top: var(--header-h);
      background: rgba(3, 3, 3, 0.95);
      backdrop-filter: blur(16px);
      padding: 12px 28px;
      display: flex;
      gap: 10px;
      overflow-x: auto;
      z-index: 40;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .ytm-chip {
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid transparent;
      color: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .ytm-chip:hover, .ytm-chip.active {
      background: #fff;
      color: #030303;
    }

    /* Views */
    .ytm-content-wrap {
      padding: 24px 28px;
      flex: 1;
    }
    .view { display: none; }
    .view.active { display: block; animation: fadeIn 0.25s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* Section Headings */
    .ytm-sec-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      margin: 32px 0 16px;
    }
    .ytm-sec-header:first-child { margin-top: 0; }
    .ytm-sec-subtitle {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .ytm-sec-title {
      font-size: 22px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ytm-sec-action {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ytm-sec-action:hover {
      color: #fff;
      border-color: var(--primary);
      background: var(--surface-hover);
    }

    /* YouTube Music Quick Picks (3-row horizontal swipe carousel like YouTube Music mobile) */
    .ytm-quick-grid {
      display: grid;
      grid-auto-flow: column;
      grid-template-rows: repeat(3, 1fr);
      grid-auto-columns: min(84vw, 340px);
      gap: 10px 14px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 12px;
      margin-bottom: 28px;
      scrollbar-width: none;
    }
    .ytm-quick-grid::-webkit-scrollbar {
      display: none;
    }

    /* 4-Item Column Swipe Grid (4 rows per column: 4 and 4 side-by-side) */
    .ytm-quad-grid {
      display: grid;
      grid-auto-flow: column;
      grid-template-rows: repeat(4, 1fr);
      grid-auto-columns: min(88vw, 360px);
      gap: 10px 14px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 12px;
      margin-bottom: 28px;
      scrollbar-width: none;
    }
    .ytm-quad-grid::-webkit-scrollbar {
      display: none;
    }
    .ytm-quick-card {
      scroll-snap-align: start;
      display: flex;
      align-items: center;
      gap: 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }
    .ytm-quick-card:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.12);
    }
    .ytm-quick-card:active {
      transform: scale(0.98);
    }
    .ytm-quick-thumb-box {
      position: relative;
      width: 48px;
      height: 48px;
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .ytm-quick-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .ytm-quick-play-btn {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s;
      color: #fff;
    }
    .ytm-quick-card:hover .ytm-quick-play-btn { opacity: 1; }
    .ytm-quick-info { min-width: 0; flex: 1; }
    .ytm-quick-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }
    .ytm-quick-sub {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ytm-quick-opt-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      padding: 8px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
    }
    .ytm-quick-opt-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }

    /* Cards Grid (Trending, Áálbums, Mixed) */
    .ytm-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.25s;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .card:hover {
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-3px);
    }
    .card-thumb-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .card-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #111;
    }
    .card-rank-badge {
      position: absolute;
      top: 8px;
      left: 8px;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 6px;
    }
    .card-rank-badge.top-1 {
      background: linear-gradient(135deg, #eab308, #ca8a04);
      color: #000;
      border: none;
    }
    .card-rank-badge.top-2 {
      background: linear-gradient(135deg, #94a3b8, #64748b);
      color: #000;
      border: none;
    }
    .card-rank-badge.top-3 {
      background: linear-gradient(135deg, #b45309, #78350f);
      color: #fff;
      border: none;
    }
    .card-play-overlay {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: #fff;
      color: #030303;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: translateY(6px);
      transition: all 0.2s;
      box-shadow: 0 4px 14px rgba(0,0,0,0.6);
    }
    .card:hover .card-play-overlay {
      opacity: 1;
      transform: translateY(0);
    }
    .card-title {
      font-weight: 700;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
      color: #fff;
    }
    .card-artist {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Track List Table (Search / Charts / History) */
    .track-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .track-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-bottom: 4px;
    }
    .track-row:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .track-row.active {
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.3);
    }
    .track-row-index {
      width: 22px;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-dim);
      flex-shrink: 0;
    }
    .track-row-thumb-wrap {
      width: 48px;
      height: 48px;
      border-radius: 6px;
      overflow: hidden;
      position: relative;
      flex-shrink: 0;
      background: #111;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .track-row-thumb {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      display: block !important;
    }
    .track-row-play {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.15s ease;
      color: #fff;
    }
    .track-row:hover .track-row-play {
      opacity: 1;
    }
    .track-row-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .track-row-title {
      font-size: 14.5px;
      font-weight: 600;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-row.active .track-row-title {
      color: var(--primary);
    }
    .track-row-artist {
      font-size: 12.5px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-row-duration {
      font-size: 13px;
      color: var(--text-dim);
      flex-shrink: 0;
      padding: 0 8px;
    }
    .track-row-menu {
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 6px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .track-row-menu:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
    .track-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      flex: 1;
    }
    .track-rank-num {
      width: 24px;
      text-align: center;
      font-size: 14px;
      font-weight: 800;
      color: var(--text-muted);
    }
    .track-rank-num.top-1 { color: #eab308; }
    .track-rank-num.top-2 { color: #94a3b8; }
    .track-rank-num.top-3 { color: #b45309; }
    .track-cover {
      width: 44px;
      height: 44px;
      border-radius: 4px;
      object-fit: cover;
      background: #111;
      flex-shrink: 0;
    }
    .track-meta { min-width: 0; flex: 1; }
    .track-title {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-row.active .track-title { color: var(--primary); }
    .track-sub {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 6px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .icon-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
    .icon-btn.liked { color: var(--ytm-heart) !important; }
    .icon-btn.liked svg,
    .icon-btn.liked svg path {
      fill: var(--ytm-heart) !important;
      stroke: var(--ytm-heart) !important;
    }
    .r2-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      font-weight: 700;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 4px;
      padding: 1px 5px;
      margin-left: 6px;
      letter-spacing: 0.5px;
    }
    .track-dur {
      font-size: 12px;
      color: var(--text-dim);
      width: 45px;
      text-align: right;
    }

    /* Persistent Bottom Player Bar */
    .player-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: var(--player-h);
      background: #030303;
      border-top: 1px solid var(--border);
      display: none;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 90;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.7);
    }
    .player-bar.active, .player-bar.visible { display: flex; }

    /* Scrubber at top of player */
    .scrubber-container {
      position: absolute;
      top: -3px;
      left: 0;
      right: 0;
      height: 5px;
      background: rgba(255, 255, 255, 0.15);
      cursor: pointer;
    }
    .scrubber-progress {
      height: 100%;
      background: var(--ytm-red);
      width: 0%;
      position: relative;
      transition: width 0.1s linear;
    }
    .scrubber-container:hover { height: 8px; top: -4px; }
    .scrubber-container:hover .scrubber-progress::after {
      content: '';
      position: absolute;
      right: -5px;
      top: -3px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
    }

    .player-left {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 260px;
      min-width: 0;
      cursor: pointer;
    }
    .player-cover {
      width: 48px;
      height: 48px;
      border-radius: 4px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .player-info { min-width: 0; flex: 1; }
    .player-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .player-artist {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .player-center {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      flex: 1;
      max-width: 480px;
    }
    .player-controls {
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .play-btn {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: #fff;
      color: #030303;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s;
    }
    .play-btn:hover { transform: scale(1.08); }
    .time-display {
      font-size: 11px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
    }

    .player-right {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 260px;
      justify-content: flex-end;
    }
    .vol-container {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .vol-slider {
      width: 80px;
      accent-color: #fff;
      cursor: pointer;
    }

    /* Modal / Expanded Player */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(3, 3, 3, 0.88);
      backdrop-filter: blur(28px);
      z-index: 2000;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 30px;
    }
    .modal-overlay.active, .modal-overlay.open { display: flex; animation: fadeIn 0.25s ease-out; }
    #addToAlbumModal, #shareModal, #settingsModal, #createAlbumModal, #trackMenuModal { z-index: 2000 !important; }
    html.modal-open, body.modal-open {
      overflow: hidden !important;
      overscroll-behavior: none !important;
      touch-action: none !important;
      height: 100vh !important;
      position: fixed !important;
      width: 100% !important;
    }
    #settingsModal {
      overscroll-behavior: contain !important;
      touch-action: none !important;
    }
    .settings-modal-content {
      overscroll-behavior: contain !important;
      touch-action: pan-y !important;
      max-height: 85vh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    #legalModal { z-index: 2100 !important; }
    .modal-close {
      position: absolute;
      top: 24px;
      right: 24px;
      background: rgba(255,255,255,0.1);
      border: none;
      color: #fff;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 20px;
    }
    .modal-content {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .modal-big-cover {
      width: 280px;
      height: 280px;
      border-radius: 12px;
      object-fit: cover;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
      margin-bottom: 24px;
    }
    .modal-title { font-size: 22px; font-weight: 800; margin-bottom: 6px; color: #fff; }
    .modal-artist { font-size: 16px; color: var(--text-dim); margin-bottom: 24px; }

    /* YouTube Music Now Playing Bottom Sheet */
    .nowplaying-overlay {
      position: fixed;
      inset: 0;
      background: #030303;
      z-index: 120;
      display: flex;
      flex-direction: column;
      opacity: 0;
      pointer-events: none;
      transform: translateY(100%);
      transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
      overflow-y: auto;
      overscroll-behavior: contain !important;
      -webkit-overflow-scrolling: touch;
    }
    .nowplaying-overlay.active, .nowplaying-overlay.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    .nowplaying-sheet {
      width: 100%;
      max-width: 480px;
      margin: 0 auto;
      min-height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 16px 24px 32px;
      box-sizing: border-box;
    }
    .nowplaying-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      height: 48px;
    }
    .nowplaying-btn {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 8px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .nowplaying-btn:hover { background: rgba(255,255,255,0.1); }
    .nowplaying-hdr-center {
      text-align: center;
    }
    .nowplaying-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: var(--text-dim);
      text-transform: uppercase;
    }
    .nowplaying-art-wrap {
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 12px 0 20px;
      flex: 1;
    }
    .nowplaying-big-cover {
      width: 100%;
      max-width: 320px;
      aspect-ratio: 1/1;
      border-radius: 16px;
      object-fit: cover;
      box-shadow: 0 16px 45px rgba(0,0,0,0.9);
    }
    .nowplaying-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      margin-bottom: 18px;
    }
    .nowplaying-meta-left {
      flex: 1;
      overflow: hidden;
      padding-right: 12px;
    }
    .nowplaying-title {
      font-size: 20px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .nowplaying-artist {
      font-size: 14px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-modal-like {
      flex-shrink: 0;
      width: 44px;
      height: 44px;
    }
    .nowplaying-scrub-box {
      width: 100%;
      margin-bottom: 16px;
    }
    .nowplaying-slider {
      width: 100%;
      height: 4px;
      border-radius: 2px;
      accent-color: #38bdf8;
      background: rgba(255,255,255,0.2);
      cursor: pointer;
    }
    .nowplaying-times {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }
    .nowplaying-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0 8px;
      margin-bottom: 22px;
    }
    .nowplaying-ctrl-btn {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 10px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s, color 0.15s;
    }
    .nowplaying-ctrl-btn:hover { color: var(--primary); }
    .nowplaying-ctrl-btn:active { transform: scale(0.9); }
    .nowplaying-ctrl-btn.active { color: var(--primary); }
    .nowplaying-play-big {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #fff;
      color: #030303;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(255,255,255,0.25);
      transition: transform 0.15s;
    }
    .nowplaying-play-big:active { transform: scale(0.92); }
    .nowplaying-actions-row {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 14px;
      width: 100%;
      margin-top: 6px;
    }
    .nowplaying-action-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 22px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      backdrop-filter: blur(16px);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
    }
    .nowplaying-action-chip:hover {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.28);
      transform: translateY(-1px);
    }
    .nowplaying-action-chip:active {
      transform: scale(0.96);
      background: rgba(255, 255, 255, 0.22);
    }

    /* Track Context Menu Modal */
    .track-menu-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(8px);
      z-index: 130;
      display: none;
      align-items: flex-end;
      justify-content: center;
      overscroll-behavior: contain !important;
      touch-action: none;
    }
    .track-menu-overlay.active {
      display: flex;
      animation: fadeIn 0.18s ease-out;
    }
    .track-menu-sheet {
      width: 100%;
      max-width: 440px;
      background: #141414;
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
      padding: 20px;
      box-shadow: 0 -10px 40px rgba(0,0,0,0.85);
      border: 1px solid var(--border);
      border-bottom: none;
    }
    .track-menu-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }
    .track-menu-thumb {
      width: 48px;
      height: 48px;
      border-radius: 8px;
      object-fit: cover;
    }
    .track-menu-info {
      flex: 1;
      overflow: hidden;
    }
    .track-menu-title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-menu-artist {
      font-size: 13px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .track-menu-items {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .track-menu-btn {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 100%;
      padding: 12px 14px;
      background: none;
      border: none;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
    }
    .track-menu-btn:hover { background: rgba(255,255,255,0.08); }
    .track-menu-cancel {
      width: 100%;
      padding: 13px;
      margin-top: 10px;
      background: rgba(255,255,255,0.06);
      border: none;
      color: var(--text-dim);
      font-size: 14px;
      font-weight: 600;
      border-radius: 12px;
      cursor: pointer;
    }

    /* Spacious YouTube Music Settings Dialog */
    .settings-modal-content {
      width: 100%;
      max-width: 620px;
      max-height: 86vh;
      overflow-y: auto;
      background: #181818;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 18px;
      padding: 28px 32px 32px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.95);
      display: flex;
      flex-direction: column;
      gap: 22px;
      box-sizing: border-box;
      -webkit-overflow-scrolling: touch;
      position: relative;
    }
    .settings-modal-content::-webkit-scrollbar {
      width: 6px;
    }
    .settings-modal-content::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 3px;
    }

    .settings-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 4px;
    }
    .settings-title-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .settings-title-wrap h2 {
      font-size: 21px;
      font-weight: 800;
      color: #fff;
      letter-spacing: -0.3px;
      margin: 0;
    }
    .settings-close-btn {
      font-size: 26px;
      line-height: 1;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #aaa;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .settings-close-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      transform: scale(1.05);
    }

    .settings-card-section {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 14px;
      padding: 22px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: border-color 0.2s ease;
    }
    .settings-card-section:hover {
      border-color: rgba(255, 255, 255, 0.13);
    }
    .settings-sec-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .settings-sec-title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.2px;
    }
    .settings-sec-badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.06);
      color: #aaa;
      border: 1px solid rgba(255, 255, 255, 0.09);
    }
    .settings-sec-sub {
      font-size: 13.5px;
      color: #aaa;
      line-height: 1.6;
      margin: 0;
    }

    .ytm-lang-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 4px;
    }
    /* AURORA-MUSIC v2.8 — FIX: esta media query (max-width:520px) quedo abierta
       sin "}" y tragaba TODO el CSS posterior en anchos >520px (dropdowns de
       ajustes, /terms, toasts, overlay offline y la barra movil Home/Explore/
       Library/Settings que aparecia "blanca" abajo a la izquierda al activar
       modo PC en el navegador del celular). Reglas de abajo: top-level. */
    /* Compact YouTube Music Style Dropdowns */
    .ytm-dropdown-wrapper {
      position: relative;
      width: 100%;
    }
    .ytm-dropdown-btn {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #fff;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }
    .ytm-dropdown-btn:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.22);
    }
    .ytm-dropdown-pill-code {
      font-size: 11px;
      font-weight: 800;
      color: var(--primary);
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 3px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
    }
    .ytm-dropdown-val {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }
    .ytm-dropdown-chevron {
      color: #aaa;
      transition: transform 0.2s ease;
    }
    .ytm-dropdown-wrapper.open .ytm-dropdown-chevron {
      transform: rotate(180deg);
    }
    .ytm-dropdown-list {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: #222;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.9);
      z-index: 2050;
      max-height: 260px;
      overflow-y: auto;
      display: none;
      flex-direction: column;
      padding: 6px;
      gap: 2px;
      -webkit-overflow-scrolling: touch;
    }
    .ytm-dropdown-wrapper.open .ytm-dropdown-list {
      display: flex;
      animation: fadeIn 0.15s ease-out;
    }
    .ytm-dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-radius: 8px;
      cursor: pointer;
      color: #ccc;
      transition: all 0.15s ease;
    }
    .ytm-dropdown-item:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }
    .ytm-dropdown-item.active {
      background: rgba(56, 189, 248, 0.14);
      color: #fff;
    }
    .ytm-dropdown-item.active .ytm-dropdown-item-title {
      color: var(--primary);
    }
    .ytm-dropdown-item-title {
      font-size: 13.5px;
      font-weight: 600;
    }
    .ytm-dropdown-item-desc {
      font-size: 11.5px;
      color: #888;
      margin-top: 2px;
    }
    .ytm-dropdown-check {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      opacity: 0;
    }
    .ytm-dropdown-item.active .ytm-dropdown-check {
      opacity: 1;
    }

    /* Dedicated Terms / Legal Page (/terms) */
    .terms-page-container {
      max-width: 820px;
      margin: 0 auto;
      padding: 24px 20px 80px;
    }
    .terms-header-row {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .terms-back-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #fff;
      padding: 9px 16px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .terms-back-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      transform: translateX(-2px);
    }
    .terms-title-group h1 {
      font-size: 22px;
      font-weight: 800;
      color: #fff;
      margin: 0 0 6px 0;
      letter-spacing: -0.3px;
    }
    .terms-badges-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }
    .terms-content-box {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 28px 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    /* Legal & Copyright Contact Card */
    .settings-legal-contact-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(234, 67, 53, 0.08);
      border: 1px solid rgba(234, 67, 53, 0.22);
      border-radius: 12px;
      padding: 14px 18px;
      gap: 14px;
      margin-top: 4px;
    }
    @media (max-width: 540px) {
      .settings-legal-contact-box {
        flex-direction: column;
        align-items: flex-start;
      }
    }
    .settings-legal-contact-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #ea4335;
      color: #fff !important;
      text-decoration: none;
      padding: 9px 18px;
      border-radius: 9999px;
      font-size: 12.5px;
      font-weight: 700;
      transition: all 0.2s ease;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(234, 67, 53, 0.3);
    }
    .settings-legal-contact-btn:hover {
      background: #d93025;
      box-shadow: 0 4px 16px rgba(234, 67, 53, 0.45);
      transform: translateY(-1px);
    }

    /* Dedicated Legal Terms Modal */
    .legal-modal-content {
      width: 100%;
      max-width: 680px;
      max-height: 88vh;
      overflow-y: auto;
      background: #181818;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 18px;
      padding: 30px 36px 36px;
      box-shadow: 0 28px 72px rgba(0, 0, 0, 0.96);
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-sizing: border-box;
      -webkit-overflow-scrolling: touch;
      position: relative;
    }
    .legal-modal-content::-webkit-scrollbar {
      width: 6px;
    }
    .legal-modal-content::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 3px;
    }
    .legal-article {
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .legal-article:last-of-type {
      border-bottom: none;
      padding-bottom: 0;
    }
    .legal-article h3 {
      font-size: 15.5px;
      font-weight: 700;
      color: #fff;
      margin: 0 0 8px 0;
      letter-spacing: -0.2px;
    }
    .legal-article p {
      margin: 0 0 10px 0;
      color: #bbb;
      font-size: 13.5px;
      line-height: 1.65;
    }
    .legal-badge-pill {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.12);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.25);
      margin-right: 6px;
      margin-bottom: 6px;
    }

    /* AURORA-MUSIC v2.3 — Pagina "Obtener la app" */
    .app-cta-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: linear-gradient(135deg, #3ddc84, #26b96f);
      color: #06230f;
      text-decoration: none;
      font-size: 15.5px;
      font-weight: 800;
      padding: 15px 34px;
      border-radius: 9999px;
      cursor: pointer;
      box-shadow: 0 6px 24px rgba(61, 220, 132, 0.32);
      transition: all 0.2s ease;
    }
    .app-cta-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 32px rgba(61, 220, 132, 0.5);
      text-decoration: none;
    }
    .app-note-row {
      display: none;
      align-items: center;
      gap: 10px;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Toast */
    .app-toast {
      position: fixed;
      bottom: calc(var(--player-h) + 16px);
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(18, 18, 18, 0.96);
      border: 1px solid var(--border-accent);
      color: #fff;
      padding: 9px 18px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0,0,0,0.6), 0 0 15px var(--primary-glow);
      opacity: 0;
      pointer-events: none;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 99999;
    }
    .app-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Mobile Bottom Bar (< 900px) */
    .ytm-mobile-bar {
      display: none;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 60px;
      background: #030303;
      border-top: 1px solid var(--border);
      z-index: 85;
      justify-content: space-around;
      align-items: center;
      padding: 0 6px;
    }
    .ytm-mob-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      color: var(--text-dim);
      font-size: 10px;
      font-weight: 600;
      background: none;
      border: none;
      cursor: pointer;
      flex: 1;
      height: 100%;
    }
    .ytm-mob-item.active { color: #fff; }

    /* Responsive Queries */
    @media (max-width: 900px) {
      .ytm-sidebar { display: none; }
      .ytm-main { margin-left: 0; padding-bottom: calc(var(--player-h) + 68px); }
      .ytm-mobile-bar { display: flex; }
      .ytm-mobile-brand { display: flex; }
      .ytm-header { padding: 0 16px; }
      .ytm-chips-bar { padding: 10px 16px; }
      .ytm-content-wrap { padding: 16px; }
      .player-bar { bottom: 60px; }
      .player-left { width: 140px; }
      .player-right { display: none; }
      .app-toast { bottom: calc(var(--player-h) + 76px); }
      .ytm-header-actions .ytm-btn-pill span.pill-text { display: none; }
    }
      /* Áálbums horizontal scroll */
    .ytm-horizontal-scroll {
      display: flex;
      gap: 14px;
      overflow-x: auto;
      padding-bottom: 12px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
    }
    .ytm-horizontal-scroll::-webkit-scrollbar {
      height: 6px;
    }
    .ytm-horizontal-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 3px;
    }
    .ytm-aálbum-card {
      flex: 0 0 150px;
      max-width: 150px;
      scroll-snap-align: start;
      cursor: pointer;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      padding: 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      transition: background 0.2s, transform 0.2s, border-color 0.2s;
    }
    .ytm-aálbum-card:hover {
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-2px);
      border-color: rgba(56, 189, 248, 0.35);
    }
    .ytm-aálbum-thumb {
      width: 130px;
      height: 130px;
      border-radius: 8px;
      object-fit: cover;
      display: block;
      margin-bottom: 8px;
      background: #181818;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .ytm-aálbum-title {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.3;
    }
    .ytm-aálbum-sub {
      font-size: 11.5px;
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 3px;
    }
      /* YouTube Music Search Filter Tabs */
    .ytm-search-tabs {
      display: flex;
      gap: 10px;
      margin: 8px 0 20px 0;
      overflow-x: auto;
      padding-bottom: 4px;
      scrollbar-width: none;
    }
    .ytm-search-tabs::-webkit-scrollbar { display: none; }
    .ytm-search-tab {
      display: inline-flex;
      align-items: center;
      padding: 7px 18px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-dim);
      font-size: 13.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      white-space: nowrap;
    }
    .ytm-search-tab:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .ytm-search-tab.active {
      background: #f8fafc;
      color: #09090b;
      border-color: #f8fafc;
      font-weight: 600;
    }

    /* Search Artists List */
    .ytm-artists-search-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .ytm-artist-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .ytm-artist-card:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.12);
      transform: translateX(4px);
    }
    .ytm-artist-avatar {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      object-fit: cover;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.05);
    }
    .ytm-artist-info {
      flex: 1;
      min-width: 0;
    }
    .ytm-artist-name {
      font-size: 15px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ytm-artist-sub {
      font-size: 12.5px;
      color: var(--text-dim);
    }
    .ytm-artist-play-icon {
      color: var(--primary);
      opacity: 0;
      transform: scale(0.85);
      transition: all 0.2s;
    }
    .ytm-artist-card:hover .ytm-artist-play-icon {
      opacity: 1;
      transform: scale(1);
    }

    /* Search Aálbums Grid */
    .ytm-aálbums-search-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px;
      margin-top: 8px;
    }
    .ytm-search-aálbum-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
    }
    .ytm-search-aálbum-card:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-3px);
    }
    .ytm-search-aálbum-thumb {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 8px;
      object-fit: cover;
      margin-bottom: 10px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
      background: rgba(255, 255, 255, 0.05);
    }
    .ytm-search-aálbum-title {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ytm-search-aálbum-artist {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Library tabs & date headers */
    .library-tabs-bar {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .library-tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 20px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-dim);
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .library-tab-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .library-tab-btn.active {
      background: #fff;
      color: #030303;
      border-color: #fff;
    }
    .history-date-header {
      font-size: 13px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin: 24px 0 10px 4px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .history-date-header::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
    }

    /* Para Ti 4-Card Horizontal Slider */
    .ytm-cards-slider {
      display: flex;
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 12px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
    }
    .ytm-cards-slider::-webkit-scrollbar {
      height: 6px;
    }
    .ytm-cards-slider::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.16);
      border-radius: 3px;
    }
    .ytm-cards-slider .card {
      flex: 0 0 calc((100% - 48px) / 4);
      min-width: 175px;
      max-width: 250px;
      scroll-snap-align: start;
    }
    @media (max-width: 900px) {
      .ytm-cards-slider .card {
        flex: 0 0 calc((100% - 32px) / 3);
        min-width: 155px;
      }
    }
    @media (max-width: 600px) {
      .ytm-cards-slider .card {
        flex: 0 0 calc((100% - 16px) / 2.2);
        min-width: 140px;
      }
    }

    /* Custom Áálbums Grid & Cards in Library */
    .ytm-aálbums-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 18px;
    }
    @media (max-width: 600px) {
      .ytm-aálbums-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }
    }
    .ytm-user-aálbum-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .ytm-user-aálbum-card:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(56, 189, 248, 0.35);
      transform: translateY(-3px);
    }
    .ytm-user-aálbum-cover {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 10px;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 10px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }
    .ytm-user-aálbum-cover img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .ytm-user-aálbum-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }
    .ytm-user-aálbum-count {
      font-size: 12px;
      color: var(--text-dim);
    }

    /* Áálbum Detail View */
    .aálbum-detail-hdr {
      display: flex;
      gap: 24px;
      align-items: flex-end;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    @media (max-width: 600px) {
      .aálbum-detail-hdr {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
      }
    }
    .aálbum-detail-cover {
      width: 150px;
      height: 150px;
      border-radius: 14px;
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      flex-shrink: 0;
      overflow: hidden;
    }
    .aálbum-detail-cover img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .aálbum-detail-info {
      flex: 1;
    }
    .aálbum-detail-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }

    /* Search Recent List & Suggestions */
    .search-recent-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 24px;
    }
    .search-recent-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      transition: all 0.18s;
    }
    .search-recent-item:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.1);
    }
    .search-recent-left {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
    }
    .search-recent-left svg {
      color: var(--text-dim);
      flex-shrink: 0;
    }
    .search-recent-del {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 6px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.18s;
    }
    .search-recent-del:hover {
      color: #ef4444;
    }
    .search-suggest-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .search-suggest-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #fff;
      padding: 8px 16px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.18s;
    }
    .search-suggest-chip:hover {
      background: rgba(56, 189, 248, 0.14);
      border-color: var(--primary);
      transform: translateY(-1px);
    }
      /* YouTube Music Native Share Dialog */
    .ytm-share-dialog {
      width: 100%;
      max-width: 480px;
      background: #212121;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 20px 24px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.9);
      color: #fff;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .ytm-share-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ytm-share-title {
      font-size: 18px;
      font-weight: 500;
      color: #f1f1f1;
      margin: 0;
    }
    .ytm-share-close {
      background: none;
      border: none;
      color: #aaa;
      font-size: 26px;
      line-height: 1;
      cursor: pointer;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: all 0.15s;
    }
    .ytm-share-close:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }
    .ytm-share-apps {
      display: flex;
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 6px;
      -webkit-overflow-scrolling: touch;
    }
    .ytm-share-apps::-webkit-scrollbar { height: 4px; }
    .ytm-share-apps::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
    .ytm-share-app {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: #aaa;
      font-size: 12px;
      min-width: 56px;
      cursor: pointer;
      transition: transform 0.15s ease, color 0.15s ease;
    }
    .ytm-share-app:hover {
      transform: translateY(-2px);
      color: #fff;
    }
    .ytm-share-app-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .ytm-share-link-box {
      display: flex;
      align-items: center;
      background: #121212;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      padding: 4px 6px 4px 14px;
      gap: 8px;
    }
    .ytm-share-link-box input {
      flex: 1;
      background: transparent;
      border: none;
      color: #f1f1f1;
      font-size: 13.5px;
      outline: none;
      font-family: inherit;
      text-overflow: ellipsis;
    }
    .ytm-share-copy-btn {
      background: #3ea6ff;
      color: #030303;
      border: none;
      border-radius: 6px;
      padding: 8px 18px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .ytm-share-copy-btn:hover { background: #65b8ff; }
    .ytm-text-btn {
      background: none;
      border: none;
      color: #3ea6ff;
      padding: 6px 12px;
      border-radius: 18px;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: background 0.15s;
      text-transform: uppercase;
    }
    .ytm-text-btn:hover { background: rgba(62, 166, 255, 0.1); }
    /* ===== Offline mode: overlay boot + banner mid-session (YT Music style) ===== */
    #auroraOfflineOverlay { position: fixed; inset: 0; z-index: 2147483000; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 18px; background: rgba(3,3,3,0.97); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); text-align: center; padding: 32px; }
    #auroraOfflineOverlay.visible { display: flex; animation: auroraFadeIn .35s ease; }
    .aurora-offline-glow { width: 92px; height: 92px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle, rgba(56,189,248,0.16) 0%, rgba(3,3,3,0) 70%); border: 1px solid rgba(56,189,248,0.35); }
    .aurora-offline-glow svg { width: 40px; height: 40px; color: var(--primary); }
    .aurora-offline-title { font-size: 20px; font-weight: 700; letter-spacing: .3px; color: var(--text); }
    .aurora-offline-sub { font-size: 13.5px; color: var(--text-dim); max-width: 280px; line-height: 1.45; }
    .aurora-spin-ring { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid rgba(56,189,248,0.18); border-top-color: var(--primary); animation: auroraSpin 0.9s linear infinite; }
    .aurora-spin-ring-sm { width: 12px; height: 12px; border-width: 2px; }
    @keyframes auroraSpin { to { transform: rotate(360deg); } }
    @keyframes auroraFadeIn { from { opacity: 0; } to { opacity: 1; } }
    #auroraOfflineBanner { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--player-h) + 14px); z-index: 2147483000; display: none; align-items: center; gap: 10px; padding: 10px 18px; border-radius: 999px; background: rgba(15,15,15,0.94); border: 1px solid rgba(56,189,248,0.35); color: var(--text); font-size: 13px; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,0.55); pointer-events: none; }
    #auroraOfflineBanner.visible { display: flex; animation: auroraFadeIn .3s ease; }
    #auroraOfflineBanner svg { width: 16px; height: 16px; color: var(--primary); }
  </style>
</head>
<body>
  <div id="ytBridgeBox" style="position:fixed;bottom:-9999px;left:-9999px;width:1px;height:1px;opacity:0.01;pointer-events:none;"><div id="ytPlayer"></div></div>

  <!-- ===== Modo offline (estilo YT Music): boot sin conexion + auto-recuperacion ===== -->
  <div id="auroraOfflineOverlay">
    <svg width="46" height="46" viewBox="0 0 100 100" fill="none" style="opacity:.9;">
      <circle cx="50" cy="50" r="46" fill="#0d111a" stroke="#38bdf8" stroke-width="2"/>
      <path d="M50 16 L65 34 L78 28 L72 45 L82 54 L68 60 L62 76 L50 67 L38 76 L32 60 L18 54 L28 45 L22 28 L35 34 Z" fill="url(#auroraGradOff)"/>
      <defs>
        <linearGradient id="auroraGradOff" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#38bdf8"/>
          <stop offset="100%" stop-color="#818cf8"/>
        </linearGradient>
      </defs>
    </svg>
    <div class="aurora-offline-glow">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.78A4 4 0 0 1 19 14"/><path d="m5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
    </div>
    <div class="aurora-offline-title" data-i18n="offline">Sin conexi\u00f3n</div>
    <div class="aurora-spin-ring"></div>
    <div class="aurora-offline-sub" data-i18n="reconnecting">Reconectando autom\u00e1ticamente...</div>
  </div>
  <div id="auroraOfflineBanner">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.78A4 4 0 0 1 19 14"/><path d="m5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
    <span data-i18n="offline">Sin conexi\u00f3n</span>
    <span class="aurora-spin-ring aurora-spin-ring-sm"></span>
  </div>
  <script>
  /* Aurora Offline Controller: registra el Service Worker (la app abre sin
     conexion en vez de la pagina fea del WebView), muestra el overlay de
     boot o el banner de microcortes (tolerancia 4s) y al volver la red
     recarga y carga todo. Solo consulta /api/health. */
  (function () {
    'use strict';
    var OV = 'auroraOfflineOverlay';
    var BN = 'auroraOfflineBanner';
    var st = {
      dataReady: false, shown: false, mode: '', everShown: false,
      fails: 0, interval: null, tolerate: null, reloading: false
    };
    function setVisible(id, on) {
      var e = document.getElementById(id);
      if (e) { if (on) { e.classList.add('visible'); } else { e.classList.remove('visible'); } }
    }
    function show(mode) {
      st.shown = true; st.everShown = true; st.mode = mode;
      setVisible(OV, mode === 'overlay');
      setVisible(BN, mode === 'banner');
      if (!st.interval) { st.interval = setInterval(probe, 3000); }
    }
    function hide() {
      st.shown = false; st.mode = '';
      setVisible(OV, false);
      setVisible(BN, false);
      if (st.interval) { clearInterval(st.interval); st.interval = null; }
      if (st.tolerate) { clearTimeout(st.tolerate); st.tolerate = null; }
    }
    function tryReload() {
      if (st.reloading) return;
      try {
        var last = parseInt(sessionStorage.getItem('auroraOfflineReloadTs') || '0', 10) || 0;
        if (Date.now() - last < 20000) return;
        sessionStorage.setItem('auroraOfflineReloadTs', String(Date.now()));
      } catch (_) {}
      st.reloading = true;
      try { window.location.reload(); } catch (_) { st.reloading = false; }
    }
    function probe() {
      fetch('/api/health?_=' + Date.now(), { method: 'GET', cache: 'no-store' })
        .then(function (r) {
          if (r && r.ok) {
            st.fails = 0;
            if (st.shown) {
              hide();
              if (!st.dataReady && st.everShown) tryReload();
            }
          } else {
            st.fails++;
            if (st.fails >= 2 && !st.shown) show(st.dataReady ? 'banner' : 'overlay');
          }
        })
        .catch(function () {
          st.fails++;
          if (st.fails >= 2 && !st.shown) show(st.dataReady ? 'banner' : 'overlay');
        });
    }
    // Service Worker: shell offline (adios "web sin conexion" del WebView)
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
      }
    } catch (_) {}
    // Boot offline: overlay inmediato (la app queda "cargando" detras)
    if (navigator.onLine === false) show(st.dataReady ? 'banner' : 'overlay');
    window.addEventListener('offline', function () {
      if (st.shown) return;
      if (st.tolerate) clearTimeout(st.tolerate);
      st.tolerate = setTimeout(function () {
        st.tolerate = null;
        if (!st.shown) show(st.dataReady ? 'banner' : 'overlay');
      }, 4000);
    });
    window.addEventListener('online', function () {
      if (st.tolerate) { clearTimeout(st.tolerate); st.tolerate = null; }
      probe();
    });
    window.__auroraOffline = {
      setDataReady: function () {
        st.dataReady = true;
        if (st.shown && st.mode === 'overlay') hide();
      },
      reportNetFail: function () {
        if (!st.interval) { st.interval = setInterval(probe, 2500); }
        probe();
      }
    };
  })();
  </script>

  <!-- Left Sidebar (Desktop YouTube Music) -->
  <aside class="ytm-sidebar">
    <div class="ytm-logo" onclick="switchView('home')">
      <svg viewBox="0 0 100 100" fill="none">
        <circle cx="50" cy="50" r="46" fill="#0d111a" stroke="#38bdf8" stroke-width="2"/>
        <path d="M50 16 L65 34 L78 28 L72 45 L82 54 L68 60 L62 76 L50 67 L38 76 L32 60 L18 54 L28 45 L22 28 L35 34 Z" fill="url(#auroraGradSidebar)"/>
        <defs>
          <linearGradient id="auroraGradSidebar" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8"/>
            <stop offset="100%" stop-color="#818cf8"/>
          </linearGradient>
        </defs>
      </svg>
      <span class="ytm-logo-text">Aurora</span>
      <span class="ytm-logo-badge">Music</span>
    </div>

    <nav class="ytm-nav-group">
      <button class="ytm-nav-item active" id="tab-home" onclick="switchView('home')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <span data-i18n="home">Home</span>
      </button>
      <button class="ytm-nav-item" id="tab-explore" onclick="switchView('explore')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        <span data-i18n="explore">Explore</span>
      </button>
      <button class="ytm-nav-item" id="tab-library" onclick="switchView('library')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        <span data-i18n="library">Library</span>
      </button>
    </nav>
      <button class="ytm-nav-item" id="tab-terms" onclick="navigateToTerms()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span data-i18n="termsNav">Terms & DMCA</span>
      </button>
      <!-- AURORA-MUSIC v2.3 — Obtener la app (oculto dentro de la APK nativa) -->
      <button class="ytm-nav-item" id="tab-app" onclick="navigateToApp()" style="display:none;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#3ddc84"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5S2 17.33 2 16.5v-7C2 8.67 2.67 8 3.5 8zm17 0c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5v-7c0-.83.67-1.5 1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.19-.51-.19-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.95 0-1.85.23-2.66.63L7.85.15c-.2-.19-.51-.19-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.74 3.23 6 5.08 6 7h12c0-1.92-.74-3.76-1.97-5.14zM9.5 5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zm5 0c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5z"/></svg>
        <span data-i18n="getAppNav">Obtener la app</span>
      </button>

    

    <div class="ytm-nav-divider"></div>

    <nav class="ytm-nav-group">
      <button class="ytm-nav-item" onclick="switchView('library')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#f43f5e" stroke="#f43f5e" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span data-i18n="favoritesTitle">Liked songs</span>
      </button>
    </nav>
  </aside>

  <!-- Main View Container -->
  <div class="ytm-main">

    <!-- Top Navigation Bar -->
    <header class="ytm-header">
      <div class="ytm-mobile-brand" onclick="switchView('home')">
        <svg viewBox="0 0 100 100" fill="none">
          <circle cx="50" cy="50" r="46" fill="#0d111a" stroke="#38bdf8" stroke-width="2"/>
          <path d="M50 16 L65 34 L78 28 L72 45 L82 54 L68 60 L62 76 L50 67 L38 76 L32 60 L18 54 L28 45 L22 28 L35 34 Z" fill="url(#auroraGradHdr)"/>
          <defs>
            <linearGradient id="auroraGradHdr" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#38bdf8"/>
              <stop offset="100%" stop-color="#818cf8"/>
            </linearGradient>
          </defs>
        </svg>
        <span>Aurora</span>
      </div>

      <!-- Pill Search Box -->
      <div class="ytm-search-box">
        <svg class="ytm-search-icon" id="searchSubmitBtn" style="cursor:pointer;" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="text" id="searchInput" placeholder="Search songs, artists, genres or albums..." data-i18n-placeholder="searchPlaceholder" autocomplete="off">
        <button class="ytm-clear-btn" id="searchClear" onclick="clearSearch()">&times;</button>
      </div>

      <!-- Header Actions -->
      <div class="ytm-header-actions">
        <button class="icon-btn" onclick="openSettingsModal('general')" title="Configuración" data-i18n-title="settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </header>

    <!-- YouTube Music Sticky Mood Chips Bar -->
    <div class="ytm-chips-bar" id="homeChips"></div>

    <div class="ytm-content-wrap">

      <!-- View: Home -->
      <div class="view active" id="view-home">
        
        <!-- Mood Category Feed (Appears directly on Home when clicking a mood chip, e.g. 'Para entrenar') -->
        <div id="homeMoodFeed" style="display:none;margin-top:4px;">
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" id="homeMoodSub" data-i18n="moodCurated">Música seleccionada para este momento</div>
              <h2 class="ytm-sec-title" id="homeMoodTitle">Para entrenar</h2>
            </div>
            <button class="ytm-btn-pill" onclick="resetMoodChips()" style="background:rgba(255,255,255,0.08);color:var(--text);font-size:12px;padding:6px 14px;">
              &larr; <span data-i18n="backToHome">Inicio</span>
            </button>
          </div>
          <div class="track-list" id="homeMoodList"></div>
        </div>

        <!-- Default Home Sections Wrapper -->
        <div id="homeDefaultSections">
          <!-- 1. Vuelve a escuchar (Quick Picks from History or Curated) -->
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="quickPicksSub">Tus accesos rápidos</div>
              <h2 class="ytm-sec-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
                <span data-i18n="quickPicks">Vuelve a escuchar</span>
              </h2>
            </div>
          </div>
          <div class="ytm-quick-grid" id="homeQuickPicksGrid"></div>

          <!-- 2. Recomendado Para Ti (Slider de 4 cartas deslizable) -->
          <div id="secRecommended" style="display:none;">
            <div class="ytm-sec-header">
              <div>
                <div class="ytm-sec-subtitle" data-i18n="recommendedMixSub">Joyas de tu historial</div>
                <h2 class="ytm-sec-title">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                  <span data-i18n="recommendedMix">Para Ti</span>
                </h2>
              </div>
            </div>
            <div class="ytm-cards-slider" id="homeRecommendedGrid"></div>
          </div>

          <!-- 3. Tendencias Globales -->
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="trendingSub">Los ééxitos virales del momento</div>
              <h2 class="ytm-sec-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
                <span data-i18n="trending">Tendencias globales</span>
              </h2>
            </div>
            <button class="ytm-sec-action" onclick="switchView('explore')">
              <span data-i18n="explore">Ver más</span> &rarr;
            </button>
          </div>
          <div class="ytm-quad-grid" id="homeTrendingGrid"></div>

          <!-- 4. Catálogo Ultra HQ (R2) -->
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="topCatalogSub">Audio lossless sin compresión</div>
              <h2 class="ytm-sec-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span data-i18n="topCatalog">Ééxitos Ultra HQ (R2)</span>
              </h2>
            </div>
          </div>
          <div class="ytm-quad-grid" id="homeGrid"></div>
        </div>

      </div>

      <!-- View: Explore / Trending -->
      <div class="view" id="view-explore">
        <div class="ytm-sec-header">
          <div>
            <div class="ytm-sec-subtitle" data-i18n="trendingSub">Los ééxitos virales del momento</div>
            <h2 class="ytm-sec-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
              <span data-i18n="trending">Tendencias y Ééxitos del Momento</span>
            </h2>
          </div>
        </div>
        <div class="ytm-quad-grid" id="exploreTrendingList"></div>
      </div>

            <!-- View: Search Results & Recent History -->
      <!-- View: Search Results & Recent History -->
      <div class="view" id="view-search">
        <!-- Dedicated Recent Searches Box -->
        <div id="searchRecentContainer">
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="activityLog">Búsquedas recientes</div>
              <h2 class="ytm-sec-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span data-i18n="recentSearches">Historial de búsqueda</span>
              </h2>
            </div>
            
          </div>
          <div class="search-recent-list" id="searchRecentList"></div>

          <!-- Suggested / Popular Searches -->
          <div class="ytm-sec-header" style="margin-top:20px;">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="trendingSub">Descubre música</div>
              <h2 class="ytm-sec-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
                <span data-i18n="trendingSearches">Búsquedas sugeridas</span>
              </h2>
            </div>
          </div>
          <div class="search-suggest-chips" id="searchSuggestChips"></div>
        </div>

        <!-- Search Results Box -->
                <div id="searchResultsContainer" style="display:none;">
          <!-- YouTube Music Search Filter Tabs -->
          <div class="ytm-search-tabs">
            <button class="ytm-search-tab active" id="searchTabBtnSongs" onclick="switchSearchTab('songs')">
              <span data-i18n="searchTabSongs">Canciones</span>
            </button>
            <button class="ytm-search-tab" id="searchTabBtnAlbums" onclick="switchSearchTab('albums')">
              <span data-i18n="searchTabAlbums">Álbumes</span>
            </button>
            <button class="ytm-search-tab" id="searchTabBtnArtists" onclick="switchSearchTab('artists')">
              <span data-i18n="searchTabArtists">Artistas</span>
            </button>
          </div>

          <!-- Tab Content: Canciones -->
          <div id="searchSectionSongs">
            <div class="track-list" id="searchResultsList"></div>
          </div>

          <!-- Tab Content: Álbumes -->
          <div id="searchSectionAlbums" style="display:none;">
            <div class="ytm-albums-search-grid" id="searchAlbumsGrid"></div>
          </div>

          <!-- Tab Content: Artistas -->
          <div id="searchSectionArtists" style="display:none;">
            <div class="ytm-artists-search-list" id="searchArtistsList"></div>
          </div>
        </div>
      </div>

      <!-- View: Library (Likes, Álbumes, History tabs) -->
      <div class="view" id="view-library">
        <!-- Sub-tabs in Library -->
        <div class="library-tabs-bar">
          <button class="library-tab-btn active" id="libTabLikes" onclick="switchLibraryTab('likes')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#f43f5e" stroke="#f43f5e" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span data-i18n="favoritesTitle">Tus Canciones Favoritas</span>
          </button>
          <button class="library-tab-btn" id="libTabAlbums" onclick="switchLibraryTab('albums')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
            <span data-i18n="albums">Álbumes</span>
          </button>
          <button class="library-tab-btn" id="libTabHistory" onclick="switchLibraryTab('history')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span data-i18n="recentHistory">Escuchadas recientemente</span>
          </button>
        </div>

        <!-- Section 1: Likes Tab Content -->
        <div id="libSectionLikes">
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="personalCollection">Colección personal</div>
              <h2 class="ytm-sec-title" data-i18n="songsYouLike">Canciones que te gustan</h2>
            </div>
            <span class="ytm-btn-pill" id="likesCountBadge">0 guardadas</span>
          </div>
          <div class="track-list" id="libLikesList"></div>
        </div>

        <!-- Section 2: Custom Álbumes Tab Content -->
        <div id="libSectionAlbums" style="display:none;">
          <!-- Álbumes Overview -->
          <div id="libAlbumsMain">
            <div class="ytm-sec-header">
              <div>
                <div class="ytm-sec-subtitle" data-i18n="albumsSub">Colección de álbumes personalizados</div>
                <h2 class="ytm-sec-title" data-i18n="myAlbums">Tus Álbumes</h2>
              </div>
              <button class="ytm-btn-pill" onclick="openCreateAlbumModal()" style="background:var(--primary);color:#030303;border-color:var(--primary);font-weight:700;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:4px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span data-i18n="createAlbum">Crear Álbum</span>
              </button>
            </div>
            <div class="ytm-albums-grid" id="libAlbumsGrid"></div>
          </div>

          <!-- Álbum Detail Subview (Inside Álbumes Tab) -->
          <div id="userAlbumDetail" style="display:none;">
            <button class="ytm-btn-pill" onclick="closeUserAlbumDetail()" style="margin-bottom:16px;">
              &larr; <span data-i18n="backToAlbums">Volver a Álbumes</span>
            </button>
            <div class="album-detail-hdr">
              <div class="album-detail-cover" id="albumDetailCover">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
              </div>
              <div class="album-detail-info">
                <div class="ytm-sec-subtitle" data-i18n="customAlbum">Álbum personalizado</div>
                <h1 style="font-size:26px;font-weight:800;color:#fff;margin:4px 0 8px 0;" id="albumDetailTitle">Nombre del Álbum</h1>
                <div style="font-size:13px;color:var(--text-dim);" id="albumDetailMeta">0 canciones</div>
                <div class="album-detail-actions">
                  <button class="ytm-btn-pill" id="btnPlayAlbumAll" onclick="playCurrentAlbum()" style="background:#fff;color:#030303;font-weight:700;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:4px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <span data-i18n="playAll">Reproducir todo</span>
                  </button>
                  <button class="ytm-btn-pill" onclick="promptAddTracksToAlbum()" style="background:rgba(56,189,248,0.14);border-color:var(--primary);color:var(--primary);">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <span data-i18n="searchAndAddSongs">Buscar y agregar canciones</span>
                  </button>
                  <button class="ytm-btn-pill" onclick="deleteCurrentAlbum()" style="background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);color:#ef4444;">
                    <span data-i18n="deleteAlbum">Eliminar Álbum</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="track-list" id="albumDetailTrackList"></div>
          </div>
        </div>

        <!-- Section 3: History Tab Content (Grouped by Date) -->
        <div id="libSectionHistory" style="display:none;">
          <div class="ytm-sec-header">
            <div>
              <div class="ytm-sec-subtitle" data-i18n="activityLog">Registro de actividad</div>
              <h2 class="ytm-sec-title" data-i18n="playbackHistory">Historial de reproducción</h2>
            </div>
            
          </div>
          <div id="historyDateGroupedContainer"></div>
        </div>
      </div>
      <!-- View: Terms & Legal (/terms) -->
      <div class="view" id="view-terms">
        <div class="terms-page-container">
          <div class="terms-header-row">
            <button class="terms-back-btn" onclick="navigateToHome()" title="Volver">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              <span data-i18n="back">Back</span>
            </button>
            <div class="terms-title-group">
              <h1 data-i18n="legalModalTitle">Legal Notice, DMCA & Terms of Service</h1>
              <div class="terms-badges-row">
                <span class="legal-badge-pill" data-i18n="legalBadgeSafeHarbor">DMCA Safe Harbor 17 U.S.C. &sect; 512</span>
                <span class="legal-badge-pill" data-i18n="legalBadgeEU">Directive (EU) 2019/790</span>
                <span class="legal-badge-pill" data-i18n="legalBadgeBerne">Berne Convention</span>
                <span class="legal-badge-pill" style="color:#10b981;border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);" data-i18n="legalBadgeMereConduit">Technical Intermediary (Mere Conduit)</span>
              </div>
            </div>
          </div>
          <div class="terms-content-box" id="termsPageContent"></div>
        </div>
      </div>

      <!-- AURORA-MUSIC v2.3 — Vista: Obtener la app (instalacion Android) -->
      <div class="view" id="view-app">
        <div class="terms-page-container" style="max-width:780px;">

          <div class="terms-header-row">
            <button class="terms-back-btn" onclick="navigateToHome()">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              <span data-i18n="back">Volver</span>
            </button>
            <div class="terms-title-group">
              <h1 data-i18n="appPageTitle">Aurora Music para Android</h1>
              <div class="terms-badges-row">
                <span class="legal-badge-pill" style="color:#3ddc84;border-color:rgba(61,220,132,0.3);background:rgba(61,220,132,0.1);" data-i18n="appDownloadMeta">Versi&oacute;n 1.0.0 &middot; ~102 MB &middot; Android 7.0+</span>
              </div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:14px;">

            <!-- Nota: ya dentro de la app nativa -->
            <div class="app-note-row" id="appInstalledNote" style="background:rgba(61,220,132,0.1);border:1px solid rgba(61,220,132,0.3);color:#7ce6ae;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="2.2" style="flex-shrink:0;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <span data-i18n="appInstalledNote">Ya tienes Aurora Music instalada &mdash; la est&aacute;s usando ahora mismo.</span>
            </div>

            <!-- Nota: no es Android (iOS / escritorio) -->
            <div class="app-note-row" id="appOtherPlatformNote" style="background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);color:#a5d8f7;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span data-i18n="appOtherPlatformNote">La app de Aurora Music est&aacute; disponible solo para Android. En iPhone, iPad o computadora, sigue disfrutando de la misma experiencia en la web.</span>
            </div>

            <!-- Hero + CTA de descarga directa -->
            <div id="appDownloadCard" style="background:linear-gradient(160deg, rgba(61,220,132,0.1), rgba(56,189,248,0.05) 55%, rgba(0,0,0,0));border:1px solid rgba(61,220,132,0.18);border-radius:20px;padding:34px 24px;text-align:center;">
              <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:16px;">
                <svg width="56" height="56" viewBox="0 0 100 100" fill="none" style="flex-shrink:0;">
                  <circle cx="50" cy="50" r="46" fill="#0d111a" stroke="url(#auroraGradApp)" stroke-width="2"/>
                  <path d="M50 16 L65 34 L78 28 L72 45 L82 54 L68 60 L62 76 L50 67 L38 76 L32 60 L18 54 L28 45 L22 28 L35 34 Z" fill="url(#auroraGradApp)"/>
                  <defs><linearGradient id="auroraGradApp" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient></defs>
                </svg>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="#3ddc84" style="flex-shrink:0;"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5S2 17.33 2 16.5v-7C2 8.67 2.67 8 3.5 8zm17 0c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5v-7c0-.83.67-1.5 1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.19-.51-.19-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.95 0-1.85.23-2.66.63L7.85.15c-.2-.19-.51-.19-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.74 3.23 6 5.08 6 7h12c0-1.92-.74-3.76-1.97-5.14zM9.5 5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zm5 0c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5z"/></svg>
              </div>
              <h2 style="font-size:23px;font-weight:800;color:#fff;margin:0 0 10px;letter-spacing:-0.3px;" data-i18n="appPageTitle">Aurora Music para Android</h2>
              <p style="font-size:14.5px;color:#bbb;line-height:1.6;margin:0 auto 24px;max-width:540px;" data-i18n="appPageSub">Toda tu m&uacute;sica en una app nativa: controles desde la notificaci&oacute;n, reproducci&oacute;n en segundo plano y la misma experiencia de la web.</p>
              <a class="app-cta-btn" id="appDownloadBtn" href="https://github.com/DevAuroraX/Aurora-Music/releases/latest/download/AuroraMusic.v1.0.0.apk" rel="noopener">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span data-i18n="appDownloadBtn">Descargar APK</span>
              </a>
              <div style="margin-top:14px;font-size:12.5px;color:#717171;" data-i18n="appDownloadMeta">Versi&oacute;n 1.0.0 &middot; ~102 MB &middot; Android 7.0+</div>
            </div>

            <!-- Pasos de instalacion -->
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:24px;">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <h3 style="font-size:15.5px;font-weight:800;color:#fff;margin:0;" data-i18n="appStepsTitle">C&oacute;mo instalar</h3>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:12px;">
                <div style="flex:1 1 200px;min-width:180px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;">
                  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <span style="width:26px;height:26px;border-radius:9999px;background:rgba(61,220,132,0.15);border:1px solid rgba(61,220,132,0.35);color:#3ddc84;font-size:12.5px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">1</span>
                    <span style="font-size:13.5px;font-weight:700;color:#fff;" data-i18n="appStep1Title">Descarga el APK</span>
                  </div>
                  <p style="font-size:12.5px;color:#999;line-height:1.55;margin:0;" data-i18n="appStep1Desc">Toca el bot&oacute;n y la descarga empieza al instante, sin p&aacute;ginas externas.</p>
                </div>
                <div style="flex:1 1 200px;min-width:180px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;">
                  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <span style="width:26px;height:26px;border-radius:9999px;background:rgba(61,220,132,0.15);border:1px solid rgba(61,220,132,0.35);color:#3ddc84;font-size:12.5px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">2</span>
                    <span style="font-size:13.5px;font-weight:700;color:#fff;" data-i18n="appStep2Title">Abre el archivo</span>
                  </div>
                  <p style="font-size:12.5px;color:#999;line-height:1.55;margin:0;" data-i18n="appStep2Desc">&Aacute;brelo desde la notificaci&oacute;n o desde tu app de archivos.</p>
                </div>
                <div style="flex:1 1 200px;min-width:180px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;">
                  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <span style="width:26px;height:26px;border-radius:9999px;background:rgba(61,220,132,0.15);border:1px solid rgba(61,220,132,0.35);color:#3ddc84;font-size:12.5px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">3</span>
                    <span style="font-size:13.5px;font-weight:700;color:#fff;" data-i18n="appStep3Title">Permite e instala</span>
                  </div>
                  <p style="font-size:12.5px;color:#999;line-height:1.55;margin:0;" data-i18n="appStep3Desc">Android te pedir&aacute; permiso de instalar apps de esta fuente. Ac&eacute;ptalo y listo.</p>
                </div>
              </div>
            </div>

            <!-- Seguridad + GitHub -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:rgba(16,185,129,0.07);border:1px solid rgba(16,185,129,0.22);border-radius:14px;padding:14px 18px;">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" style="flex-shrink:0;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span style="font-size:12.5px;color:#9fd8c4;line-height:1.5;" data-i18n="appSecurityNote">APK firmada oficialmente &mdash; instalaci&oacute;n directa desde GitHub, sin tiendas externas.</span>
              </div>
              <a href="https://github.com/DevAuroraX/Aurora-Music/releases" target="_blank" rel="noopener" style="padding:9px 18px;font-size:13px;font-weight:700;background:rgba(255,255,255,0.07);color:#fff;border:1px solid rgba(255,255,255,0.16);cursor:pointer;border-radius:9999px;display:flex;align-items:center;gap:7px;transition:all 0.2s ease;text-decoration:none;flex-shrink:0;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                <span data-i18n="appGithubBtn">Ver en GitHub</span>
              </a>
            </div>

          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- Mobile Bottom Tab Bar -->
  <nav class="ytm-mobile-bar">
    <button class="ytm-mob-item active" id="mob-home" onclick="switchView('home')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <span data-i18n="home">Home</span>
    </button>
    <button class="ytm-mob-item" id="mob-explore" onclick="switchView('explore')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
      <span data-i18n="explore">Explore</span>
    </button>
    <button class="ytm-mob-item" id="mob-library" onclick="switchView('library')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
      <span data-i18n="library">Library</span>
    </button>
    <button class="ytm-mob-item" id="mob-settings" onclick="openSettingsModal('general')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span data-i18n="settings">Settings</span>
    </button>
  </nav>

  <!-- Persistent Bottom Player Bar (YouTube Music Style) -->
  <div class="player-bar" id="playerBar">
    <div class="scrubber-container" id="scrubber">
      <div class="scrubber-progress" id="progressBar"></div>
    </div>

    <div class="player-left" onclick="openExpandedPlayer()">
      <img class="player-cover" id="playerCover" src="" alt="Cover">
      <div class="player-info">
        <div class="player-title" id="playerTitle">—</div>
        <div class="player-artist" id="playerArtist">—</div>
      </div>
    </div>

    <div class="player-center">
      <div class="player-controls">
        <button class="icon-btn" onclick="toggleShuffle()" id="btnShuffle" title="Aleatorio" data-i18n-title="shuffle">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
        <button class="icon-btn" onclick="prevTrack()" title="Anterior" data-i18n-title="previous">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="play-btn" id="playBtn" onclick="togglePlay()" title="Reproducir" data-i18n-title="play">
          <svg id="playIcon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <svg id="pauseIcon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="icon-btn" onclick="nextTrack()" title="Siguiente" data-i18n-title="next">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="icon-btn" onclick="toggleRepeat()" id="btnRepeat" title="Repetir" data-i18n-title="repeat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
      </div>
      <div class="time-display">
        <span id="currentTime">0:00</span> / <span id="totalDuration">0:00</span>
      </div>
    </div>

    <div class="player-right">
      <!-- Like Heart Button -->
      <button class="icon-btn" id="btnPlayerLike" onclick="toggleCurrentLike()" title="Me gusta" data-i18n-title="likeTitle">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>

      <!-- Volume Slider -->
      <div class="vol-container">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        <input class="vol-slider" type="range" min="0" max="1" step="0.01" value="0.9" oninput="setVolume(this.value)">
      </div>
    </div>
  </div>

  <!-- Settings & Language Modal -->
  <div class="modal-overlay" id="settingsModal" onclick="closeSettingsModal(event)">
    <div class="settings-modal-content" onclick="event.stopPropagation()">
      <div class="settings-modal-header">
        <div class="settings-title-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <h2 data-i18n="settings">Settings</h2>
        </div>
        <button class="settings-close-btn" onclick="closeSettingsModal()" title="Cerrar">&times;</button>
      </div>

      <!-- Section: Language Selection (Dropdown) -->
      <div class="settings-card-section">
        <div class="settings-sec-hdr">
          <div style="display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            <span class="settings-sec-title" data-i18n="languageSelect">Interface Language</span>
          </div>
          <span class="settings-sec-badge" data-i18n="languagesCount">12 languages</span>
        </div>
        <p class="settings-sec-sub" data-i18n="languageSelectSub">Choose your preferred language for the entire interface.</p>
        
        <div class="ytm-dropdown-wrapper" id="langDropdownWrap">
          <button type="button" class="ytm-dropdown-btn" id="langDropdownTrigger" onclick="toggleLangDropdown(event)">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="ytm-dropdown-pill-code" id="langSelectedCode">EN</span>
              <span class="ytm-dropdown-val" id="langSelectedName">English</span>
            </div>
            <svg class="ytm-dropdown-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ytm-dropdown-list" id="langDropdownMenu"></div>
        </div>
      </div>

      <!-- Section: Audio Quality (Dropdown) -->
      <div class="settings-card-section">
        <div class="settings-sec-hdr">
          <div style="display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>
            <span class="settings-sec-title" data-i18n="audioQuality">Audio Quality</span>
          </div>
          <span class="settings-sec-badge" id="qualityHeaderBadge" style="background:rgba(56,189,248,0.15);color:var(--primary);border-color:rgba(56,189,248,0.3);">Lossless HQ</span>
        </div>
        <p class="settings-sec-sub" data-i18n="audioQualityDesc">Adaptive low-latency streaming with edge acceleration up to 256kbps AAC / Lossless FLAC in R2.</p>
        
        <div class="ytm-dropdown-wrapper" id="qualityDropdownWrap">
          <button type="button" class="ytm-dropdown-btn" id="qualityDropdownTrigger" onclick="toggleQualityDropdown(event)">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="ytm-dropdown-pill-code" id="qualitySelectedBadge">ULTRA HQ</span>
              <span class="ytm-dropdown-val" id="qualitySelectedLabel">Lossless FLAC</span>
            </div>
            <svg class="ytm-dropdown-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ytm-dropdown-list" id="qualityDropdownMenu"></div>
        </div>
      </div>

      <!-- Section: Terms & Legal Navigation Link -->
      <div class="settings-card-section" style="padding:14px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:38px;height:38px;border-radius:10px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:#fff;" data-i18n="termsNav">Terms & DMCA</div>
              <div style="font-size:12px;color:#888;" data-i18n="termsSub">Legal notice, copyright & policies</div>
            </div>
          </div>
          <button type="button" class="ytm-btn-pill" onclick="navigateToTerms()" style="padding:9px 18px;font-size:13px;font-weight:700;background:rgba(56,189,248,0.12);color:var(--primary);border:1px solid rgba(56,189,248,0.28);cursor:pointer;border-radius:9999px;display:flex;align-items:center;gap:6px;transition:all 0.2s ease;">
            <span data-i18n="openTermsPageBtn">Read All (/terms)</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>

      <!-- Section: Discord Community -->
      <div class="settings-card-section" style="padding:14px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:38px;height:38px;border-radius:10px;background:rgba(88,101,242,0.12);border:1px solid rgba(88,101,242,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.22 14.22 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z"/></svg>
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:#fff;" data-i18n="discordNav">Comunidad de Discord</div>
              <div style="font-size:12px;color:#888;" data-i18n="discordSub">Novedades, peticiones de canciones y soporte en el server oficial</div>
            </div>
          </div>
          <button type="button" class="ytm-btn-pill" onclick="window.open('https://discord.gg/pU9ckzwsut','_blank','noopener')" style="padding:9px 18px;font-size:13px;font-weight:700;background:rgba(88,101,242,0.14);color:#8b95ff;border:1px solid rgba(88,101,242,0.35);cursor:pointer;border-radius:9999px;display:flex;align-items:center;gap:6px;transition:all 0.2s ease;">
            <span data-i18n="discordJoinBtn">Entrar al Discord</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
      <!-- AURORA-MUSIC v2.3 — Seccion: Obtener la app (solo navegadores) -->
      <div class="settings-card-section" id="getAppSection" style="padding:14px 16px;display:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:38px;height:38px;border-radius:10px;background:rgba(61,220,132,0.1);border:1px solid rgba(61,220,132,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#3ddc84"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5S2 17.33 2 16.5v-7C2 8.67 2.67 8 3.5 8zm17 0c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5v-7c0-.83.67-1.5 1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.19-.51-.19-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.95 0-1.85.23-2.66.63L7.85.15c-.2-.19-.51-.19-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.74 3.23 6 5.08 6 7h12c0-1.92-.74-3.76-1.97-5.14zM9.5 5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zm5 0c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5z"/></svg>
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:#fff;" data-i18n="getAppNav">Obtener la app</div>
              <div style="font-size:12px;color:#888;" data-i18n="getAppSub">Instala Aurora Music en tu Android &mdash; instalaci&oacute;n directa y segura</div>
            </div>
          </div>
          <button type="button" class="ytm-btn-pill" onclick="navigateToApp()" style="padding:9px 18px;font-size:13px;font-weight:700;background:rgba(61,220,132,0.12);color:#3ddc84;border:1px solid rgba(61,220,132,0.3);cursor:pointer;border-radius:9999px;display:flex;align-items:center;gap:6px;transition:all 0.2s ease;">
            <span data-i18n="getAppSettingsBtn">Instalar</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal: Terminos y Condiciones Legales / DMCA Safe Harbor -->
  <div class="modal-overlay" id="legalModal" onclick="closeLegalModal(event)">
    <div class="legal-modal-content" onclick="event.stopPropagation()">
      <div class="settings-modal-header" style="margin-bottom:14px;">
        <div class="settings-title-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <h2 style="font-size:19px;font-weight:800;color:#fff;" data-i18n="legalModalTitle">Legal Notice, DMCA & Terms of Service</h2>
        </div>
        <button class="settings-close-btn" onclick="closeLegalModal()" title="Cerrar">&times;</button>
      </div>

      <div class="terms-badges-row" style="margin-bottom:12px;">
        <span class="legal-badge-pill" data-i18n="legalBadgeSafeHarbor">DMCA Safe Harbor 17 U.S.C. &sect; 512</span>
        <span class="legal-badge-pill" data-i18n="legalBadgeEU">Directive (EU) 2019/790</span>
        <span class="legal-badge-pill" data-i18n="legalBadgeBerne">Berne Convention</span>
        <span class="legal-badge-pill" style="color:#10b981;border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);" data-i18n="legalBadgeMereConduit">Technical Intermediary (Mere Conduit)</span>
      </div>

      <!-- Container for dynamic translated articles -->
      <div id="legalModalArticles"></div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <button type="button" class="ytm-btn-pill" onclick="closeLegalModal()" style="padding:10px 24px;font-size:13px;font-weight:700;background:var(--primary);color:#030303;border:none;border-radius:9999px;cursor:pointer;">
          <span data-i18n="legalAcceptBtn">Understood & Accept</span>
        </button>
      </div>
    </div>
  </div>
  <!-- YouTube Music Now Playing Bottom Sheet / Modal -->
  <div class="nowplaying-overlay" id="expandedModal">
    <div class="nowplaying-sheet">
      <!-- Sheet Header Bar with Chevron Down to hide/collapse -->
      <div class="nowplaying-hdr">
        <button class="nowplaying-btn" onclick="closeExpandedPlayer()" title="Ocultar reproductor">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="nowplaying-hdr-center">
          <span class="nowplaying-tag" data-i18n="nowPlayingTag">REPRODUCIENDO</span>
        </div>
        <button class="nowplaying-btn" onclick="openTrackMenu(currentTrack)" title="Opciones" data-i18n-title="moreOptions">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>

      <!-- Artwork Box -->
      <div class="nowplaying-art-wrap">
        <img class="nowplaying-big-cover" id="modalCover" src="" alt="Áálbum Art">
      </div>

      <!-- Track Info Row -->
      <div class="nowplaying-meta-row">
        <div class="nowplaying-meta-left">
          <h2 class="nowplaying-title" id="modalTitle">—</h2>
          <p class="nowplaying-artist" id="modalArtist">—</p>
        </div>
        <button class="icon-btn btn-modal-like" id="btnModalLike" onclick="toggleCurrentLike()" title="Me gusta" data-i18n-title="likeTitle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
      </div>

      <!-- Scrubber Timeline -->
      <div class="nowplaying-scrub-box">
        <input type="range" class="nowplaying-slider" id="modalSlider" min="0" max="100" value="0" step="0.1" oninput="onModalScrubInput(this.value)" onchange="onModalScrubChange(this.value)">
        <div class="nowplaying-times">
          <span id="modalTimeElapsed">0:00</span>
          <span id="modalTimeTotal">0:00</span>
        </div>
      </div>

      <!-- Media Controls -->
      <div class="nowplaying-controls">
        <button class="nowplaying-ctrl-btn" id="modalBtnShuffle" onclick="toggleShuffle()" title="Aleatorio" data-i18n-title="shuffle">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
        <button class="nowplaying-ctrl-btn" onclick="prevTrack()" title="Anterior" data-i18n-title="previous">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="3"/></svg>
        </button>
        <button class="nowplaying-play-big" onclick="togglePlay()" title="Reproducir / Pausa" data-i18n-title="play">
          <svg id="modalPlayIcon" width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          <svg id="modalPauseIcon" width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="nowplaying-ctrl-btn" onclick="nextTrack()" title="Siguiente" data-i18n-title="next">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="3"/></svg>
        </button>
        <button class="nowplaying-ctrl-btn" id="modalBtnRepeat" onclick="toggleRepeat()" title="Repetir" data-i18n-title="repeat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
      </div>

    </div>
  </div>

    <!-- Track Action Menu Bottom Sheet (3-Dots Menu) -->
  <div class="track-menu-overlay" id="trackMenuModal" onclick="closeTrackMenu(event)">
    <div class="track-menu-sheet" onclick="event.stopPropagation()">
      <div class="track-menu-header">
        <img class="track-menu-thumb" id="menuTrackThumb" src="" alt="Thumb">
        <div class="track-menu-info">
          <div class="track-menu-title" id="menuTrackTitle">-</div>
          <div class="track-menu-artist" id="menuTrackArtist">-</div>
        </div>
      </div>
      <div class="track-menu-items">
        <button class="track-menu-btn" onclick="menuPlayCurrent()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span data-i18n="playNow">Reproducir ahora</span>
        </button>
        <button class="track-menu-btn" onclick="menuToggleLike()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span id="menuLikeText" data-i18n="addToFavorites">Añadir a Favoritos</span>
        </button>
        <button class="track-menu-btn" onclick="openAddToAlbumModal()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
          <span data-i18n="addToAlbum">Guardar en un Álbum</span>
        </button>
        <button class="track-menu-btn" onclick="openShareModal()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          <span data-i18n="share">Compartir</span>
        </button>
      </div>
      <button class="track-menu-cancel" onclick="closeTrackMenu()" data-i18n="cancel">Cancelar</button>
    </div>
  </div>

  <!-- Modal: Compartir (YouTube Music Style) -->
  <div class="modal-overlay" id="shareModal" onclick="closeShareModal(event)">
    <div class="ytm-share-dialog" onclick="event.stopPropagation()">
      <div class="ytm-share-header">
        <h3 class="ytm-share-title" data-i18n="share">Compartir</h3>
        <button class="ytm-share-close" onclick="closeShareModal()" title="Cerrar">&times;</button>
      </div>
      <!-- Social Media Share Icons -->
      <div class="ytm-share-apps">
        <a class="ytm-share-app" id="shareBtnWhatsapp" href="#" target="_blank" rel="noopener noreferrer">
          <div class="ytm-share-app-icon" style="background:#25D366;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2zm0 18.14c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.196 8.196 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.83c.02 4.54-3.68 8.23-8.22 8.23zm4.52-6.17c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43s-.56-1.34-.76-1.84c-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.84-.86 2.05s.88 2.38 1 2.55c.12.17 1.74 2.65 4.21 3.72.59.25 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.07-.11-.23-.17-.48-.3z"/></svg>
          </div>
          <span>WhatsApp</span>
        </a>
        <a class="ytm-share-app" id="shareBtnTwitter" href="#" target="_blank" rel="noopener noreferrer">
          <div class="ytm-share-app-icon" style="background:#000;border:1px solid #333;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </div>
          <span>X</span>
        </a>
        <a class="ytm-share-app" id="shareBtnFacebook" href="#" target="_blank" rel="noopener noreferrer">
          <div class="ytm-share-app-icon" style="background:#1877F2;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          </div>
          <span>Facebook</span>
        </a>
        <a class="ytm-share-app" id="shareBtnTelegram" href="#" target="_blank" rel="noopener noreferrer">
          <div class="ytm-share-app-icon" style="background:#229ED9;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
          </div>
          <span>Telegram</span>
        </a>
        <a class="ytm-share-app" id="shareBtnEmail" href="#" target="_blank" rel="noopener noreferrer">
          <div class="ytm-share-app-icon" style="background:#5f6368;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
          </div>
          <span>Correo</span>
        </a>
      </div>
      <!-- YouTube Music URL Link Box -->
      <div class="ytm-share-link-box">
        <input type="text" id="shareLinkInput" readonly onclick="this.select()" />
        <button class="ytm-share-copy-btn" id="shareCopyBtn" onclick="copyShareModalLink()">
          <span id="shareCopyBtnText" data-i18n="copyLinkBtn">Copiar</span>
        </button>
      </div>
    </div>
  </div>
  <!-- Modal: Guardar en Álbum -->
  <div class="modal-overlay" id="addToAlbumModal" onclick="closeAddToAlbumModal(event)">
    <div class="settings-modal-content" style="max-width:440px;" onclick="event.stopPropagation()">
      <div class="settings-modal-header">
        <div class="settings-title-wrap">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
          <h2 data-i18n="addToAlbum">Guardar en un Álbum</h2>
        </div>
        <button class="settings-close-btn" onclick="closeAddToAlbumModal()">&times;</button>
      </div>
      <div style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:var(--text-dim);" data-i18n="selectAlbumOrCreate">Selecciona un Álbum o crea uno:</span>
        <button class="ytm-btn-pill" onclick="openCreateAlbumModal(true)" style="font-size:11.5px;padding:5px 12px;background:var(--primary);color:#030303;font-weight:700;">+ Nuevo</button>
      </div>
      <div id="addToAlbumList" style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;"></div>
    </div>
  </div>
  <!-- Modal: Crear Álbum (v2.0.1: elemento repuesto; el JS/CSS ya lo esperaban) -->
  <div class="modal-overlay" id="createAlbumModal" onclick="closeCreateAlbumModal(event)">
    <div class="settings-modal-content" style="max-width:440px;" onclick="event.stopPropagation()">
      <div class="settings-modal-header">
        <div class="settings-title-wrap">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
          <h2 data-i18n="createAlbum">Crear Álbum</h2>
        </div>
        <button class="settings-close-btn" onclick="closeCreateAlbumModal()" title="Cerrar">&times;</button>
      </div>
      <div style="padding:6px 20px 20px 20px;">
        <input type="text" id="createAlbumInput" placeholder="Nombre del nuevo álbum:" data-i18n-placeholder="albumNamePrompt" maxlength="60" autocomplete="off" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.05);color:#fff;font-size:14px;outline:none;" onkeydown="if(event.key==='Enter')submitCreateAlbum()">
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="ytm-btn-pill" onclick="closeCreateAlbumModal()" style="padding:9px 18px;font-size:13px;"><span data-i18n="cancel">Cancelar</span></button>
          <button type="button" class="ytm-btn-pill" onclick="submitCreateAlbum()" style="padding:9px 18px;font-size:13px;background:var(--primary);color:#030303;border-color:var(--primary);font-weight:700;"><span data-i18n="createAlbum">Crear Álbum</span></button>
        </div>
      </div>
    </div>
  </div>
  <div id="appToast" class="app-toast"></div>
  <audio id="audioEngine" preload="auto"></audio>
  <div id="ytPlayerContainer" style="position:fixed;bottom:0;right:0;width:200px;height:200px;opacity:0.01;pointer-events:none;z-index:-10;overflow:hidden;"></div>
</body>
</html>

  <!-- Client-Side App Logic (Multilingual, YouTube Music Engine, IndexedDB) -->
  <script>
    // --------------------------------------------------------
    // Multilingual Translations (12 Languages - Unicode Safe)
    // --------------------------------------------------------
    const I18N = {
      es: {
        code: "ES",
        langName: "Espa\u00f1ol",
        home: "Inicio",
        explore: "Explorar",
        library: "Biblioteca",
        offline: "Sin conexi\u00f3n",
        reconnecting: "Reconectando autom\u00e1ticamente...",
        settings: "Configuraci\u00f3n",
        searchPlaceholder: "Buscar canciones, artistas, g\u00e9neros o \u00e1lbumes...",
        quickPicks: "Vuelve a escuchar",
        quickPicksSub: "Tus accesos r\u00e1pidos",
        recommendedMix: "Para Ti",
        recommendedMixSub: "Joyas de tu historial",
        trending: "Tendencias globales",
        trendingSub: "Los \u00e9xitos virales del momento",
        topCatalog: "\u00c9xitos Ultra HQ (R2)",
        topCatalogSub: "Audio lossless sin compresi\u00f3n",
        recentHistory: "Historial reciente",
        playbackHistory: "Historial de reproducci\u00f3n",
        recentHistoryEmpty: "Tus canciones reproducidas aparecer\u00e1n aqu\u00ed autom\u00e1ticamente.",
        favoritesTitle: "Tus Canciones Favoritas",
        personalCollection: "Colecci\u00f3n personal",
        songsYouLike: "Canciones que te gustan",
        savedSongs: "guardadas",
        savedSong: "guardada",
        favoritesEmpty: "A\u00f1ade canciones a tus favoritos para guardarlas aqu\u00ed.",
        savedInDevice: "guardadas",
        downloadDevice: "Descargar al dispositivo",
        languageSelect: "Idioma de la interfaz",
        languagesCount: "12 idiomas",
        audioQuality: "Calidad de audio",
        audioQualityDesc: "Streaming adaptativo de alta fidelidad hasta 256kbps AAC / Lossless FLAC en R2.",
        qualityHigh: "Alta",
        qualityNormal: "Normal",
        qualityData: "Ahorro",
        aboutSubtitle: "Audio de alta fidelidad sin interrupciones",
        dataAndPrivacy: "Datos y Privacidad",
        searchHistory: "Historial de b\u00fasqueda",
        clearSearchHistoryDesc: "Elimina tus b\u00fasquedas de texto recientes",
        clearPlaybackHistoryDesc: "Elimina las canciones escuchadas de tu biblioteca",
        clearHistory: "Borrar historial",
        clearHistoryConfirm: "\u00bfEliminar todo tu historial de reproducci\u00f3n?",
        historyCleared: "Historial eliminado",
        noHistoryYet: "No has escuchado ninguna canci\u00f3n a\u00fan.",
        likedToast: "A\u00f1adido a tus favoritos",
        unlikedToast: "Eliminado de favoritos",
        downloadStarting: "Descargando...",
        downloadComplete: "Descargado",
        downloadUnavailable: "Esta canci\u00f3n solo est\u00e1 disponible para reproducci\u00f3n en l\u00ednea",
        cat_all: "Todos",
        cat_workout: "Para entrenar",
        cat_energy: "Energ\u00eda",
        cat_relax: "Relajaci\u00f3n",
        cat_focus: "Para concentrarse",
        cat_party: "De fiesta",
        cat_commute: "En el auto",
        cat_rock: "Rock",
        cat_urban: "Trap & Urbano",
        albums: "\u00c1lbumes",
        myAlbums: "Tus \u00c1lbumes",
        albumsSub: "Colecci\u00f3n de \u00e1lbumes personalizados",
        customAlbum: "\u00c1lbum personalizado",
        createAlbum: "Crear \u00e1lbum",
        albumNamePrompt: "Nombre del nuevo \u00e1lbum:",
        albumCreatedToast: "\u00c1lbum creado con \u00e9xito",
        albumDeletedToast: "\u00c1lbum eliminado",
        trackAddedToast: "Canci\u00f3n guardada en el \u00e1lbum",
        trackRemovedToast: "Canci\u00f3n eliminada del \u00e1lbum",
        noAlbumsYet: "No tienes \u00e1lbumes creados a\u00fan.",
        noAlbumsHint: "Crea tu primer \u00e1lbum para organizar tu m\u00fasica favorita.",
        playAll: "Reproducir todo",
        deleteAlbum: "Eliminar \u00e1lbum",
        deleteAlbumConfirm: "\u00bfSeguro que deseas eliminar este \u00e1lbum?",
        emptyAlbum: "Este \u00e1lbum est\u00e1 vac\u00edo.",
        emptyAlbumHint: "Busca canciones y haz clic en los 3 puntos para agregarlas aqu\u00ed.",
        addToAlbum: "Guardar en un \u00e1lbum",
        selectAlbumOrCreate: "Selecciona un \u00e1lbum o crea uno:",
        recentSearches: "B\u00fasquedas recientes",
        clearSearchHistory: "Borrar historial",
        suggestedSearches: "B\u00fasquedas sugeridas",
        searchHint: "Busca tus artistas, canciones o \u00e1lbumes favoritos...",
        noResults: "No se encontraron resultados para tu b\u00fasqueda.",
        playNow: "Reproducir ahora",
        downloadSong: "Descargar canci\u00f3n",
        addToFavorites: "A\u00f1adir a Favoritos",
        removeFromFavorites: "Quitar de Favoritos",
        copyLink: "Copiar enlace",
        linkCopiedToast: "Enlace copiado al portapapeles",
        cancel: "Cancelar",
        searchTabSongs: "Canciones",
        searchTabAlbums: "\u00c1lbumes",
        searchTabArtists: "Artistas",
        moodCurated: "M\u00fasica seleccionada para este momento",
        backToHome: "Inicio",
        artistTracksCount: "temas",
        share: "Compartir",
        copyLinkBtn: "Copiar",
        nowPlayingTag: "REPRODUCIENDO",
        languageSelectSub: "Elige tu idioma preferido para toda la interfaz.",
        rightsAndSecurity: "Derechos de Autor, DMCA y Seguridad",
        dmcaSectionDesc: "Aurora Music opera como un motor de b\u00fasqueda e indexador t\u00e9cnico de contenidos p\u00fablicos de libre acceso (\u0027mere conduit\u0027). No alojamos grabaciones no autorizadas en servidores centrales y cumplimos rigurosamente con la DMCA (17 U.S.C. \u00a7 512) y la Directiva (UE) 2019/790.",
        legalContactTitle: "Canal Oficial para Titulares y Plataformas",
        legalContactSub: "Reclamaciones o consultas de derechos:",
        contactGmailBtn: "Contactar por Gmail",
        takedownNotice: "Retirada expedita en 24 a 48 horas tras notificaci\u00f3n motivada.",
        viewFullTermsBtn: "Ver en Modal",
        openTermsPageBtn: "Leer todo (/terms)",
        termsSub: "Aviso legal, derechos de autor y pol\u00edticas",
        legalModalTitle: "Aviso Legal, DMCA y T\u00e9rminos de Servicio",
        legalBadgeSafeHarbor: "DMCA Safe Harbor 17 U.S.C. \u00a7 512",
        legalBadgeEU: "Directiva (UE) 2019/790",
        legalBadgeBerne: "Convenio de Berna",
        legalBadgeMereConduit: "Mero Intermediario T\u00e9cnico",
        legalAcceptBtn: "Entendido y Aceptar",
        discordNav: "Comunidad de Discord",
        discordSub: "Novedades, peticiones de canciones y soporte en el server oficial",
        discordJoinBtn: "Entrar al Discord",
        termsNav: "T\u00e9rminos y DMCA",
        back: "Volver",
        getAppNav: "Obtener la app",
        getAppSub: "Instala Aurora Music en tu Android \u2014 instalaci\u00f3n directa y segura",
        getAppSettingsBtn: "Instalar",
        appPageTitle: "Aurora Music para Android",
        appPageSub: "Toda tu m\u00fasica en una app nativa: controles desde la notificaci\u00f3n, reproducci\u00f3n en segundo plano y la misma experiencia de la web.",
        appDownloadBtn: "Descargar APK",
        appDownloadMeta: "Versi\u00f3n 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "C\u00f3mo instalar",
        appStep1Title: "Descarga el APK",
        appStep1Desc: "Toca el bot\u00f3n y la descarga empieza al instante, sin p\u00e1ginas externas.",
        appStep2Title: "Abre el archivo",
        appStep2Desc: "\u00c1brelo desde la notificaci\u00f3n o desde tu app de archivos.",
        appStep3Title: "Permite e instala",
        appStep3Desc: "Android te pedir\u00e1 permiso de instalar apps de esta fuente. Ac\u00e9ptalo y listo.",
        appSecurityNote: "APK firmada oficialmente \u2014 instalaci\u00f3n directa desde GitHub, sin tiendas externas.",
        appOtherPlatformNote: "La app de Aurora Music est\u00e1 disponible solo para Android. En iPhone, iPad o computadora, sigue disfrutando de la misma experiencia en la web.",
        appInstalledNote: "Ya tienes Aurora Music instalada \u2014 la est\u00e1s usando ahora mismo.",
        appGithubBtn: "Ver en GitHub",
      },
      en: {
        code: "EN",
        langName: "English",
        home: "Home",
        explore: "Explore",
        library: "Library",
        offline: "Offline",
        reconnecting: "Reconnecting automatically...",
        settings: "Settings",
        searchPlaceholder: "Search songs, artists, genres or albums...",
        quickPicks: "Listen Again",
        quickPicksSub: "Your quick picks",
        recommendedMix: "For You",
        recommendedMixSub: "Gems from your history",
        trending: "Global Trends",
        trendingSub: "Viral hits right now",
        topCatalog: "Ultra HQ Hits (R2)",
        topCatalogSub: "Lossless uncompressed audio",
        recentHistory: "Recent History",
        playbackHistory: "Playback History",
        recentHistoryEmpty: "Played tracks will automatically show up here.",
        favoritesTitle: "Your Favorite Songs",
        personalCollection: "Personal Collection",
        songsYouLike: "Songs You Like",
        savedSongs: "saved",
        savedSong: "saved",
        favoritesEmpty: "Add tracks to your favorites to save them here.",
        savedInDevice: "saved",
        downloadDevice: "Download to device",
        languageSelect: "Interface Language",
        languagesCount: "12 languages",
        audioQuality: "Audio Quality",
        audioQualityDesc: "High-fidelity adaptive streaming up to 256kbps AAC / Lossless FLAC on R2.",
        qualityHigh: "High",
        qualityNormal: "Normal",
        qualityData: "Saver",
        aboutSubtitle: "High-fidelity audio streaming without interruptions",
        dataAndPrivacy: "Data & Privacy",
        searchHistory: "Search History",
        clearSearchHistoryDesc: "Clear your recent text queries",
        clearPlaybackHistoryDesc: "Remove played songs from your library",
        clearHistory: "Clear history",
        clearHistoryConfirm: "Clear all playback history?",
        historyCleared: "History cleared",
        noHistoryYet: "You haven't listened to any song yet.",
        likedToast: "Added to favorites",
        unlikedToast: "Removed from favorites",
        downloadStarting: "Downloading...",
        downloadComplete: "Downloaded",
        downloadUnavailable: "This song is currently available for online streaming only",
        cat_all: "All",
        cat_workout: "Workout",
        cat_energy: "Energy",
        cat_relax: "Relax",
        cat_focus: "Focus",
        cat_party: "Party",
        cat_commute: "Commute",
        cat_rock: "Rock",
        cat_urban: "Trap & Urban",
        albums: "Albums",
        myAlbums: "Your Albums",
        albumsSub: "Custom albums collection",
        customAlbum: "Custom Album",
        createAlbum: "Create album",
        albumNamePrompt: "New album name:",
        albumCreatedToast: "Album created successfully",
        albumDeletedToast: "Album deleted",
        trackAddedToast: "Song added to album",
        trackRemovedToast: "Song removed from album",
        noAlbumsYet: "No custom albums yet.",
        noAlbumsHint: "Create an album to organize your favorite music.",
        playAll: "Play all",
        deleteAlbum: "Delete album",
        deleteAlbumConfirm: "Are you sure you want to delete this album?",
        emptyAlbum: "This album is empty.",
        emptyAlbumHint: "Search songs and click the 3 dots to add them here.",
        addToAlbum: "Save to an album",
        selectAlbumOrCreate: "Select an album or create a new one:",
        recentSearches: "Recent searches",
        clearSearchHistory: "Clear history",
        suggestedSearches: "Suggested searches",
        searchHint: "Search your favorite artists, songs or albums...",
        noResults: "No results found for your search.",
        playNow: "Play now",
        downloadSong: "Download song",
        addToFavorites: "Add to Favorites",
        removeFromFavorites: "Remove from Favorites",
        copyLink: "Copy link",
        linkCopiedToast: "Link copied to clipboard",
        cancel: "Cancel",
        searchTabSongs: "Songs",
        searchTabAlbums: "Albums",
        searchTabArtists: "Artists",
        nowPlayingTag: "NOW PLAYING",
        share: "Share",
        copyLinkBtn: "Copy",
        languageSelectSub: "Choose your preferred language for the entire interface.",
        rightsAndSecurity: "Copyright, DMCA & Security",
        dmcaSectionDesc: "Aurora Music operates as an open search engine and technical streaming indexer (\u0027mere conduit\u0027). We do not host unauthorized recordings on central servers and strictly comply with the DMCA (17 U.S.C. \u00a7 512) and Directive (EU) 2019/790.",
        legalContactTitle: "Official Channel for Rights Holders & Platforms",
        legalContactSub: "Claims or copyright inquiries:",
        contactGmailBtn: "Contact via Gmail",
        takedownNotice: "Expeditious takedown within 24 to 48 hours upon substantiated notice.",
        viewFullTermsBtn: "View in Modal",
        openTermsPageBtn: "Read All (/terms)",
        termsSub: "Legal notice, copyright & policies",
        legalModalTitle: "Legal Notice, DMCA & Terms of Service",
        legalBadgeSafeHarbor: "DMCA Safe Harbor 17 U.S.C. \u00a7 512",
        legalBadgeEU: "Directive (EU) 2019/790",
        legalBadgeBerne: "Berne Convention",
        legalBadgeMereConduit: "Technical Intermediary (Mere Conduit)",
        legalAcceptBtn: "Understood & Accept",
        discordNav: "Discord Community",
        discordSub: "News, song requests and support on the official server",
        discordJoinBtn: "Join Discord",
        termsNav: "Terms & DMCA",
        back: "Back",
        moodCurated: "Curated music for this moment",
        backToHome: "Home",
        artistTracksCount: "tracks",
        getAppNav: "Get the app",
        getAppSub: "Install Aurora Music on your Android \u2014 direct and secure",
        getAppSettingsBtn: "Install",
        appPageTitle: "Aurora Music for Android",
        appPageSub: "All your music in a native app: notification controls, background playback and the same experience as the web.",
        appDownloadBtn: "Download APK",
        appDownloadMeta: "Version 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "How to install",
        appStep1Title: "Download the APK",
        appStep1Desc: "Tap the button and the download starts instantly \u2014 no external pages.",
        appStep2Title: "Open the file",
        appStep2Desc: "Open it from the notification or from your Files app.",
        appStep3Title: "Allow & install",
        appStep3Desc: "Android will ask for permission to install from this source. Accept it and you are done.",
        appSecurityNote: "Officially signed APK \u2014 direct install from GitHub, no external stores.",
        appOtherPlatformNote: "The Aurora Music app is available for Android only. On iPhone, iPad or desktop, keep enjoying the same experience on the web.",
        appInstalledNote: "You already have Aurora Music installed \u2014 you are using it right now.",
        appGithubBtn: "View on GitHub",
      },
      pt: {
        code: "PT",
        langName: "Portugu\u00eas",
        home: "In\u00edcio",
        explore: "Explorar",
        library: "Biblioteca",
        offline: "Sem conex\u00e3o",
        reconnecting: "Reconectando automaticamente...",
        settings: "Configura\u00e7\u00f5es",
        searchPlaceholder: "Pesquisar m\u00fasicas, artistas ou \u00e1lbuns...",
        quickPicks: "Ouvir novamente",
        quickPicksSub: "Acessos r\u00e1pidos",
        recommendedMix: "Para Voc\u00ea",
        recommendedMixSub: "Joias do seu hist\u00f3rico",
        trending: "Em alta",
        trendingSub: "Sucessos do momento",
        topCatalog: "\u00c9xitos Ultra HQ (R2)",
        topCatalogSub: "\u00c1udio lossless sem compress\u00e3o",
        recentHistory: "Hist\u00f3rico recente",
        playbackHistory: "Hist\u00f3rico de reprodu\u00e7\u00e3o",
        recentHistoryEmpty: "Suas m\u00fasicas ouvidas aparecer\u00e3o aqui.",
        favoritesTitle: "M\u00fasicas Curtidas",
        favoritesEmpty: "Adicione m\u00fasicas aos seus favoritos.",
        savedInDevice: "salvas",
        downloadDevice: "Baixar no dispositivo",
        languageSelect: "Idioma da interface",
        languagesCount: "12 idiomas",
        audioQuality: "Qualidade de \u00e1udio",
        audioQualityDesc: "Streaming adaptativo com acelera\u00e7\u00e3o Ultra HQ at\u00e9 256kbps AAC / FLAC no R2.",
        qualityHigh: "Alta",
        qualityNormal: "Normal",
        qualityData: "Econ\u00f4mico",
        aboutSubtitle: "Engine de streaming descentralizado",
        dataAndPrivacy: "Dados e Privacidade",
        searchHistory: "Hist\u00f3rico de pesquisa",
        clearSearchHistoryDesc: "Excluir pesquisas de texto recentes",
        clearPlaybackHistoryDesc: "Excluir m\u00fasicas ouvidas",
        clearHistory: "Limpar hist\u00f3rico",
        clearHistoryConfirm: "Limpar todo o hist\u00f3rico?",
        historyCleared: "Hist\u00f3rico exclu\u00eddo",
        noHistoryYet: "Nenhuma m\u00fasica ouvida ainda.",
        likedToast: "Adicionado aos favoritos",
        unlikedToast: "Removido dos favoritos",
        downloadStarting: "Baixando...",
        downloadComplete: "Baixado",
        downloadUnavailable: "Indispon\u00edvel",
        cat_all: "Tudo",
        cat_workout: "Treino",
        cat_energy: "Energia",
        cat_relax: "Relaxar",
        cat_focus: "Foco",
        cat_party: "Festa",
        cat_commute: "No carro",
        cat_rock: "Rock",
        cat_urban: "Trap & Urbano",
        albums: "\u00c1lbuns",
        myAlbums: "Seus \u00c1lbuns",
        albumsSub: "Cole\u00e7\u00e3o de \u00e1lbuns personalizados",
        customAlbum: "\u00c1lbum personalizado",
        createAlbum: "Criar \u00e1lbum",
        albumNamePrompt: "Nome do novo \u00e1lbum:",
        albumCreatedToast: "\u00c1lbum criado com sucesso",
        albumDeletedToast: "\u00c1lbum exclu\u00eddo",
        trackAddedToast: "M\u00fasica salva no \u00e1lbum",
        trackRemovedToast: "M\u00fasica removida do \u00e1lbum",
        noAlbumsYet: "Nenhum \u00e1lbum criado ainda.",
        noAlbumsHint: "Crie um \u00e1lbum para organizar suas m\u00fasicas.",
        playAll: "Reproduzir tudo",
        deleteAlbum: "Excluir \u00e1lbum",
        deleteAlbumConfirm: "Excluir este \u00e1lbum?",
        emptyAlbum: "Este \u00e1lbum est\u00e1 vazio.",
        emptyAlbumHint: "Pesquise m\u00fasicas para adicion\u00e1-las aqui.",
        addToAlbum: "Salvar em um \u00e1lbum",
        selectAlbumOrCreate: "Selecione um \u00e1lbum ou crie um novo:",
        recentSearches: "Pesquisas recentes",
        clearSearchHistory: "Limpar hist\u00f3rico",
        suggestedSearches: "Pesquisas sugeridas",
        searchHint: "Pesquise artistas, m\u00fasicas ou \u00e1lbuns...",
        noResults: "Nenhum resultado encontrado.",
        downloadSong: "Baixar m\u00fasica",
        addToFavorites: "Adicionar aos Favoritos",
        removeFromFavorites: "Remover dos Favoritos",
        copyLink: "Copiar link",
        linkCopiedToast: "Link copiado!",
        cancel: "Cancelar",
        searchTabSongs: "M\u00fasicas",
        searchTabAlbums: "\u00c1lbuns",
        searchTabArtists: "Artistas",
        moodCurated: "M\u00fasica para este momento",
        backToHome: "In\u00edcio",
        artistTracksCount: "m\u00fasicas",
        getAppNav: "Obter o app",
        getAppSub: "Instale o Aurora Music no seu Android \u2014 direto e seguro",
        getAppSettingsBtn: "Instalar",
        appPageTitle: "Aurora Music para Android",
        appPageSub: "Toda a sua m\u00fasica em um app nativo: controles pela notifica\u00e7\u00e3o, reprodu\u00e7\u00e3o em segundo plano e a mesma experi\u00eancia da web.",
        appDownloadBtn: "Baixar APK",
        appDownloadMeta: "Vers\u00e3o 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "Como instalar",
        appStep1Title: "Baixe o APK",
        appStep1Desc: "Toque no bot\u00e3o e o download come\u00e7a na hora, sem p\u00e1ginas externas.",
        appStep2Title: "Abra o arquivo",
        appStep2Desc: "Abra pela notifica\u00e7\u00e3o ou pelo app de arquivos.",
        appStep3Title: "Permita e instale",
        appStep3Desc: "O Android vai pedir permiss\u00e3o para instalar desta fonte. Aceite e pronto.",
        appSecurityNote: "APK assinado oficialmente \u2014 instala\u00e7\u00e3o direta do GitHub, sem lojas externas.",
        appOtherPlatformNote: "O app do Aurora Music est\u00e1 dispon\u00edvel apenas para Android. No iPhone, iPad ou computador, continue aproveitando a mesma experi\u00eancia na web.",
        appInstalledNote: "Voc\u00ea j\u00e1 tem o Aurora Music instalado \u2014 voc\u00ea est\u00e1 usando ele agora mesmo.",
        appGithubBtn: "Ver no GitHub",
      },
      fr: {
        code: "FR",
        langName: "Fran\u00e7ais",
        home: "Accueil",
        explore: "Explorer",
        library: "Biblioth\u00e8que",
        offline: "Hors ligne",
        reconnecting: "Reconnexion automatique...",
        settings: "Param\u00e8tres",
        searchPlaceholder: "Rechercher titres, artistes, albums...",
        quickPicks: "\u00c9couter \u00e0 nouveau",
        quickPicksSub: "Vos raccourcis",
        recommendedMix: "Pour Vous",
        recommendedMixSub: "P\u00e9pites de votre historique",
        trending: "Tendances",
        trendingSub: "Les hits du moment",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "Audio sans perte",
        recentHistory: "Historique r\u00e9cent",
        playbackHistory: "Historique d'\u00e9coute",
        recentHistoryEmpty: "Vos morceaux \u00e9cout\u00e9s appara\u00eetront ici.",
        favoritesTitle: "Titres Favoris",
        favoritesEmpty: "Ajoutez des titres \u00e0 vos favoris.",
        savedInDevice: "enregistr\u00e9s",
        downloadDevice: "T\u00e9l\u00e9charger sur l'appareil",
        languageSelect: "Langue de l'interface",
        languagesCount: "12 langues",
        audioQuality: "Qualit\u00e9 audio",
        audioQualityDesc: "Streaming adaptatif FLAC / AAC acc\u00e9l\u00e9r\u00e9 par Ultra HQ.",
        qualityHigh: "Haute",
        qualityNormal: "Normale",
        qualityData: "\u00c9conomiseur",
        aboutSubtitle: "Moteur audio d\u00e9centralis\u00e9",
        dataAndPrivacy: "Donn\u00e9es et Confidentialit\u00e9",
        searchHistory: "Historique de recherche",
        clearSearchHistoryDesc: "Supprimer vos recherches r\u00e9centes",
        clearPlaybackHistoryDesc: "Supprimer les morceaux de votre biblioth\u00e8que",
        clearHistory: "Effacer l'historique",
        clearHistoryConfirm: "Effacer tout l'historique ?",
        historyCleared: "Historique effac\u00e9",
        noHistoryYet: "Aucun morceau \u00e9cout\u00e9 pour l'instant.",
        likedToast: "Ajout\u00e9 aux favoris",
        unlikedToast: "Retir\u00e9 des favoris",
        downloadStarting: "T\u00e9l\u00e9chargement...",
        downloadComplete: "T\u00e9l\u00e9charg\u00e9",
        downloadUnavailable: "Indisponible",
        cat_all: "Tout",
        cat_workout: "Sport",
        cat_energy: "\u00c9nergie",
        cat_relax: "D\u00e9tente",
        cat_focus: "Concentration",
        cat_party: "F\u00eate",
        cat_commute: "Trajet",
        cat_rock: "Rock",
        cat_urban: "Urbain",
        albums: "Albums",
        myAlbums: "Vos Albums",
        albumsSub: "Collection d'albums personnalis\u00e9s",
        customAlbum: "Album personnalis\u00e9",
        createAlbum: "Cr\u00e9er un album",
        albumNamePrompt: "Nom du nouvel album :",
        albumCreatedToast: "Album cr\u00e9\u00e9",
        albumDeletedToast: "Album supprim\u00e9",
        trackAddedToast: "Titre ajout\u00e9 \u00e0 l'album",
        trackRemovedToast: "Titre retir\u00e9 de l'album",
        noAlbumsYet: "Aucun album cr\u00e9\u00e9.",
        noAlbumsHint: "Cr\u00e9ez un album pour organiser votre musique.",
        playAll: "Tout lire",
        deleteAlbum: "Supprimer l'album",
        deleteAlbumConfirm: "Supprimer cet album ?",
        emptyAlbum: "Cet album est vide.",
        emptyAlbumHint: "Recherchez des chansons pour les ajouter ici.",
        addToAlbum: "Enregistrer dans un album",
        selectAlbumOrCreate: "S\u00e9lectionnez un album ou cr\u00e9ez-en un :",
        recentSearches: "Recherches r\u00e9centes",
        clearSearchHistory: "Effacer l'historique",
        suggestedSearches: "Suggestions",
        searchHint: "Recherchez des artistes, chansons ou albums...",
        noResults: "Aucun r\u00e9sultat trouv\u00e9.",
        downloadSong: "T\u00e9l\u00e9charger le titre",
        addToFavorites: "Ajouter aux favoris",
        removeFromFavorites: "Retirer des favoris",
        copyLink: "Copier le lien",
        linkCopiedToast: "Lien copi\u00e9 !",
        cancel: "Annuler",
        searchTabSongs: "Titres",
        searchTabAlbums: "Albums",
        searchTabArtists: "Artistes",
        moodCurated: "Musique s\u00e9lectionn\u00e9e pour ce moment",
        backToHome: "Accueil",
        artistTracksCount: "titres",
        getAppNav: "Obtenir l'appli",
        getAppSub: "Installez Aurora Music sur votre Android \u2014 direct et s\u00e9curis\u00e9",
        getAppSettingsBtn: "Installer",
        appPageTitle: "Aurora Music pour Android",
        appPageSub: "Toute votre musique dans une appli native : contr\u00f4les depuis la notification, lecture en arri\u00e8re-plan et la m\u00eame exp\u00e9rience que sur le web.",
        appDownloadBtn: "T\u00e9l\u00e9charger l'APK",
        appDownloadMeta: "Version 1.0.0 \u00b7 ~102 Mo \u00b7 Android 7.0+",
        appStepsTitle: "Comment installer",
        appStep1Title: "T\u00e9l\u00e9chargez l'APK",
        appStep1Desc: "Appuyez sur le bouton et le t\u00e9l\u00e9chargement d\u00e9marre instantan\u00e9ment, sans pages externes.",
        appStep2Title: "Ouvrez le fichier",
        appStep2Desc: "Ouvrez-le depuis la notification ou votre application Fichiers.",
        appStep3Title: "Autorisez et installez",
        appStep3Desc: "Android demandera l'autorisation d'installer depuis cette source. Acceptez et c'est fait.",
        appSecurityNote: "APK sign\u00e9e officiellement \u2014 installation directe depuis GitHub, sans magasins externes.",
        appOtherPlatformNote: "L'appli Aurora Music est disponible uniquement pour Android. Sur iPhone, iPad ou ordinateur, profitez de la m\u00eame exp\u00e9rience sur le web.",
        appInstalledNote: "Vous avez d\u00e9j\u00e0 Aurora Music install\u00e9e \u2014 vous l'utilisez en ce moment m\u00eame.",
        appGithubBtn: "Voir sur GitHub",
      },
      de: {
        code: "DE",
        langName: "Deutsch",
        home: "Startseite",
        explore: "Entdecken",
        library: "Mediathek",
        offline: "Offline",
        reconnecting: "Automatische Neuverbindung...",
        settings: "Einstellungen",
        searchPlaceholder: "Titel, K\u00fcnstler, Alben suchen...",
        quickPicks: "Wieder anh\u00f6ren",
        quickPicksSub: "Schnellzugriff",
        recommendedMix: "F\u00fcr Dich",
        recommendedMixSub: "Highlights aus deinem Verlauf",
        trending: "Trends",
        trendingSub: "Aktuelle Hits",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "Lossless Audio ohne Kompression",
        recentHistory: "Verlauf",
        playbackHistory: "Wiedergabeverlauf",
        recentHistoryEmpty: "Deine geh\u00f6rten Songs erscheinen hier.",
        favoritesTitle: "Lieblingssongs",
        favoritesEmpty: "F\u00fcge Songs zu deinen Favoriten hinzu.",
        savedInDevice: "gespeichert",
        downloadDevice: "Auf Ger\u00e4t herunterladen",
        languageSelect: "Sprache",
        languagesCount: "12 Sprachen",
        audioQuality: "Audioqualit\u00e4t",
        audioQualityDesc: "Ultra HQ Edge Streaming bis zu 256kbps AAC / Lossless FLAC.",
        qualityHigh: "Hoch",
        qualityNormal: "Normal",
        qualityData: "Sparmodus",
        aboutSubtitle: "Dezentrale Musik-Engine",
        dataAndPrivacy: "Daten & Datenschutz",
        searchHistory: "Suchverlauf",
        clearSearchHistoryDesc: "L\u00f6scht deine k\u00fcrzlichen Suchanfragen",
        clearPlaybackHistoryDesc: "L\u00f6scht geh\u00f6rte Songs aus deiner Mediathek",
        clearHistory: "Verlauf l\u00f6schen",
        clearHistoryConfirm: "Gesamten Verlauf l\u00f6schen?",
        historyCleared: "Verlauf gel\u00f6scht",
        noHistoryYet: "Noch keine Songs geh\u00f6rt.",
        likedToast: "Zu Favoriten hinzugef\u00fcgt",
        unlikedToast: "Aus Favoriten entfernt",
        downloadStarting: "L\u00e4dt herunter...",
        downloadComplete: "Heruntergeladen",
        downloadUnavailable: "Nicht verf\u00fcgbar",
        cat_all: "Alle",
        cat_workout: "Workout",
        cat_energy: "Energie",
        cat_relax: "Entspannung",
        cat_focus: "Fokus",
        cat_party: "Party",
        cat_commute: "Unterwegs",
        cat_rock: "Rock",
        cat_urban: "Urban",
        albums: "Alben",
        myAlbums: "Deine Alben",
        albumsSub: "Eigene Albensammlung",
        customAlbum: "Eigenes Album",
        createAlbum: "Album erstellen",
        albumNamePrompt: "Name des neuen Albums:",
        albumCreatedToast: "Album erstellt",
        albumDeletedToast: "Album gel\u00f6scht",
        trackAddedToast: "Song im Album gespeichert",
        trackRemovedToast: "Song aus Album entfernt",
        noAlbumsYet: "Noch keine Alben vorhanden.",
        noAlbumsHint: "Erstelle ein Album, um deine Musik zu organisieren.",
        playAll: "Alle abspielen",
        deleteAlbum: "Album l\u00f6schen",
        deleteAlbumConfirm: "Dieses Album l\u00f6schen?",
        emptyAlbum: "Dieses Album ist leer.",
        emptyAlbumHint: "Suche Songs und f\u00fcge sie \u00fcber die 3 Punkte hinzu.",
        addToAlbum: "In Album speichern",
        selectAlbumOrCreate: "Album ausw\u00e4hlen oder erstellen:",
        recentSearches: "Letzte Suchanfragen",
        clearSearchHistory: "Verlauf l\u00f6schen",
        suggestedSearches: "Vorschl\u00e4ge",
        searchHint: "Suche nach K\u00fcnstlern, Titeln oder Alben...",
        noResults: "Keine Ergebnisse gefunden.",
        downloadSong: "Song herunterladen",
        addToFavorites: "Zu Favoriten hinzuf\u00fcgen",
        removeFromFavorites: "Aus Favoriten entfernen",
        copyLink: "Link kopieren",
        linkCopiedToast: "Link kopiert!",
        cancel: "Abbrechen",
        searchTabSongs: "Songs",
        searchTabAlbums: "Alben",
        searchTabArtists: "K\u00fcnstler",
        moodCurated: "Musik f\u00fcr diesen Moment",
        backToHome: "Startseite",
        artistTracksCount: "Titel",
        getAppNav: "App holen",
        getAppSub: "Installiere Aurora Music auf deinem Android \u2014 direkt und sicher",
        getAppSettingsBtn: "Installieren",
        appPageTitle: "Aurora Music f\u00fcr Android",
        appPageSub: "All deine Musik in einer nativen App: Steuerung \u00fcber die Benachrichtigung, Hintergrundwiedergabe und dasselbe Erlebnis wie im Web.",
        appDownloadBtn: "APK herunterladen",
        appDownloadMeta: "Version 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "So installierst du",
        appStep1Title: "Lade die APK herunter",
        appStep1Desc: "Tippe auf die Schaltfl\u00e4che und der Download startet sofort \u2014 ohne externe Seiten.",
        appStep2Title: "\u00d6ffne die Datei",
        appStep2Desc: "\u00d6ffne sie \u00fcber die Benachrichtigung oder deine Dateien-App.",
        appStep3Title: "Erlauben & installieren",
        appStep3Desc: "Android fragt nach der Berechtigung, aus dieser Quelle zu installieren. Best\u00e4tige \u2014 und fertig.",
        appSecurityNote: "Offiziell signierte APK \u2014 direkte Installation von GitHub, ohne externe Stores.",
        appOtherPlatformNote: "Die Aurora-Music-App ist nur f\u00fcr Android verf\u00fcgbar. Auf iPhone, iPad oder Desktop genie\u00dfe weiterhin dasselbe Erlebnis im Web.",
        appInstalledNote: "Du hast Aurora Music bereits installiert \u2014 du nutzt sie gerade jetzt.",
        appGithubBtn: "Auf GitHub ansehen",
      },
      it: {
        code: "IT",
        langName: "Italiano",
        home: "Home",
        explore: "Esplora",
        library: "Raccolta",
        offline: "Non in linea",
        reconnecting: "Riconnessione automatica...",
        settings: "Impostazioni",
        searchPlaceholder: "Cerca brani, artisti, album...",
        quickPicks: "Ascolta di nuovo",
        quickPicksSub: "Accesso rapido",
        recommendedMix: "Per Te",
        recommendedMixSub: "Dalla tua cronologia",
        trending: "Tendenze",
        trendingSub: "I successi del momento",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "Audio senza perdita di qualit\u00e0",
        recentHistory: "Cronologia recente",
        playbackHistory: "Cronologia di ascolto",
        recentHistoryEmpty: "I brani ascoltati appariranno qui.",
        favoritesTitle: "Brani Preferiti",
        favoritesEmpty: "Aggiungi brani ai tuoi preferiti.",
        savedInDevice: "salvati",
        downloadDevice: "Scarica sul dispositivo",
        languageSelect: "Lingua dell'interfaccia",
        languagesCount: "12 lingue",
        audioQuality: "Qualit\u00e0 audio",
        audioQualityDesc: "Streaming FLAC/AAC su Ultra HQ Edge.",
        qualityHigh: "Alta",
        qualityNormal: "Normale",
        qualityData: "Risparmio",
        aboutSubtitle: "Engine di streaming decentralizzato",
        dataAndPrivacy: "Dati e Privacy",
        searchHistory: "Cronologia ricerche",
        clearSearchHistoryDesc: "Cancella le ricerche recenti",
        clearPlaybackHistoryDesc: "Rimuovi i brani ascoltati",
        clearHistory: "Cancella cronologia",
        clearHistoryConfirm: "Cancellare la cronologia?",
        historyCleared: "Cronologia cancellata",
        noHistoryYet: "Nessun brano ascoltato finora.",
        likedToast: "Aggiunto ai preferiti",
        unlikedToast: "Rimosso dai preferiti",
        downloadStarting: "Scaricamento...",
        downloadComplete: "Scaricato",
        downloadUnavailable: "Non disponibile",
        cat_all: "Tutti",
        cat_workout: "Allenamento",
        cat_energy: "Energia",
        cat_relax: "Relax",
        cat_focus: "Studio",
        cat_party: "Festa",
        cat_commute: "In viaggio",
        cat_rock: "Rock",
        cat_urban: "Urban",
        albums: "Album",
        myAlbums: "I tuoi Album",
        albumsSub: "Raccolta di album personalizzati",
        customAlbum: "Album personalizzato",
        createAlbum: "Crea album",
        albumNamePrompt: "Nome del nuovo album:",
        albumCreatedToast: "Album creato",
        albumDeletedToast: "Album eliminato",
        trackAddedToast: "Brano aggiunto all'album",
        trackRemovedToast: "Brano rimosso dall'album",
        noAlbumsYet: "Nessun album creato.",
        noAlbumsHint: "Crea un album per organizzare la tua musica.",
        playAll: "Riproduci tutti",
        deleteAlbum: "Elimina album",
        deleteAlbumConfirm: "Eliminare questo album?",
        emptyAlbum: "Questo album \u00e8 vuoto.",
        emptyAlbumHint: "Cerca canzoni per aggiungerle qui.",
        addToAlbum: "Salva in un album",
        selectAlbumOrCreate: "Seleziona un album o creane uno:",
        recentSearches: "Ricerche recenti",
        clearSearchHistory: "Cancella cronologia",
        suggestedSearches: "Suggerimenti",
        searchHint: "Cerca artisti, brani o album...",
        noResults: "Nessun risultato trovato.",
        downloadSong: "Scarica brano",
        addToFavorites: "Aggiungi ai Preferiti",
        removeFromFavorites: "Rimuovi dai Preferiti",
        copyLink: "Copia link",
        linkCopiedToast: "Link copiato!",
        cancel: "Annulla",
        searchTabSongs: "Brani",
        searchTabAlbums: "Album",
        searchTabArtists: "Artisti",
        moodCurated: "Musica per questo momento",
        backToHome: "Home",
        artistTracksCount: "brani",
        getAppNav: "Ottieni l'app",
        getAppSub: "Installa Aurora Music sul tuo Android \u2014 diretto e sicuro",
        getAppSettingsBtn: "Installa",
        appPageTitle: "Aurora Music per Android",
        appPageSub: "Tutta la tua musica in un'app nativa: controlli dalla notifica, riproduzione in background e la stessa esperienza del web.",
        appDownloadBtn: "Scarica l'APK",
        appDownloadMeta: "Versione 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "Come installare",
        appStep1Title: "Scarica l'APK",
        appStep1Desc: "Tocca il pulsante e il download inizia all\u2019istante, senza pagine esterne.",
        appStep2Title: "Apri il file",
        appStep2Desc: "Aprilo dalla notifica o dall\u2019app File.",
        appStep3Title: "Consenti e installa",
        appStep3Desc: "Android chieder\u00e0 il permesso di installare da questa fonte. Accetta e il gioco \u00e8 fatto.",
        appSecurityNote: "APK firmato ufficialmente \u2014 installazione diretta da GitHub, senza store esterni.",
        appOtherPlatformNote: "L'app di Aurora Music \u00e8 disponibile solo per Android. Su iPhone, iPad o computer continua a goderti la stessa esperienza sul web.",
        appInstalledNote: "Hai gi\u00e0 installato Aurora Music \u2014 la stai usando proprio ora.",
        appGithubBtn: "Vedi su GitHub",
      },
      ru: {
        code: "RU",
        langName: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
        home: "\u0413\u043b\u0430\u0432\u043d\u0430\u044f",
        explore: "\u041e\u0431\u0437\u043e\u0440",
        library: "\u041c\u0435\u0434\u0438\u0430\u0442\u0435\u043a\u0430",
        offline: "\u041e\u0444\u043b\u0430\u0439\u043d",
        reconnecting: "\u0410\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u043e\u0435 \u043f\u0435\u0440\u0435\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435...",
        settings: "\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438",
        searchPlaceholder: "\u041f\u043e\u0438\u0441\u043a \u0442\u0440\u0435\u043a\u043e\u0432, \u0438\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u0435\u0439...",
        quickPicks: "\u041f\u043e\u0441\u043b\u0443\u0448\u0430\u0442\u044c \u0441\u043d\u043e\u0432\u0430",
        quickPicksSub: "\u0411\u044b\u0441\u0442\u0440\u044b\u0439 \u0434\u043e\u0441\u0442\u0443\u043f",
        recommendedMix: "\u0414\u043b\u044f \u0432\u0430\u0441",
        recommendedMixSub: "\u0418\u0437 \u0432\u0430\u0448\u0435\u0439 \u0438\u0441\u0442\u043e\u0440\u0438\u0438",
        trending: "\u0422\u0440\u0435\u043d\u0434\u044b",
        trendingSub: "\u041f\u043e\u043f\u0443\u043b\u044f\u0440\u043d\u044b\u0435 \u0445\u0438\u0442\u044b",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\u0411\u0435\u0437 \u043f\u043e\u0442\u0435\u0440\u0438 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0430",
        recentHistory: "\u041d\u0435\u0434\u0430\u0432\u043d\u043e\u0435",
        playbackHistory: "\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u0440\u043e\u0441\u043b\u0443\u0448\u0438\u0432\u0430\u043d\u0438\u0439",
        recentHistoryEmpty: "\u041f\u0440\u043e\u0441\u043b\u0443\u0448\u0430\u043d\u043d\u044b\u0435 \u0442\u0440\u0435\u043a\u0438 \u043f\u043e\u044f\u0432\u044f\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c.",
        favoritesTitle: "\u041b\u044e\u0431\u0438\u043c\u044b\u0435 \u0442\u0440\u0435\u043a\u0438",
        favoritesEmpty: "\u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u0442\u0440\u0435\u043a\u0438 \u0432 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435.",
        savedInDevice: "\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e",
        downloadDevice: "\u0421\u043a\u0430\u0447\u0430\u0442\u044c \u043d\u0430 \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u043e",
        languageSelect: "\u042f\u0437\u044b\u043a \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430",
        languagesCount: "12 \u044f\u0437\u044b\u043a\u043e\u0432",
        audioQuality: "\u041a\u0430\u0447\u0435\u0441\u0442\u0432\u043e \u0437\u0432\u0443\u043a\u0430",
        audioQualityDesc: "\u0421\u0442\u0440\u0438\u043c\u0438\u043d\u0433 FLAC / 256kbps AAC \u0447\u0435\u0440\u0435\u0437 Ultra HQ Edge.",
        qualityHigh: "\u0412\u044b\u0441\u043e\u043a\u043e\u0435",
        qualityNormal: "\u041e\u0431\u044b\u0447\u043d\u043e\u0435",
        qualityData: "\u042d\u043a\u043e\u043d\u043e\u043c\u0438\u044f",
        aboutSubtitle: "\u0414\u0435\u0446\u0435\u043d\u0442\u0440\u0430\u043b\u0438\u0437\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0430\u0443\u0434\u0438\u043e-\u0434\u0432\u0438\u0436\u043e\u043a",
        dataAndPrivacy: "\u0414\u0430\u043d\u043d\u044b\u0435 \u0438 \u043f\u0440\u0438\u0432\u0430\u0442\u043d\u043e\u0441\u0442\u044c",
        searchHistory: "\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u043e\u0438\u0441\u043a\u0430",
        clearSearchHistoryDesc: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043d\u0435\u0434\u0430\u0432\u043d\u0438\u0435 \u043f\u043e\u0438\u0441\u043a\u043e\u0432\u044b\u0435 \u0437\u0430\u043f\u0440\u043e\u0441\u044b",
        clearPlaybackHistoryDesc: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0440\u043e\u0441\u043b\u0443\u0448\u0430\u043d\u043d\u044b\u0435 \u0442\u0440\u0435\u043a\u0438",
        clearHistory: "\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0438\u0441\u0442\u043e\u0440\u0438\u044e",
        clearHistoryConfirm: "\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0432\u0441\u044e \u0438\u0441\u0442\u043e\u0440\u0438\u044e?",
        historyCleared: "\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043e\u0447\u0438\u0449\u0435\u043d\u0430",
        noHistoryYet: "\u0412\u044b \u0435\u0449\u0451 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0441\u043b\u0443\u0448\u0430\u043b\u0438.",
        likedToast: "\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e \u0432 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435",
        unlikedToast: "\u0423\u0434\u0430\u043b\u0435\u043d\u043e \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e",
        downloadStarting: "\u0421\u043a\u0430\u0447\u0438\u0432\u0430\u043d\u0438\u0435...",
        downloadComplete: "\u0421\u043a\u0430\u0447\u0430\u043d\u043e",
        downloadUnavailable: "\u041d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e",
        cat_all: "\u0412\u0441\u0435",
        cat_workout: "\u0422\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0430",
        cat_energy: "\u042d\u043d\u0435\u0440\u0433\u0438\u044f",
        cat_relax: "\u0420\u0435\u043b\u0430\u043a\u0441",
        cat_focus: "\u0424\u043e\u043a\u0443\u0441",
        cat_party: "\u0412\u0435\u0447\u0435\u0440\u0438\u043d\u043a\u0430",
        cat_commute: "\u0412 \u0434\u043e\u0440\u043e\u0433\u0435",
        cat_rock: "\u0420\u043e\u043a",
        cat_urban: "\u042d\u0440\u0431\u0430\u043d",
        albums: "\u0410\u043b\u044c\u0431\u043e\u043c\u044b",
        myAlbums: "\u0412\u0430\u0448\u0438 \u0430\u043b\u044c\u0431\u043e\u043c\u044b",
        albumsSub: "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c\u0441\u043a\u0438\u0435 \u0430\u043b\u044c\u0431\u043e\u043c\u044b",
        customAlbum: "\u0410\u043b\u044c\u0431\u043e\u043c",
        createAlbum: "\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u0430\u043b\u044c\u0431\u043e\u043c",
        albumNamePrompt: "\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0430\u043b\u044c\u0431\u043e\u043c\u0430:",
        albumCreatedToast: "\u0410\u043b\u044c\u0431\u043e\u043c \u0441\u043e\u0437\u0434\u0430\u043d",
        albumDeletedToast: "\u0410\u043b\u044c\u0431\u043e\u043c \u0443\u0434\u0430\u043b\u0451\u043d",
        trackAddedToast: "\u0422\u0440\u0435\u043a \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d",
        trackRemovedToast: "\u0422\u0440\u0435\u043a \u0443\u0434\u0430\u043b\u0451\u043d",
        noAlbumsYet: "\u041d\u0435\u0442 \u0441\u043e\u0437\u0434\u0430\u043d\u043d\u044b\u0445 \u0430\u043b\u044c\u0431\u043e\u043c\u043e\u0432.",
        noAlbumsHint: "\u0421\u043e\u0437\u0434\u0430\u0439\u0442\u0435 \u0430\u043b\u044c\u0431\u043e\u043c \u0434\u043b\u044f \u043c\u0443\u0437\u044b\u043a\u0438.",
        playAll: "\u0412\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0441\u0442\u0438 \u0432\u0441\u0451",
        deleteAlbum: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0430\u043b\u044c\u0431\u043e\u043c",
        deleteAlbumConfirm: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u044d\u0442\u043e\u0442 \u0430\u043b\u044c\u0431\u043e\u043c?",
        emptyAlbum: "\u0410\u043b\u044c\u0431\u043e\u043c \u043f\u0443\u0441\u0442.",
        emptyAlbumHint: "\u0414\u043e\u0431\u0430\u0432\u043b\u044f\u0439\u0442\u0435 \u0442\u0440\u0435\u043a\u0438 \u0447\u0435\u0440\u0435\u0437 \u043c\u0435\u043d\u044e.",
        addToAlbum: "\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0432 \u0430\u043b\u044c\u0431\u043e\u043c",
        selectAlbumOrCreate: "\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0438\u043b\u0438 \u0441\u043e\u0437\u0434\u0430\u0439\u0442\u0435 \u0430\u043b\u044c\u0431\u043e\u043c:",
        recentSearches: "\u041d\u0435\u0434\u0430\u0432\u043d\u0438\u0439 \u043f\u043e\u0438\u0441\u043a",
        clearSearchHistory: "\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0438\u0441\u0442\u043e\u0440\u0438\u044e",
        suggestedSearches: "\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u043c",
        searchHint: "\u0418\u0441\u0447\u0438\u0442\u0435 \u0438\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u0435\u0439 \u0438\u043b\u0438 \u0442\u0440\u0435\u043a\u0438...",
        noResults: "\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e.",
        downloadSong: "\u0421\u043a\u0430\u0447\u0430\u0442\u044c \u0442\u0440\u0435\u043a",
        addToFavorites: "\u0412 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435",
        removeFromFavorites: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e",
        copyLink: "\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443",
        linkCopiedToast: "\u0421\u0441\u044b\u043b\u043a\u0430 \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u0430!",
        cancel: "\u041e\u0442\u043c\u0435\u043d\u0430",
        searchTabSongs: "\u0422\u0440\u0435\u043a\u0438",
        searchTabAlbums: "\u0410\u043b\u044c\u0431\u043e\u043c\u044b",
        searchTabArtists: "\u0418\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u0438",
        moodCurated: "\u041f\u043e\u0434\u0431\u043e\u0440\u043a\u0430 \u043c\u0443\u0437\u044b\u043a\u0438",
        backToHome: "\u0413\u043b\u0430\u0432\u043d\u0430\u044f",
        artistTracksCount: "\u0442\u0440\u0435\u043a\u043e\u0432",
        getAppNav: "\u041f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435",
        getAppSub: "\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 Aurora Music \u043d\u0430 Android \u2014 \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e \u0438 \u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e",
        getAppSettingsBtn: "\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c",
        appPageTitle: "Aurora Music \u0434\u043b\u044f Android",
        appPageSub: "\u0412\u0441\u044f \u0432\u0430\u0448\u0430 \u043c\u0443\u0437\u044b\u043a\u0430 \u0432 \u043d\u0430\u0442\u0438\u0432\u043d\u043e\u043c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0438: \u0443\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u0438\u0437 \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f, \u0444\u043e\u043d\u043e\u0432\u043e\u0435 \u0432\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0434\u0435\u043d\u0438\u0435 \u0438 \u0442\u043e\u0442 \u0436\u0435 \u043e\u043f\u044b\u0442, \u0447\u0442\u043e \u0438 \u0432 \u0432\u0435\u0431-\u0432\u0435\u0440\u0441\u0438\u0438.",
        appDownloadBtn: "\u0421\u043a\u0430\u0447\u0430\u0442\u044c APK",
        appDownloadMeta: "\u0412\u0435\u0440\u0441\u0438\u044f 1.0.0 \u00b7 ~102 \u041c\u0411 \u00b7 Android 7.0+",
        appStepsTitle: "\u041a\u0430\u043a \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c",
        appStep1Title: "\u0421\u043a\u0430\u0447\u0430\u0439\u0442\u0435 APK",
        appStep1Desc: "\u041d\u0430\u0436\u043c\u0438\u0442\u0435 \u043a\u043d\u043e\u043f\u043a\u0443 \u2014 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u043d\u0430\u0447\u043d\u0451\u0442\u0441\u044f \u043c\u0433\u043d\u043e\u0432\u0435\u043d\u043d\u043e, \u0431\u0435\u0437 \u0432\u043d\u0435\u0448\u043d\u0438\u0445 \u0441\u0442\u0440\u0430\u043d\u0438\u0446.",
        appStep2Title: "\u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u0444\u0430\u0439\u043b",
        appStep2Desc: "\u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u0435\u0433\u043e \u0438\u0437 \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f \u0438\u043b\u0438 \u0438\u0437 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f \u00ab\u0424\u0430\u0439\u043b\u044b\u00bb.",
        appStep3Title: "\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0438 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435",
        appStep3Desc: "Android \u0437\u0430\u043f\u0440\u043e\u0441\u0438\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u0435 \u043d\u0430 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0443 \u0438\u0437 \u044d\u0442\u043e\u0433\u043e \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430. \u041f\u0440\u0438\u043c\u0438\u0442\u0435 \u2014 \u0438 \u0433\u043e\u0442\u043e\u0432\u043e.",
        appSecurityNote: "APK \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u043e \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u0430 \u2014 \u043f\u0440\u044f\u043c\u0430\u044f \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u0441 GitHub, \u0431\u0435\u0437 \u0432\u043d\u0435\u0448\u043d\u0438\u0445 \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u043e\u0432.",
        appOtherPlatformNote: "\u041f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435 Aurora Music \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e \u0442\u043e\u043b\u044c\u043a\u043e \u0434\u043b\u044f Android. \u041d\u0430 iPhone, iPad \u0438\u043b\u0438 \u043a\u043e\u043c\u043f\u044c\u044e\u0442\u0435\u0440\u0435 \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u0439\u0442\u0435 \u043d\u0430\u0441\u043b\u0430\u0436\u0434\u0430\u0442\u044c\u0441\u044f \u0442\u0435\u043c \u0436\u0435 \u043e\u043f\u044b\u0442\u043e\u043c \u0432 \u0432\u0435\u0431-\u0432\u0435\u0440\u0441\u0438\u0438.",
        appInstalledNote: "Aurora Music \u0443\u0436\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e \u2014 \u0432\u044b \u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442\u0435\u0441\u044c \u0438\u043c \u043f\u0440\u044f\u043c\u043e \u0441\u0435\u0439\u0447\u0430\u0441.",
        appGithubBtn: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043d\u0430 GitHub",
      },
      ja: {
        code: "JA",
        langName: "\u65e5\u672c\u8a9e",
        home: "\u30db\u30fc\u30e0",
        explore: "\u63a2\u7d22",
        library: "\u30e9\u30a4\u30d6\u30e9\u30ea",
        offline: "\u30aa\u30d5\u30e9\u30a4\u30f3",
        reconnecting: "\u81ea\u52d5\u7684\u306b\u518d\u63a5\u7d9a\u3057\u3066\u3044\u307e\u3059...",
        settings: "\u8a2d\u5b9a",
        searchPlaceholder: "\u66f2\u3001\u30a2\u30fc\u30c6\u30a3\u30b9\u30c8\u3001\u30a2\u30eb\u30d0\u30e0\u3092\u691c\u7d22...",
        quickPicks: "\u3082\u3046\u4e00\u5ea6\u8074\u304f",
        quickPicksSub: "\u30af\u30a4\u30c3\u30af\u30a2\u30af\u30bb\u30b9",
        recommendedMix: "\u3042\u306a\u305f\u3078",
        recommendedMixSub: "\u5c65\u6b74\u304b\u3089\u304a\u3059\u3059\u3081",
        trending: "\u6025\u4e0a\u6607",
        trendingSub: "\u4eca\u8a71\u984c\u306e\u66f2",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\u30ed\u30b9\u30ec\u30b9\u97f3\u6e90",
        recentHistory: "\u6700\u8fd1\u306e\u5c65\u6b74",
        playbackHistory: "\u518d\u751f\u5c65\u6b74",
        recentHistoryEmpty: "\u518d\u751f\u3057\u305f\u66f2\u304c\u3053\u3053\u306b\u8868\u793a\u3055\u308c\u307e\u3059\u3002",
        favoritesTitle: "\u304a\u6c17\u306b\u5165\u308a\u306e\u66f2",
        favoritesEmpty: "\u304a\u6c17\u306b\u5165\u308a\u306b\u8ffd\u52a0\u3057\u3066\u4fdd\u5b58\u3057\u307e\u3059\u3002",
        savedInDevice: "\u4fdd\u5b58\u6e08\u307f",
        downloadDevice: "\u7aef\u672b\u306b\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9",
        languageSelect: "\u8a00\u8a9e\u8a2d\u5b9a",
        languagesCount: "12\u8a00\u8a9e",
        audioQuality: "\u97f3\u8cea",
        audioQualityDesc: "Ultra HQ Edge FLAC / AAC\u9ad8\u97f3\u8cea\u30b9\u30c8\u30ea\u30fc\u30df\u30f3\u30b0",
        qualityHigh: "\u9ad8",
        qualityNormal: "\u6a19\u6e96",
        qualityData: "\u7bc0\u7d04",
        aboutSubtitle: "\u5206\u6563\u578b\u97f3\u697d\u30b9\u30c8\u30ea\u30fc\u30df\u30f3\u30b0",
        dataAndPrivacy: "\u30c7\u30fc\u30bf\u3068\u30d7\u30e9\u30a4\u30d0\u30b7\u30fc",
        searchHistory: "\u691c\u7d22\u5c65\u6b74",
        clearSearchHistoryDesc: "\u6700\u8fd1\u306e\u691c\u7d22\u30c6\u30ad\u30b9\u30c8\u3092\u524a\u9664",
        clearPlaybackHistoryDesc: "\u518d\u751f\u5c65\u6b74\u3092\u524a\u9664",
        clearHistory: "\u5c65\u6b74\u3092\u524a\u9664",
        clearHistoryConfirm: "\u518d\u751f\u5c65\u6b74\u3092\u5168\u3066\u524a\u9664\u3057\u307e\u3059\u304b\uff1f",
        historyCleared: "\u5c65\u6b74\u3092\u524a\u9664\u3057\u307e\u3057\u305f",
        noHistoryYet: "\u307e\u3060\u518d\u751f\u5c65\u6b74\u304c\u3042\u308a\u307e\u305b\u3093\u3002",
        likedToast: "\u304a\u6c17\u306b\u5165\u308a\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f",
        unlikedToast: "\u304a\u6c17\u306b\u5165\u308a\u304b\u3089\u524a\u9664\u3057\u307e\u3057\u305f",
        downloadStarting: "\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u4e2d...",
        downloadComplete: "\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u5b8c\u4e86",
        downloadUnavailable: "\u5229\u7528\u4e0d\u53ef",
        cat_all: "\u3059\u3079\u3066",
        cat_workout: "\u30ef\u30fc\u30af\u30a2\u30a6\u30c8",
        cat_energy: "\u30a8\u30cd\u30eb\u30ae\u30fc",
        cat_relax: "\u30ea\u30e9\u30c3\u30af\u30b9",
        cat_focus: "\u96c6\u4e2d",
        cat_party: "\u30d1\u30fc\u30c6\u30a3\u30fc",
        cat_commute: "\u901a\u52e4",
        cat_rock: "\u30ed\u30c3\u30af",
        cat_urban: "\u30a2\u30fc\u30d0\u30f3",
        albums: "\u30a2\u30eb\u30d0\u30e0",
        myAlbums: "\u3042\u306a\u305f\u306e\u30a2\u30eb\u30d0\u30e0",
        albumsSub: "\u30ab\u30b9\u30bf\u30e0\u30a2\u30eb\u30d0\u30e0",
        customAlbum: "\u30a2\u30eb\u30d0\u30e0",
        createAlbum: "\u30a2\u30eb\u30d0\u30e0\u4f5c\u6210",
        albumNamePrompt: "\u65b0\u3057\u3044\u30a2\u30eb\u30d0\u30e0\u540d:",
        albumCreatedToast: "\u30a2\u30eb\u30d0\u30e0\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f",
        albumDeletedToast: "\u30a2\u30eb\u30d0\u30e0\u3092\u524a\u9664\u3057\u307e\u3057\u305f",
        trackAddedToast: "\u66f2\u3092\u30a2\u30eb\u30d0\u30e0\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f",
        trackRemovedToast: "\u66f2\u3092\u524a\u9664\u3057\u307e\u3057\u305f",
        noAlbumsYet: "\u30a2\u30eb\u30d0\u30e0\u306f\u307e\u3060\u3042\u308a\u307e\u305b\u3093\u3002",
        noAlbumsHint: "\u30a2\u30eb\u30d0\u30e0\u3092\u4f5c\u6210\u3057\u3066\u97f3\u697d\u3092\u6574\u7406\u3057\u307e\u3057\u3087\u3046\u3002",
        playAll: "\u3059\u3079\u3066\u518d\u751f",
        deleteAlbum: "\u30a2\u30eb\u30d0\u30e0\u524a\u9664",
        deleteAlbumConfirm: "\u3053\u306e\u30a2\u30eb\u30d0\u30e0\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f",
        emptyAlbum: "\u3053\u306e\u30a2\u30eb\u30d0\u30e0\u306f\u7a7a\u3067\u3059\u3002",
        emptyAlbumHint: "\u66f2\u3092\u691c\u7d22\u3057\u3066\u8ffd\u52a0\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
        addToAlbum: "\u30a2\u30eb\u30d0\u30e0\u306b\u4fdd\u5b58",
        selectAlbumOrCreate: "\u30a2\u30eb\u30d0\u30e0\u3092\u9078\u629e\u307e\u305f\u306f\u65b0\u898f\u4f5c\u6210:",
        recentSearches: "\u6700\u8fd1\u306e\u691c\u7d22",
        clearSearchHistory: "\u5c65\u6b74\u3092\u524a\u9664",
        suggestedSearches: "\u304a\u3059\u3059\u3081\u306e\u691c\u7d22",
        searchHint: "\u30a2\u30fc\u30c6\u30a3\u30b9\u30c8\u3001\u66f2\u3001\u30a2\u30eb\u30d0\u30e0\u3092\u691c\u7d22...",
        noResults: "\u691c\u7d22\u7d50\u679c\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f\u3002",
        downloadSong: "\u66f2\u3092\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9",
        addToFavorites: "\u304a\u6c17\u306b\u5165\u308a\u306b\u8ffd\u52a0",
        removeFromFavorites: "\u304a\u6c17\u306b\u5165\u308a\u304b\u3089\u524a\u9664",
        copyLink: "\u30ea\u30f3\u30af\u3092\u30b3\u30d4\u30fc",
        linkCopiedToast: "\u30ea\u30f3\u30af\u3092\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f\uff01",
        cancel: "\u30ad\u30e3\u30f3\u30bb\u30eb",
        searchTabSongs: "\u66f2",
        searchTabAlbums: "\u30a2\u30eb\u30d0\u30e0",
        searchTabArtists: "\u30a2\u30fc\u30c6\u30a3\u30b9\u30c8",
        moodCurated: "\u304a\u3059\u3059\u3081\u306e\u697d\u66f2",
        backToHome: "\u30db\u30fc\u30e0",
        artistTracksCount: "\u66f2",
        getAppNav: "\u30a2\u30d7\u30ea\u3092\u5165\u624b",
        getAppSub: "Aurora Music \u3092 Android \u306b\u76f4\u63a5\u30fb\u5b89\u5168\u306b\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb",
        getAppSettingsBtn: "\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb",
        appPageTitle: "Android \u7248 Aurora Music",
        appPageSub: "\u3059\u3079\u3066\u306e\u97f3\u697d\u3092\u30cd\u30a4\u30c6\u30a3\u30d6\u30a2\u30d7\u30ea\u3067\uff1a\u901a\u77e5\u304b\u3089\u306e\u64cd\u4f5c\u3001\u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9\u518d\u751f\u3001\u30a6\u30a7\u30d6\u3068\u540c\u3058\u4f53\u9a13\u3002",
        appDownloadBtn: "APK \u3092\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9",
        appDownloadMeta: "\u30d0\u30fc\u30b8\u30e7\u30f3 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb\u65b9\u6cd5",
        appStep1Title: "APK \u3092\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9",
        appStep1Desc: "\u30dc\u30bf\u30f3\u3092\u30bf\u30c3\u30d7\u3059\u308b\u3068\u3001\u5916\u90e8\u30da\u30fc\u30b8\u306a\u3057\u3067\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u304c\u3059\u3050\u59cb\u307e\u308a\u307e\u3059\u3002",
        appStep2Title: "\u30d5\u30a1\u30a4\u30eb\u3092\u958b\u304f",
        appStep2Desc: "\u901a\u77e5\u307e\u305f\u306f\u30d5\u30a1\u30a4\u30eb\u30a2\u30d7\u30ea\u304b\u3089\u958b\u3044\u3066\u304f\u3060\u3055\u3044\u3002",
        appStep3Title: "\u8a31\u53ef\u3057\u3066\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb",
        appStep3Desc: "Android \u304c\u3053\u306e\u30bd\u30fc\u30b9\u304b\u3089\u306e\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb\u3092\u6c42\u3081\u3066\u304d\u305f\u3089\u3001\u8a31\u53ef\u3059\u308c\u3070\u5b8c\u4e86\u3067\u3059\u3002",
        appSecurityNote: "\u516c\u5f0f\u7f72\u540d\u6e08\u307f APK \u2014 GitHub \u304b\u3089\u76f4\u63a5\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb\u3001\u5916\u90e8\u30b9\u30c8\u30a2\u306a\u3057\u3002",
        appOtherPlatformNote: "Aurora Music \u30a2\u30d7\u30ea\u306f Android \u5c02\u7528\u3067\u3059\u3002iPhone\u30fbiPad\u30fbPC \u3067\u306f\u3001\u30a6\u30a7\u30d6\u7248\u3067\u540c\u3058\u4f53\u9a13\u3092\u304a\u697d\u3057\u307f\u304f\u3060\u3055\u3044\u3002",
        appInstalledNote: "Aurora Music \u306f\u3059\u3067\u306b\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb\u6e08\u307f\u3067\u3059 \u2014 \u4eca\u307e\u3055\u306b\u4f7f\u3063\u3066\u3044\u307e\u3059\u3002",
        appGithubBtn: "GitHub \u3067\u898b\u308b",
      },
      ko: {
        code: "KO",
        langName: "\ud55c\uad6d\uc5b4",
        home: "\ud648",
        explore: "\ud0d0\uc0c9",
        library: "\ubcf4\uad00\ud568",
        offline: "\uc624\ud504\ub77c\uc778",
        reconnecting: "\uc790\ub3d9\uc73c\ub85c \ub2e4\uc2dc \uc5f0\uacb0\ud558\ub294 \uc911...",
        settings: "\uc124\uc815",
        searchPlaceholder: "\ub178\ub798, \uc544\ud2f0\uc2a4\ud2b8, \uc568\ubc94 \uac80\uc0c9...",
        quickPicks: "\ub2e4\uc2dc \ub4e3\uae30",
        quickPicksSub: "\ube60\ub978 \uc811\uadfc",
        recommendedMix: "\ub9de\ucda4 \ucd94\ucc8c",
        recommendedMixSub: "\ud788\uc2a4\ud1a0\ub9ac \uae30\ubc18",
        trending: "\uc778\uae30 \uae09\uc0c1\uc2b9",
        trendingSub: "\ud604\uc7ac \ud56b\ud55c \ub178\ub798",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\ubb34\uc190\uc2e4 \uc74c\uc6d0",
        recentHistory: "\ucd5c\uadfc \uae30\ub85d",
        playbackHistory: "\uc7ac\uc0dd \uae30\ub85d",
        recentHistoryEmpty: "\uc7ac\uc0dd\ud55c \ub178\ub798\uac00 \uc5ec\uae30\uc5d0 \ud45c\uc2dc\ub429\ub2c8\ub2e4.",
        favoritesTitle: "\uc88b\uc544\ud558\ub294 \ub178\ub798",
        favoritesEmpty: "\uc88b\uc544\ud558\ub294 \ub178\ub798\ub97c \ucd94\uac00\ud558\uc138\uc694.",
        savedInDevice: "\uc800\uc7a5\ub428",
        downloadDevice: "\uae30\uae30\uc5d0 \ub2e4\uc6b4\ub85c\ub4dc",
        languageSelect: "\uc5b8\uc5b4 \uc124\uc815",
        languagesCount: "12\uac1c \uc5b8\uc5b4",
        audioQuality: "\uc74c\uc9c8",
        audioQualityDesc: "Ultra HQ Edge FLAC / 256kbps AAC \uace0\uc74c\uc9c8 \uc2a4\ud2b8\ub9ac\ubc0d",
        qualityHigh: "\ub192\uc74c",
        qualityNormal: "\ubcf4\ud1b5",
        qualityData: "\uc808\uc57d",
        aboutSubtitle: "\ud0c8\uc911\uc559\ud654 \uc624\ub514\uc624 \uc2a4\ud2b8\ub9ac\ubc0d",
        dataAndPrivacy: "\ub370\uc774\ud130 \ubc0f \uac1c\uc778\uc815\ubcf4",
        searchHistory: "\uac80\uc0c9 \uae30\ub85d",
        clearSearchHistoryDesc: "\ucd5c\uadfc \uac80\uc0c9\uc5b4 \uc0ad\uc81c",
        clearPlaybackHistoryDesc: "\uc7ac\uc0dd \uae30\ub85d \uc0ad\uc81c",
        clearHistory: "\uae30\ub85d \uc0ad\uc81c",
        clearHistoryConfirm: "\ubaa8\ub4e0 \uc7ac\uc0dd \uae30\ub85d\uc744 \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?",
        historyCleared: "\uae30\ub85d\uc774 \uc0ad\uc81c\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
        noHistoryYet: "\uc544\uc9c1 \uc7ac\uc0dd\ud55c \ub178\ub798\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.",
        likedToast: "\uc88b\uc544\uc694\uc5d0 \ucd94\uac00\ub428",
        unlikedToast: "\uc88b\uc544\uc694\uc5d0\uc11c \uc81c\uac70\ub428",
        downloadStarting: "\ub2e4\uc6b4\ub85c\ub4dc \uc911...",
        downloadComplete: "\ub2e4\uc6b4\ub85c\ub4dc \uc644\ub8cc",
        downloadUnavailable: "\uc0ac\uc6a9 \ubd88\uac00",
        cat_all: "\uc804\uccb4",
        cat_workout: "\uc6b4\ub3d9",
        cat_energy: "\uc5d0\ub108\uc9c0",
        cat_relax: "\ud734\uc2dd",
        cat_focus: "\uc9d1\uc911",
        cat_party: "\ud30c\ud2f0",
        cat_commute: "\uc774\ub3d9 \uc911",
        cat_rock: "\ub77d",
        cat_urban: "\uc5b4\ubc88",
        albums: "\uc568\ubc94",
        myAlbums: "\ub0b4 \uc568\ubc94",
        albumsSub: "\ucee4\uc2a4\ud140 \uc568\ubc94 \ubaa8\uc74c",
        customAlbum: "\ucee4\uc2a4\ud140 \uc568\ubc94",
        createAlbum: "\uc568\ubc94 \ub9cc\ub4e4\uae30",
        albumNamePrompt: "\uc0c8 \uc568\ubc94 \uc774\ub984:",
        albumCreatedToast: "\uc568\ubc94\uc774 \uc0dd\uc131\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
        albumDeletedToast: "\uc568\ubc94\uc774 \uc0ad\uc81c\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
        trackAddedToast: "\ub178\ub798\uac00 \uc568\ubc94\uc5d0 \uc800\uc7a5\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
        trackRemovedToast: "\ub178\ub798\uac00 \uc0ad\uc81c\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
        noAlbumsYet: "\uc0dd\uc131\ub41c \uc568\ubc94\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.",
        noAlbumsHint: "\uc568\ubc94\uc744 \ub9cc\ub4e4\uc5b4 \uc74c\uc545\uc744 \uc815\ub9ac\ud558\uc138\uc694.",
        playAll: "\uc804\uccb4 \uc7ac\uc0dd",
        deleteAlbum: "\uc568\ubc94 \uc0ad\uc81c",
        deleteAlbumConfirm: "\uc774 \uc568\ubc94\uc744 \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?",
        emptyAlbum: "\uc568\ubc94\uc774 \ube44\uc5b4 \uc788\uc2b5\ub2c8\ub2e4.",
        emptyAlbumHint: "\ub178\ub798\ub97c \uac80\uc0c9\ud558\uc5ec \uc5ec\uae30\uc5d0 \ucd94\uac00\ud558\uc138\uc694.",
        addToAlbum: "\uc568\ubc94\uc5d0 \uc800\uc7a5",
        selectAlbumOrCreate: "\uc568\ubc94\uc744 \uc120\ud0dd\ud558\uac70\ub098 \uc0c8\ub85c \ub9cc\ub4dc\uc138\uc694:",
        recentSearches: "\ucd5c\uadfc \uac80\uc0c9\uc5b4",
        clearSearchHistory: "\uae30\ub85d \uc0ad\uc81c",
        suggestedSearches: "\ucd94\ucc8c \uac80\uc0c9\uc5b4",
        searchHint: "\uc544\ud2f0\uc2a4\ud2b8, \ub178\ub798, \uc568\ubc94 \uac80\uc0c9...",
        noResults: "\uac80\uc0c9 \uac13\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.",
        downloadSong: "\ub178\ub798 \ub2e4\uc6b4\ub85c\ub4dc",
        addToFavorites: "\uc88b\uc544\uc694\uc5d0 \ucd94\uac00",
        removeFromFavorites: "\uc88b\uc544\uc694\uc5d0\uc11c \uc81c\uac70",
        copyLink: "\ub9c1\ud06c \ubcf5\uc0ac",
        linkCopiedToast: "\ub9c1\ud06c\uac00 \ubcf5\uc0ac\ub418\uc5c8\uc2b5\ub2c8\ub2e4!",
        cancel: "\ucde8\uc18c",
        searchTabSongs: "\ub178\ub798",
        searchTabAlbums: "\uc568\ubc94",
        searchTabArtists: "\uc544\ud2f0\uc2a4\ud2b8",
        moodCurated: "\ucd94\ucc8c \uc74c\uc545",
        backToHome: "\ud648",
        artistTracksCount: "\uace1",
        getAppNav: "\uc571 \ubc1b\uae30",
        getAppSub: "Android\uc5d0 Aurora Music \uc124\uce58 \u2014 \uc9c1\uc811 \ub2e4\uc6b4\ub85c\ub4dc, \uc548\uc804\ud558\uac8c",
        getAppSettingsBtn: "\uc124\uce58",
        appPageTitle: "Android\uc6a9 Aurora Music",
        appPageSub: "\ubaa8\ub4e0 \uc74c\uc545\uc744 \ub124\uc774\ud2f0\ube0c \uc571\uc5d0\uc11c: \uc54c\ub9bc\uc73c\ub85c \uc81c\uc5b4, \ubc31\uadf8\ub77c\uc6b4\ub4dc \uc7ac\uc0dd, \uc6f9\uacfc \ub3d9\uc77c\ud55c \uacbd\ud5d8.",
        appDownloadBtn: "APK \ub2e4\uc6b4\ub85c\ub4dc",
        appDownloadMeta: "\ubc84\uc804 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "\uc124\uce58 \ubc29\ubc95",
        appStep1Title: "APK \ub2e4\uc6b4\ub85c\ub4dc",
        appStep1Desc: "\ubc84\ud2bc\uc744 \ub204\ub974\uba74 \uc678\ubd80 \ud398\uc774\uc9c0 \uc5c6\uc774 \ubc14\ub85c \ub2e4\uc6b4\ub85c\ub4dc\uac00 \uc2dc\uc791\ub429\ub2c8\ub2e4.",
        appStep2Title: "\ud30c\uc77c \uc5f4\uae30",
        appStep2Desc: "\uc54c\ub9bc\uc774\ub098 \ud30c\uc77c \uc571\uc5d0\uc11c \uc5f4\uc5b4\uc8fc\uc138\uc694.",
        appStep3Title: "\ud5c8\uc6a9 \ud6c4 \uc124\uce58",
        appStep3Desc: "Android\uc5d0\uc11c \uc774 \ucd9c\ucc98\uc758 \uc124\uce58 \uad8c\ud55c\uc744 \uc694\uccad\ud558\uba74 \ud5c8\uc6a9\ud558\uba74 \uc644\ub8cc\ub429\ub2c8\ub2e4.",
        appSecurityNote: "\uacf5\uc2dd \uc11c\uba85\ub41c APK \u2014 GitHub\uc5d0\uc11c \uc9c1\uc811 \uc124\uce58, \uc678\ubd80 \uc2a4\ud1a0\uc5b4 \uc5c6\uc74c.",
        appOtherPlatformNote: "Aurora Music \uc571\uc740 Android \uc804\uc6a9\uc785\ub2c8\ub2e4. iPhone, iPad, PC\uc5d0\uc11c\ub294 \uc6f9\uc5d0\uc11c \ub3d9\uc77c\ud55c \uacbd\ud5d8\uc744 \uc990\uae30\uc138\uc694.",
        appInstalledNote: "\uc774\ubbf8 Aurora Music\uc774 \uc124\uce58\ub418\uc5b4 \uc788\uc5b4\uc694 \u2014 \uc9c0\uae08 \ubc14\ub85c \uc0ac\uc6a9 \uc911\uc774\uc2dc\ub124\uc694.",
        appGithubBtn: "GitHub\uc5d0\uc11c \ubcf4\uae30",
      },
      zh: {
        code: "ZH",
        langName: "\u7b80\u4f53\u4e2d\u6587",
        home: "\u9996\u9875",
        explore: "\u63a2\u7d22",
        library: "\u97f3\u4e50\u5e93",
        offline: "\u79bb\u7ebf",
        reconnecting: "\u6b63\u5728\u81ea\u52a8\u91cd\u65b0\u8fde\u63a5...",
        settings: "\u8bbe\u7f6e",
        searchPlaceholder: "\u641c\u7d22\u6b4c\u66f2\u3001\u827a\u4eba\u3001\u4e13\u8f91...",
        quickPicks: "\u518d\u6b21\u8046\u542c",
        quickPicksSub: "\u5feb\u6377\u8bbf\u95ee",
        recommendedMix: "\u4e3a\u4f60\u63a8\u8350",
        recommendedMixSub: "\u57fa\u4e8e\u5386\u53f2\u63a8\u8350",
        trending: "\u6392\u884c\u699c",
        trendingSub: "\u70ed\u95e8\u6b4c\u66f2",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\u65e0\u635f\u97f3\u8d28",
        recentHistory: "\u6700\u8fd1\u64ad\u653e",
        playbackHistory: "\u64ad\u653e\u5386\u53f2",
        recentHistoryEmpty: "\u64ad\u653e\u7684\u6b4c\u66f2\u5c06\u663e\u793a\u5728\u8fd9\u91cc\u3002",
        favoritesTitle: "\u6211\u559c\u6b22\u7684\u97f3\u4e50",
        favoritesEmpty: "\u6dfb\u52a0\u6b4c\u66f2\u5230\u6536\u85cf\u5939\u3002",
        savedInDevice: "\u5df2\u4fdd\u5b58",
        downloadDevice: "\u4e0b\u8f7d\u5230\u8bbe\u5907",
        languageSelect: "\u754c\u9762\u8bed\u8a00",
        languagesCount: "12\u79cd\u8bed\u8a00",
        audioQuality: "\u97f3\u8d28",
        audioQualityDesc: "Ultra HQ Edge FLAC / 256kbps AAC\u9ad8\u6e05\u6d41\u5a92\u4f53",
        qualityHigh: "\u9ad8",
        qualityNormal: "\u6807\u51c6",
        qualityData: "\u7701\u6d41\u91cf",
        aboutSubtitle: "\u53bb\u4e2d\u5fc3\u5316\u97f3\u4e50\u5f15\u64ce",
        dataAndPrivacy: "\u6570\u636e\u4e0e\u9690\u79c1",
        searchHistory: "\u641c\u7d22\u5386\u53f2",
        clearSearchHistoryDesc: "\u6e05\u7406\u6700\u8fd1\u641c\u7d22\u8bcd",
        clearPlaybackHistoryDesc: "\u6e05\u7406\u64ad\u653e\u5386\u53f2",
        clearHistory: "\u6e05\u7a7a\u5386\u53f2",
        clearHistoryConfirm: "\u786e\u5b9a\u6e05\u7a7a\u6240\u6709\u64ad\u653e\u5386\u53f2\u5417\uff1f",
        historyCleared: "\u5386\u53f2\u5df2\u6e05\u7a7a",
        noHistoryYet: "\u6682\u65e0\u64ad\u653e\u5386\u53f2\u3002",
        likedToast: "\u5df2\u6dfb\u52a0\u5230\u559c\u6b22",
        unlikedToast: "\u5df2\u4ece\u559c\u6b22\u4e2d\u79fb\u9664",
        downloadStarting: "\u6b63\u5728\u4e0b\u8f7d...",
        downloadComplete: "\u4e0b\u8f7d\u5b8c\u6210",
        downloadUnavailable: "\u6682\u4e0d\u53ef\u7528",
        cat_all: "\u5168\u90e8",
        cat_workout: "\u5065\u8eab",
        cat_energy: "\u6d3b\u529b",
        cat_relax: "\u653e\u677e",
        cat_focus: "\u4e13\u6ce8",
        cat_party: "\u6d3e\u5bf9",
        cat_commute: "\u901a\u52e4",
        cat_rock: "\u6447\u6eda",
        cat_urban: "\u90fd\u5e02",
        albums: "\u4e13\u8f91",
        myAlbums: "\u6211\u7684\u4e13\u8f91",
        albumsSub: "\u81ea\u5b9a\u4e49\u4e13\u8f91\u6536\u85cf",
        customAlbum: "\u81ea\u5b9a\u4e49\u4e13\u8f91",
        createAlbum: "\u521b\u5efa\u4e13\u8f91",
        albumNamePrompt: "\u65b0\u4e13\u8f91\u540d\u79f0:",
        albumCreatedToast: "\u4e13\u8f91\u5df2\u521b\u5efa",
        albumDeletedToast: "\u4e13\u8f91\u5df2\u5220\u9664",
        trackAddedToast: "\u6b4c\u66f2\u5df2\u4fdd\u5b58\u5230\u4e13\u8f91",
        trackRemovedToast: "\u6b4c\u66f2\u5df2\u79fb\u9664",
        noAlbumsYet: "\u6682\u65e0\u81ea\u5b9a\u4e49\u4e13\u8f91\u3002",
        noAlbumsHint: "\u521b\u5efa\u4e13\u8f91\u6765\u6574\u7406\u60a8\u559c\u7231\u7684\u97f3\u4e50\u3002",
        playAll: "\u64ad\u653e\u5168\u90e8",
        deleteAlbum: "\u5220\u9664\u4e13\u8f91",
        deleteAlbumConfirm: "\u786e\u5b9a\u8981\u5220\u9664\u6b64\u4e13\u8f91\u5417\uff1f",
        emptyAlbum: "\u6b64\u4e13\u8f91\u4e3a\u7a7a\u3002",
        emptyAlbumHint: "\u641c\u7d22\u6b4c\u66f2\u5e76\u70b9\u51fb\u4e09\u4e2a\u70b9\u6dfb\u52a0\u5230\u6b64\u5904\u3002",
        addToAlbum: "\u4fdd\u5b58\u5230\u4e13\u8f91",
        selectAlbumOrCreate: "\u9009\u62e9\u4e13\u8f91\u6216\u65b0\u5efa\u4e13\u8f91:",
        recentSearches: "\u6700\u8fd1\u641c\u7d22",
        clearSearchHistory: "\u6e05\u7a7a\u5386\u53f2",
        suggestedSearches: "\u63a8\u8350\u641c\u7d22",
        searchHint: "\u641c\u7d22\u827a\u4eba\u3001\u6b4c\u66f2\u6216\u4e13\u8f91...",
        noResults: "\u672a\u627e\u5230\u7ed3\u679c\u3002",
        downloadSong: "\u4e0b\u8f7d\u6b4c\u66f2",
        addToFavorites: "\u6dfb\u52a0\u5230\u6211\u559c\u6b22\u7684",
        removeFromFavorites: "\u4ece\u6211\u559c\u6b22\u7684\u4e2d\u79fb\u9664",
        copyLink: "\u590d\u5236\u94fe\u63a5",
        linkCopiedToast: "\u94fe\u63a5\u5df2\u590d\u5236\uff01",
        cancel: "\u53d6\u6d88",
        searchTabSongs: "\u6b4c\u66f2",
        searchTabAlbums: "\u4e13\u8f91",
        searchTabArtists: "\u827a\u4eba",
        moodCurated: "\u7cbe\u9009\u97f3\u4e50",
        backToHome: "\u9996\u9875",
        artistTracksCount: "\u9996",
        getAppNav: "\u83b7\u53d6\u5e94\u7528",
        getAppSub: "\u76f4\u63a5\u3001\u5b89\u5168\u5730\u5728 Android \u4e0a\u5b89\u88c5 Aurora Music",
        getAppSettingsBtn: "\u5b89\u88c5",
        appPageTitle: "Android \u7248 Aurora Music",
        appPageSub: "\u6240\u6709\u97f3\u4e50\u5c3d\u5728\u539f\u751f\u5e94\u7528\uff1a\u901a\u77e5\u680f\u63a7\u5236\u3001\u540e\u53f0\u64ad\u653e\uff0c\u4ee5\u53ca\u4e0e\u7f51\u9875\u7248\u76f8\u540c\u7684\u4f53\u9a8c\u3002",
        appDownloadBtn: "\u4e0b\u8f7d APK",
        appDownloadMeta: "\u7248\u672c 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "\u5b89\u88c5\u6b65\u9aa4",
        appStep1Title: "\u4e0b\u8f7d APK",
        appStep1Desc: "\u70b9\u51fb\u6309\u94ae\uff0c\u4e0b\u8f7d\u7acb\u5373\u5f00\u59cb\uff0c\u65e0\u9700\u8df3\u8f6c\u5916\u90e8\u9875\u9762\u3002",
        appStep2Title: "\u6253\u5f00\u6587\u4ef6",
        appStep2Desc: "\u4ece\u901a\u77e5\u680f\u6216\u6587\u4ef6\u7ba1\u7406\u5668\u4e2d\u6253\u5f00\u3002",
        appStep3Title: "\u5141\u8bb8\u5e76\u5b89\u88c5",
        appStep3Desc: "Android \u4f1a\u8bf7\u6c42\u5141\u8bb8\u4ece\u6b64\u6765\u6e90\u5b89\u88c5\u5e94\u7528\uff0c\u5141\u8bb8\u540e\u5373\u53ef\u5b8c\u6210\u3002",
        appSecurityNote: "\u5b98\u65b9\u7b7e\u540d APK \u2014 \u4ece GitHub \u76f4\u63a5\u5b89\u88c5\uff0c\u65e0\u5916\u90e8\u5546\u5e97\u3002",
        appOtherPlatformNote: "Aurora Music \u5e94\u7528\u4ec5\u652f\u6301 Android\u3002iPhone\u3001iPad \u6216\u7535\u8111\u4e0a\u8bf7\u7ee7\u7eed\u4f7f\u7528\u7f51\u9875\u7248\uff0c\u4f53\u9a8c\u5b8c\u5168\u76f8\u540c\u3002",
        appInstalledNote: "\u4f60\u5df2\u5b89\u88c5 Aurora Music \u2014 \u73b0\u5728\u6b63\u5728\u4f7f\u7528\u4e2d\u3002",
        appGithubBtn: "\u5728 GitHub \u4e0a\u67e5\u770b",
      },
      ar: {
        code: "AR",
        langName: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629",
        home: "\u0627\u0644\u0631\u0626\u064a\u0633\u064a\u0629",
        explore: "\u0627\u0633\u062a\u0643\u0634\u0627\u0641",
        library: "\u0627\u0644\u0645\u0643\u062a\u0628\u0629",
        offline: "\u062f\u0648\u0646 \u0627\u062a\u0635\u0627\u0644",
        reconnecting: "\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0627\u062a\u0635\u0627\u0644 \u062a\u0644\u0642\u0627\u0626\u064a\u064b\u0627...",
        settings: "\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a",
        searchPlaceholder: "\u0627\u0628\u062d\u062b \u0639\u0646 \u0623\u063a\u0627\u0646\u064a \u0623\u0648 \u0641\u0646\u0627\u0646\u064a\u0646...",
        quickPicks: "\u0627\u0633\u062a\u0645\u0639 \u0645\u062c\u062f\u062f\u0627\u064b",
        quickPicksSub: "\u0627\u062e\u062a\u0635\u0627\u0631\u0627\u062a\u0643",
        recommendedMix: "\u0644\u0623\u062c\u0644\u0643",
        recommendedMixSub: "\u0645\u0646 \u0633\u062c\u0644\u0643",
        trending: "\u0627\u0644\u0631\u0627\u0626\u062c",
        trendingSub: "\u0623\u0641\u0636\u0644 \u0627\u0644\u0623\u063a\u0627\u0646\u064a",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\u0635\u0648\u062a \u0639\u0627\u0644\u064a \u0627\u0644\u062f\u0642\u0629",
        recentHistory: "\u0627\u0644\u0633\u062c\u0644 \u0627\u0644\u0623\u062e\u064a\u0631",
        playbackHistory: "\u0633\u062c\u0644 \u0627\u0644\u062a\u0634\u063a\u064a\u0644",
        recentHistoryEmpty: "\u0633\u062a\u0638\u0647\u0631 \u0627\u0644\u0623\u063a\u0627\u0646\u064a \u0647\u0646\u0627.",
        favoritesTitle: "\u0627\u0644\u0645\u0641\u0636\u0644\u0629",
        favoritesEmpty: "\u0623\u0636\u0641 \u0623\u063a\u0627\u0646\u064a \u0625\u0644\u0649 \u0627\u0644\u0645\u0641\u0636\u0644\u0629.",
        savedInDevice: "\u0645\u062d\u0641\u0648\u0638\u0629",
        downloadDevice: "\u062a\u062d\u0645\u064a\u0644 \u0639\u0644\u0649 \u0627\u0644\u062c\u0647\u0627\u0632",
        languageSelect: "\u0644\u063a\u0629 \u0627\u0644\u0648\u0627\u062c\u0647\u0629",
        languagesCount: "12 \u0644\u063a\u0629",
        audioQuality: "\u062c\u0648\u062f\u0629 \u0627\u0644\u0635\u0648\u062a",
        audioQualityDesc: "\u0628\u062b \u0641\u0627\u0626\u0642 \u0627\u0644\u062c\u0648\u062f\u0629 \u0639\u0628\u0631 Ultra HQ Edge",
        qualityHigh: "\u0639\u0627\u0644\u064a\u0629",
        qualityNormal: "\u0639\u0627\u062f\u064a\u0629",
        qualityData: "\u062a\u0648\u0641\u064a\u0631",
        aboutSubtitle: "\u0645\u062d\u0631\u0643 \u0635\u0648\u062a\u064a \u0644\u0627\u0645\u0631\u0643\u0632\u064a",
        dataAndPrivacy: "\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0648\u0627\u0644\u062e\u0635\u0648\u0635\u064a\u0629",
        searchHistory: "\u0633\u062c\u0644 \u0627\u0644\u0628\u062d\u062b",
        clearSearchHistoryDesc: "\u062d\u0630\u0641 \u0639\u0645\u0644\u064a\u0627\u062a \u0627\u0644\u0628\u062d\u062b \u0627\u0644\u0623\u062e\u064a\u0631\u0629",
        clearPlaybackHistoryDesc: "\u062d\u0630\u0641 \u0633\u062c\u0644 \u0627\u0644\u062a\u0634\u063a\u064a\u0644",
        clearHistory: "\u0645\u0633\u062d \u0627\u0644\u0633\u062c\u0644",
        clearHistoryConfirm: "\u0647\u0644 \u062a\u0631\u064a\u062f \u0645\u0633\u062d \u0627\u0644\u0633\u062c\u0644 \u0628\u0627\u0644\u0643\u0627\u0645\u0644\u061f",
        historyCleared: "\u062a\u0645 \u0645\u0633\u062d \u0627\u0644\u0633\u062c\u0644",
        noHistoryYet: "\u0644\u0645 \u062a\u0633\u062a\u0645\u0639 \u0625\u0644\u0649 \u0623\u064a \u0623\u063a\u0646\u064a\u0629 \u0628\u0639\u062f.",
        likedToast: "\u062a\u0645\u062a \u0627\u0644\u0625\u0636\u0627\u0641\u0629 \u0644\u0644\u0645\u0641\u0636\u0644\u0629",
        unlikedToast: "\u062a\u0645\u062a \u0627\u0644\u0625\u0632\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0645\u0641\u0636\u0644\u0629",
        downloadStarting: "\u062c\u0627\u0631\u064d \u0627\u0644\u062a\u062d\u0645\u064a\u0644...",
        downloadComplete: "\u062a\u0645 \u0627\u0644\u062a\u062d\u0645\u064a\u0644",
        downloadUnavailable: "\u063a\u064a\u0631 \u0645\u062a\u0627\u062d",
        cat_all: "\u0627\u0644\u0643\u0644",
        cat_workout: "\u062a\u0645\u0627\u0631\u064a\u0646",
        cat_energy: "\u0637\u0627\u0642\u0629",
        cat_relax: "\u0627\u0633\u062a\u0631\u062e\u0627\u0621",
        cat_focus: "\u062a\u0631\u0643\u064a\u0632",
        cat_party: "\u062d\u0641\u0644\u0629",
        cat_commute: "\u0633\u0641\u0631",
        cat_rock: "\u0631\u0648\u0643",
        cat_urban: "\u062d\u0636\u0631\u064a",
        albums: "\u0623\u0644\u0628\u0648\u0645\u0627\u062a",
        myAlbums: "\u0623\u0644\u0628\u0648\u0645\u0627\u062a\u0643",
        albumsSub: "\u0645\u062c\u0645\u0648\u0639\u0629 \u0627\u0644\u0623\u0644\u0628\u0648\u0645\u0627\u062a",
        customAlbum: "\u0623\u0644\u0628\u0648\u0645 \u0645\u062e\u0635\u0635",
        createAlbum: "\u0625\u0646\u0634\u0627\u0621 \u0623\u0644\u0628\u0648\u0645",
        albumNamePrompt: "\u0627\u0633\u0645 \u0627\u0644\u0623\u0644\u0628\u0648\u0645 \u0627\u0644\u062c\u062f\u064a\u062f:",
        albumCreatedToast: "\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u0623\u0644\u0628\u0648\u0645",
        albumDeletedToast: "\u062a\u0645 \u062d\u0630\u0641 \u0627\u0644\u0623\u0644\u0628\u0648\u0645",
        trackAddedToast: "\u062a\u0645\u062a \u0625\u0636\u0627\u0641\u0629 \u0627\u0644\u0623\u063a\u0646\u064a\u0629 \u0644\u0644\u0623\u0644\u0628\u0648\u0645",
        trackRemovedToast: "\u062a\u0645\u062a \u0625\u0632\u0627\u0644\u0629 \u0627\u0644\u0623\u063a\u0646\u064a\u0629",
        noAlbumsYet: "\u0644\u0627 \u062a\u0648\u062c\u062f \u0623\u0644\u0628\u0648\u0645\u0627\u062a \u0628\u0639\u062f.",
        noAlbumsHint: "\u0623\u0646\u0634\u0626 \u0623\u0644\u0628\u0648\u0645\u0627\u064b \u0644\u062a\u0646\u0638\u064a\u0645 \u0645\u0648\u0633\u064a\u0642\u0627\u0643.",
        playAll: "\u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0643\u0644",
        deleteAlbum: "\u062d\u0630\u0641 \u0627\u0644\u0623\u0644\u0628\u0648\u0645",
        deleteAlbumConfirm: "\u0647\u0644 \u062a\u0631\u064a\u062f \u062d\u0630\u0641 \u0647\u0630\u0627 \u0627\u0644\u0623\u0644\u0628\u0648\u0645\u061f",
        emptyAlbum: "\u0647\u0630\u0627 \u0627\u0644\u0623\u0644\u0628\u0648\u0645 \u0641\u0627\u0631\u063a.",
        emptyAlbumHint: "\u0627\u0628\u062d\u062f \u0639\u0646 \u0623\u063a\u0627\u0646\u064a \u0644\u0625\u0636\u0627\u0641\u062a\u0647\u0627 \u0647\u0646\u0627.",
        addToAlbum: "\u062d\u0641\u0638 \u0641\u064a \u0623\u0644\u0628\u0648\u0645",
        selectAlbumOrCreate: "\u0627\u062e\u062a\u0631 \u0623\u0644\u0628\u0648\u0645\u0627\u064b \u0623\u0648 \u0623\u0646\u0634\u0626 \u0648\u0627\u062d\u062f\u0627\u064b:",
        recentSearches: "\u0639\u0645\u0644\u064a\u0627\u062a \u0627\u0644\u0628\u062d\u062b \u0627\u0644\u0623\u062e\u064a\u0631\u0629",
        clearSearchHistory: "\u0645\u0633\u062d \u0627\u0644\u0633\u062c\u0644",
        suggestedSearches: "\u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a",
        searchHint: "\u0627\u0628\u062d\u062b \u0639\u0646 \u0641\u0646\u0627\u0646\u064a\u0646 \u0623\u0648 \u0623\u063a\u0627\u0646\u064a...",
        noResults: "\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0646\u062a\u0627\u0626\u062c.",
        downloadSong: "\u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0623\u063a\u0646\u064a\u0629",
        addToFavorites: "\u0625\u0636\u0627\u0641\u0629 \u0644\u0644\u0645\u0641\u0636\u0644\u0629",
        removeFromFavorites: "\u0625\u0632\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0645\u0641\u0636\u0644\u0629",
        copyLink: "\u0646\u0633\u062e \u0627\u0644\u0631\u0627\u0628\u0637",
        linkCopiedToast: "\u062a\u0645 \u0646\u0633\u062e \u0627\u0644\u0631\u0627\u0628\u0637!",
        cancel: "\u0625\u0644\u063a\u0627\u0621",
        searchTabSongs: "\u0623\u063a\u0627\u0646\u064a",
        searchTabAlbums: "\u0623\u0644\u0628\u0648\u0645\u0627\u062a",
        searchTabArtists: "\u0641\u0646\u0627\u0646\u0648\u0646",
        moodCurated: "\u0645\u0648\u0633\u064a\u0642\u0649 \u0645\u062e\u062a\u0627\u0631\u0629",
        backToHome: "\u0627\u0644\u0631\u0626\u064a\u0633\u064a\u0629",
        artistTracksCount: "\u0623\u063a\u0627\u0646\u064a",
        getAppNav: "\u0627\u062d\u0635\u0644 \u0639\u0644\u0649 \u0627\u0644\u062a\u0637\u0628\u064a\u0642",
        getAppSub: "\u062b\u0628\u0651\u062a Aurora Music \u0639\u0644\u0649 \u0623\u0646\u062f\u0631\u0648\u064a\u062f \u2014 \u0645\u0628\u0627\u0634\u0631\u0629 \u0648\u0628\u0623\u0645\u0627\u0646",
        getAppSettingsBtn: "\u062a\u062b\u0628\u064a\u062a",
        appPageTitle: "Aurora Music \u0644\u0623\u0646\u062f\u0631\u0648\u064a\u062f",
        appPageSub: "\u0643\u0644 \u0645\u0648\u0633\u064a\u0642\u0627\u0643 \u0641\u064a \u062a\u0637\u0628\u064a\u0642 \u0623\u0635\u0644\u064a: \u062a\u062d\u0643\u0645 \u0645\u0646 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062a\u060c \u062a\u0634\u063a\u064a\u0644 \u0641\u064a \u0627\u0644\u062e\u0644\u0641\u064a\u0629\u060c \u0648\u0646\u0641\u0633 \u062a\u062c\u0631\u0628\u0629 \u0627\u0644\u0648\u064a\u0628.",
        appDownloadBtn: "\u062a\u0646\u0632\u064a\u0644 APK",
        appDownloadMeta: "\u0627\u0644\u0625\u0635\u062f\u0627\u0631 1.0.0 \u00b7 ~102 \u0645\u064a\u062c\u0627\u0628\u0627\u064a\u062a \u00b7 \u0623\u0646\u062f\u0631\u0648\u064a\u062f 7.0+",
        appStepsTitle: "\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062a\u062b\u0628\u064a\u062a",
        appStep1Title: "\u0646\u0632\u0651\u0644 \u0645\u0644\u0641 APK",
        appStep1Desc: "\u0627\u0636\u063a\u0637 \u0627\u0644\u0632\u0631 \u0648\u0633\u064a\u0628\u062f\u0623 \u0627\u0644\u062a\u0646\u0632\u064a\u0644 \u0641\u0648\u0631\u064b\u0627\u060c \u062f\u0648\u0646 \u0635\u0641\u062d\u0627\u062a \u062e\u0627\u0631\u062c\u064a\u0629.",
        appStep2Title: "\u0627\u0641\u062a\u062d \u0627\u0644\u0645\u0644\u0641",
        appStep2Desc: "\u0627\u0641\u062a\u062d\u0647 \u0645\u0646 \u0627\u0644\u0625\u0634\u0639\u0627\u0631 \u0623\u0648 \u0645\u0646 \u062a\u0637\u0628\u064a\u0642 \u0627\u0644\u0645\u0644\u0641\u0627\u062a.",
        appStep3Title: "\u0627\u0633\u0645\u062d \u062b\u0645 \u062b\u0628\u0651\u062a",
        appStep3Desc: "\u0633\u064a\u0637\u0644\u0628 \u0623\u0646\u062f\u0631\u0648\u064a\u062f \u0627\u0644\u0633\u0645\u0627\u062d \u0628\u0627\u0644\u062a\u062b\u0628\u064a\u062a \u0645\u0646 \u0647\u0630\u0627 \u0627\u0644\u0645\u0635\u062f\u0631. \u0648\u0627\u0641\u0642 \u0648\u0633\u064a\u0643\u062a\u0645\u0644 \u0627\u0644\u062a\u062b\u0628\u064a\u062a.",
        appSecurityNote: "APK \u0645\u0648\u0642\u0651\u0639 \u0631\u0633\u0645\u064a\u064b\u0627 \u2014 \u062a\u062b\u0628\u064a\u062a \u0645\u0628\u0627\u0634\u0631 \u0645\u0646 GitHub \u062f\u0648\u0646 \u0645\u062a\u0627\u062c\u0631 \u062e\u0627\u0631\u062c\u064a\u0629.",
        appOtherPlatformNote: "\u062a\u0637\u0628\u064a\u0642 Aurora Music \u0645\u062a\u0627\u062d \u0644\u0623\u0646\u062f\u0631\u0648\u064a\u062f \u0641\u0642\u0637. \u0639\u0644\u0649 iPhone \u0623\u0648 iPad \u0623\u0648 \u0627\u0644\u0643\u0645\u0628\u064a\u0648\u062a\u0631\u060c \u0627\u0633\u062a\u0645\u062a\u0639 \u0628\u0646\u0641\u0633 \u0627\u0644\u062a\u062c\u0631\u0628\u0629 \u0639\u0628\u0631 \u0627\u0644\u0648\u064a\u0628.",
        appInstalledNote: "\u0644\u062f\u064a\u0643 Aurora Music \u0645\u062b\u0628\u0651\u062a \u0628\u0627\u0644\u0641\u0639\u0644 \u2014 \u0623\u0646\u062a \u062a\u0633\u062a\u062e\u062f\u0645\u0647 \u0627\u0644\u0622\u0646.",
        appGithubBtn: "\u0639\u0631\u0636 \u0639\u0644\u0649 GitHub",
      },
      hi: {
        code: "HI",
        langName: "\u0939\u093f\u0928\u094d\u0926\u0940",
        home: "\u0939\u094b\u092e",
        explore: "\u090f\u0915\u094d\u0938\u092a\u094d\u0932\u094b\u0930",
        library: "\u0932\u093e\u0907\u092c\u094d\u0930\u0947\u0930\u0940",
        offline: "\u0911\u092b\u0932\u093e\u0907\u0928",
        reconnecting: "\u0938\u094d\u0935\u0924\u0903 \u092a\u0941\u0928\u0903 \u0915\u0928\u0947\u0915\u094d\u091f \u0939\u094b \u0930\u0939\u093e \u0939\u0948...",
        settings: "\u0938\u0947\u091f\u093f\u0902\u0917",
        searchPlaceholder: "\u0917\u093e\u0928\u0947, \u0915\u0932\u093e\u0915\u093e\u0930 \u0916\u094b\u091c\u0947\u0902...",
        quickPicks: "\u092b\u093f\u0930 \u0938\u0941\u0928\u0947\u0902",
        quickPicksSub: "\u0924\u094d\u0935\u0930\u093f\u0924 \u092a\u0939\u0941\u0902\u091a",
        recommendedMix: "\u0906\u092a\u0915\u0947 \u0932\u093f\u090f",
        recommendedMixSub: "\u0907\u0924\u093f\u0939\u093e\u0938 \u0938\u0947",
        trending: "\u091f\u094d\u0930\u0947\u0902\u0921\u093f\u0902\u0917",
        trendingSub: "\u0932\u094b\u0915\u092a\u094d\u0930\u093f\u092f \u0917\u093e\u0928\u0947",
        topCatalog: "Ultra HQ (R2)",
        topCatalogSub: "\u0932\u0949\u0938\u0932\u0947\u0938 \u0911\u0921\u093f\u092f\u094b",
        recentHistory: "\u0939\u093e\u0932\u093f\u092f\u093e \u0907\u0924\u093f\u0939\u093e\u0938",
        playbackHistory: "\u0917\u093e\u0928\u094b\u0902 \u0915\u093e \u0907\u0924\u093f\u0939\u093e\u0938",
        recentHistoryEmpty: "\u0906\u092a\u0915\u0947 \u0938\u0941\u0928\u0947 \u0917\u090f \u0917\u093e\u0928\u0947 \u092f\u0939\u093e\u0902 \u0926\u093f\u0916\u0947\u0902\u0917\u0947\u0964",
        favoritesTitle: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u0917\u093e\u0928\u0947",
        favoritesEmpty: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u092e\u0947\u0902 \u0917\u093e\u0928\u0947 \u091c\u094b\u0921\u093c\u0947\u0902\u0964",
        savedInDevice: "\u0938\u0941\u0930\u0915\u094d\u0937\u093f\u0924",
        downloadDevice: "\u0921\u093f\u0935\u093e\u0907\u0938 \u092a\u0930 \u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0915\u0930\u0947\u0902",
        languageSelect: "\u092d\u093e\u0937\u093e",
        languagesCount: "12 \u092d\u093e\u0937\u093e\u090f\u0902",
        audioQuality: "\u0911\u0921\u093f\u092f\u094b \u0917\u0941\u0923\u0935\u0924\u094d\u0924\u093e",
        audioQualityDesc: "Ultra HQ Edge FLAC / 256kbps AAC \u0938\u094d\u091f\u094d\u0930\u0940\u092e\u093f\u0902\u0917",
        qualityHigh: "\u0909\u091a\u094d\u091a",
        qualityNormal: "\u0938\u093e\u092e\u093e\u0928\u094d\u092f",
        qualityData: "\u092c\u091a\u0924",
        aboutSubtitle: "\u0935\u093f\u0915\u0947\u0902\u0926\u094d\u0930\u0940\u0915\u0943\u0924 \u0911\u0921\u093f\u092f\u094b \u0907\u0902\u091c\u0928",
        dataAndPrivacy: "\u0921\u0947\u091f\u093e \u0914\u0930 \u0917\u094b\u092a\u0928\u0940\u092f\u0924\u093e",
        searchHistory: "\u0916\u094b\u091c \u0907\u0924\u093f\u0939\u093e\u0938",
        clearSearchHistoryDesc: "\u0939\u093e\u0932\u093f\u092f\u093e \u0916\u094b\u091c \u0939\u091f\u093e\u090f\u0902",
        clearPlaybackHistoryDesc: "\u0938\u0941\u0928\u0947 \u0917\u090f \u0917\u093e\u0928\u0947 \u0939\u091f\u093e\u090f\u0902",
        clearHistory: "\u0907\u0924\u093f\u0939\u093e\u0938 \u092e\u093f\u091f\u093e\u090f\u0902",
        clearHistoryConfirm: "\u0915\u094d\u092f\u093e \u0906\u092a \u0938\u092d\u0940 \u0907\u0924\u093f\u0939\u093e\u0938 \u092e\u093f\u091f\u093e\u0928\u093e \u091a\u093e\u0939\u0924\u0947 \u0939\u0948\u0902?",
        historyCleared: "\u0907\u0924\u093f\u0939\u093e\u0938 \u092e\u093f\u091f\u093e \u0926\u093f\u092f\u093e \u0917\u092f\u093e",
        noHistoryYet: "\u0905\u092d\u0940 \u0924\u0915 \u0915\u094b\u0908 \u0917\u093e\u0928\u093e \u0928\u0939\u0940\u0902 \u0938\u0941\u0928\u093e \u0917\u092f\u093e\u0964",
        likedToast: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u092e\u0947\u0902 \u091c\u094b\u0921\u093c\u093e \u0917\u092f\u093e",
        unlikedToast: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u0938\u0947 \u0939\u091f\u093e\u092f\u093e \u0917\u092f\u093e",
        downloadStarting: "\u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0939\u094b \u0930\u0939\u093e \u0939\u0948...",
        downloadComplete: "\u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u092a\u0942\u0930\u093e \u0939\u0941\u0906",
        downloadUnavailable: "\u0909\u092a\u0932\u092c\u094d\u0927 \u0928\u0939\u0940\u0902",
        cat_all: "\u0938\u092d\u0940",
        cat_workout: "\u0935\u0930\u094d\u0915\u0906\u0909\u091f",
        cat_energy: "\u090a\u0930\u094d\u091c\u093e",
        cat_relax: "\u0930\u093f\u0932\u0948\u0915\u094d\u0938",
        cat_focus: "\u0927\u094d\u092f\u093e\u0928",
        cat_party: "\u092a\u093e\u0930\u094d\u091f\u0940",
        cat_commute: "\u092f\u093e\u0924\u094d\u0930\u093e",
        cat_rock: "\u0930\u0949\u0915",
        cat_urban: "\u0905\u0930\u094d\u092c\u0928",
        albums: "\u090f\u0932\u094d\u092c\u092e",
        myAlbums: "\u0906\u092a\u0915\u0947 \u090f\u0932\u094d\u092c\u092e",
        albumsSub: "\u0915\u0938\u094d\u091f\u092e \u090f\u0932\u094d\u092c\u092e",
        customAlbum: "\u090f\u0932\u094d\u092c\u092e",
        createAlbum: "\u090f\u0932\u094d\u092c\u092e \u092c\u0928\u093e\u090f\u0902",
        albumNamePrompt: "\u0928\u090f \u090f\u0932\u094d\u092c\u092e \u0915\u093e \u0928\u093e\u092e:",
        albumCreatedToast: "\u090f\u0932\u094d\u092c\u092e \u092c\u0928 \u0917\u092f\u093e",
        albumDeletedToast: "\u090f\u0932\u094d\u092c\u092e \u0939\u091f\u093e \u0926\u093f\u092f\u093e \u0917\u092f\u093e",
        trackAddedToast: "\u0917\u093e\u0928\u093e \u090f\u0932\u094d\u092c\u092e \u092e\u0947\u0902 \u091c\u094b\u0921\u093c\u093e \u0917\u092f\u093e",
        trackRemovedToast: "\u0917\u093e\u0928\u093e \u0939\u091f\u093e\u092f\u093e \u0917\u092f\u093e",
        noAlbumsYet: "\u0905\u092d\u0940 \u0915\u094b\u0908 \u090f\u0932\u094d\u092c\u092e \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
        noAlbumsHint: "\u0905\u092a\u0928\u093e \u0938\u0902\u0917\u0940\u0924 \u0935\u094d\u092f\u0935\u0938\u094d\u0925\u093f\u0924 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u090f\u0932\u094d\u092c\u092e \u092c\u0928\u093e\u090f\u0902\u0964",
        playAll: "\u0938\u092d\u0940 \u091a\u0932\u093e\u090f\u0902",
        deleteAlbum: "\u090f\u0932\u094d\u092c\u092e \u0939\u091f\u093e\u090f\u0902",
        deleteAlbumConfirm: "\u0915\u094d\u092f\u093e \u0906\u092a \u0907\u0938 \u090f\u0932\u094d\u092c\u092e \u0915\u094b \u0939\u091f\u093e\u0928\u093e \u091a\u093e\u0939\u0924\u0947 \u0939\u0948\u0902?",
        emptyAlbum: "\u092f\u0939 \u090f\u0932\u094d\u092c\u092e \u0916\u093e\u0932\u0940 \u0939\u0948\u0964",
        emptyAlbumHint: "\u0917\u093e\u0928\u0947 \u0916\u094b\u091c\u0947\u0902 \u0914\u0930 \u092f\u0939\u093e\u0902 \u091c\u094b\u0921\u093c\u0947\u0902\u0964",
        addToAlbum: "\u090f\u0932\u094d\u092c\u092e \u092e\u0947\u0902 \u0938\u0947\u0935 \u0915\u0930\u0947\u0902",
        selectAlbumOrCreate: "\u090f\u0915 \u090f\u0932\u094d\u092c\u092e \u091a\u0941\u0928\u0947\u0902 \u092f\u093e \u092c\u0928\u093e\u090f\u0902:",
        recentSearches: "\u0939\u093e\u0932\u093f\u092f\u093e \u0916\u094b\u091c",
        clearSearchHistory: "\u0907\u0924\u093f\u0939\u093e\u0938 \u092e\u093f\u091f\u093e\u090f\u0902",
        suggestedSearches: "\u0938\u0941\u091d\u093e\u0935",
        searchHint: "\u0915\u0932\u093e\u0915\u093e\u0930\u094b\u0902 \u092f\u093e \u0917\u093e\u0928\u094b\u0902 \u0915\u0940 \u0916\u094b\u091c \u0915\u0930\u0947\u0902...",
        noResults: "\u0915\u094b\u0908 \u092a\u0930\u093f\u0923\u093e\u092e \u0928\u0939\u0940\u0902 \u092e\u093f\u0932\u093e\u0964",
        downloadSong: "\u0917\u093e\u0928\u093e \u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0915\u0930\u0947\u0902",
        addToFavorites: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u092e\u0947\u0902 \u091c\u094b\u0921\u093c\u0947\u0902",
        removeFromFavorites: "\u092a\u0938\u0902\u0926\u0940\u0926\u093e \u0938\u0947 \u0939\u091f\u093e\u090f\u0902",
        copyLink: "\u0932\u093f\u0902\u0915 \u0915\u0949\u092a\u0940 \u0915\u0930\u0947\u0902",
        linkCopiedToast: "\u0932\u093f\u0902\u0915 \u0915\u0949\u092a\u0940 \u0939\u094b \u0917\u092f\u093e!",
        cancel: "\u0930\u0926\u094d\u0926 \u0915\u0930\u0947\u0902",
        searchTabSongs: "\u0917\u093e\u0928\u0947",
        searchTabAlbums: "\u090f\u0932\u094d\u092c\u092e",
        searchTabArtists: "\u0915\u0932\u093e\u0915\u093e\u0930",
        moodCurated: "\u091a\u0941\u0928\u093f\u0902\u0926\u093e \u0938\u0902\u0917\u0940\u0924",
        backToHome: "\u0939\u094b\u092e",
        artistTracksCount: "\u0917\u093e\u0928\u0947",
        getAppNav: "\u0910\u092a \u092a\u093e\u090f\u0902",
        getAppSub: "Aurora Music \u0915\u094b Android \u092a\u0930 \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0930\u0947\u0902 \u2014 \u0938\u0940\u0927\u0947 \u0914\u0930 \u0938\u0941\u0930\u0915\u094d\u0937\u093f\u0924",
        getAppSettingsBtn: "\u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0930\u0947\u0902",
        appPageTitle: "Android \u0915\u0947 \u0932\u093f\u090f Aurora Music",
        appPageSub: "\u0906\u092a\u0915\u0940 \u0938\u093e\u0930\u0940 \u092e\u094d\u092f\u0942\u091c\u093c\u093f\u0915 \u090f\u0915 \u0928\u0947\u091f\u093f\u0935 \u0910\u092a \u092e\u0947\u0902: \u0928\u094b\u091f\u093f\u092b\u093c\u093f\u0915\u0947\u0936\u0928 \u0938\u0947 \u0915\u0902\u091f\u094d\u0930\u094b\u0932, \u092c\u0948\u0915\u0917\u094d\u0930\u093e\u0909\u0902\u0921 \u092a\u094d\u0932\u0947\u092c\u0948\u0915 \u0914\u0930 \u0935\u0947\u092c \u091c\u0948\u0938\u093e \u0939\u0940 \u0905\u0928\u0941\u092d\u0935\u0964",
        appDownloadBtn: "APK \u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0915\u0930\u0947\u0902",
        appDownloadMeta: "\u0935\u0930\u094d\u0936\u0928 1.0.0 \u00b7 ~102 MB \u00b7 Android 7.0+",
        appStepsTitle: "\u0915\u0948\u0938\u0947 \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0930\u0947\u0902",
        appStep1Title: "APK \u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0915\u0930\u0947\u0902",
        appStep1Desc: "\u092c\u091f\u0928 \u0926\u092c\u093e\u0907\u090f \u2014 \u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0924\u0941\u0930\u0902\u0924 \u0936\u0941\u0930\u0942 \u0939\u094b \u091c\u093e\u090f\u0917\u093e, \u0915\u094b\u0908 \u092c\u093e\u0939\u0930\u0940 \u092a\u0947\u091c \u0928\u0939\u0940\u0902\u0964",
        appStep2Title: "\u092b\u093c\u093e\u0907\u0932 \u0916\u094b\u0932\u0947\u0902",
        appStep2Desc: "\u0928\u094b\u091f\u093f\u092b\u093c\u093f\u0915\u0947\u0936\u0928 \u092f\u093e \u092b\u093c\u093e\u0907\u0932 \u0910\u092a \u0938\u0947 \u0916\u094b\u0932\u0947\u0902\u0964",
        appStep3Title: "\u0905\u0928\u0941\u092e\u0924\u093f \u0926\u0947\u0902 \u0914\u0930 \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0930\u0947\u0902",
        appStep3Desc: "Android \u0907\u0938 \u0938\u094d\u0930\u094b\u0924 \u0938\u0947 \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0940 \u0905\u0928\u0941\u092e\u0924\u093f \u092e\u093e\u0902\u0917\u0947\u0917\u093e\u0964 \u0938\u094d\u0935\u0940\u0915\u093e\u0930 \u0915\u0930\u0947\u0902 \u0914\u0930 \u092c\u0938 \u0939\u094b \u0917\u092f\u093e\u0964",
        appSecurityNote: "\u0906\u0927\u093f\u0915\u093e\u0930\u093f\u0915 \u0930\u0942\u092a \u0938\u0947 \u0938\u093e\u0907\u0928 \u0915\u093f\u092f\u093e \u0917\u092f\u093e APK \u2014 GitHub \u0938\u0947 \u0938\u0940\u0927\u093e \u0907\u0902\u0938\u094d\u091f\u0949\u0932, \u0915\u094b\u0908 \u092c\u093e\u0939\u0930\u0940 \u0938\u094d\u091f\u094b\u0930 \u0928\u0939\u0940\u0902\u0964",
        appOtherPlatformNote: "Aurora Music \u0910\u092a \u0915\u0947\u0935\u0932 Android \u0915\u0947 \u0932\u093f\u090f \u0909\u092a\u0932\u092c\u094d\u0927 \u0939\u0948\u0964 iPhone, iPad \u092f\u093e \u0915\u0902\u092a\u094d\u092f\u0942\u091f\u0930 \u092a\u0930 \u0935\u0947\u092c \u092a\u0930 \u0935\u0939\u0940 \u0905\u0928\u0941\u092d\u0935 \u0932\u0947\u0924\u0947 \u0930\u0939\u0947\u0902\u0964",
        appInstalledNote: "Aurora Music \u092a\u0939\u0932\u0947 \u0938\u0947 \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0939\u0948 \u2014 \u0906\u092a \u0905\u092d\u0940 \u0907\u0938\u0940 \u0915\u093e \u0909\u092a\u092f\u094b\u0917 \u0915\u0930 \u0930\u0939\u0947 \u0939\u0948\u0902\u0964",
        appGithubBtn: "GitHub \u092a\u0930 \u0926\u0947\u0916\u0947\u0902",
      }
    };

    let currentLang = localStorage.getItem('aurora_lang') || 'en';
    if (!I18N[currentLang]) currentLang = 'en';

    function t(key) {
      if (I18N[currentLang] && I18N[currentLang][key]) {
        return I18N[currentLang][key];
      }
      if (I18N['en'] && I18N['en'][key]) {
        return I18N['en'][key];
      }
      if (I18N['es'] && I18N['es'][key]) {
        return I18N['es'][key];
      }
      return null;
    }

    // Dynamic real-time language application (no reload required!)
    function applyLanguage(lang) {
      if (I18N[lang]) {
        currentLang = lang;
        localStorage.setItem('aurora_lang', lang);
      }
      document.documentElement.lang = currentLang;

      // Update text in elements with data-i18n
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const k = el.getAttribute('data-i18n');
        if (k) {
          const trans = t(k);
          if (trans) el.textContent = trans;
        }
      });

      // Update placeholders
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const k = el.getAttribute('data-i18n-placeholder');
        if (k) {
          const trans = t(k);
          if (trans) el.setAttribute('placeholder', trans);
        }
      });

      // Update titles / tooltips
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const k = el.getAttribute('data-i18n-title');
        if (k) {
          const trans = t(k);
          if (trans) el.setAttribute('title', trans);
        }
      });

      // Update dynamic UI grids
      renderLanguageGrid();
      renderChips();
      if (window._homeData) {
        renderQuickPicks();
        renderRecommendedMix();
        renderHomeTrending();
        renderExploreView();
      }
      loadLikesSet();
      renderRecentSearches();
      renderSearchSuggestions();
      updateRepeatUI();
      updatePlayIcons(isPlaying);
      updateDropdownTriggerLabels();
      renderAllLegalViews();
    }

    function setLanguage(lang) {
      applyLanguage(lang);
      showToast(t('settings') + ': ' + (I18N[lang]?.langName || lang));
    }

    function renderLanguageGrid() {
      populateLanguageDropdown();
      populateQualityDropdown();
      updateDropdownTriggerLabels();
    }

    function populateLanguageDropdown() {
      const menu = $('langDropdownMenu');
      if (!menu) return;
      menu.innerHTML = '';
      Object.keys(I18N).forEach(code => {
        const item = I18N[code];
        const isActive = currentLang === code;
        const div = document.createElement('div');
        div.className = 'ytm-dropdown-item' + (isActive ? ' active' : '');
        div.innerHTML = \`
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="ytm-dropdown-pill-code">\${code.toUpperCase()}</span>
            <span class="ytm-dropdown-item-title">\${item.langName}</span>
          </div>
          <span class="ytm-dropdown-check">&#10003;</span>
        \`;
        div.onclick = (e) => {
          e.stopPropagation();
          selectLanguageOption(code);
        };
        menu.appendChild(div);
      });
    }

    function toggleLangDropdown(e) {
      if (e) e.stopPropagation();
      const wrap = $('langDropdownWrap');
      if (!wrap) return;
      const isOpen = wrap.classList.contains('open');
      const qWrap = $('qualityDropdownWrap');
      if (qWrap) qWrap.classList.remove('open');
      if (!isOpen) {
        populateLanguageDropdown();
        wrap.classList.add('open');
      } else {
        wrap.classList.remove('open');
      }
    }

    function selectLanguageOption(code) {
      const wrap = $('langDropdownWrap');
      if (wrap) wrap.classList.remove('open');
      setLanguage(code);
      populateLanguageDropdown();
      updateDropdownTriggerLabels();
      renderAllLegalViews();
    }

    const QUALITY_OPTIONS = [
      { key: 'ultra', badge: 'ULTRA HQ', label: 'Lossless FLAC (R2)' },
      { key: 'high', badge: 'HIGH', label: '320 kbps AAC' },
      { key: 'normal', badge: 'NORMAL', label: '160 kbps' },
      { key: 'data', badge: 'SAVER', label: '96 kbps' }
    ];

    function populateQualityDropdown() {
      const menu = $('qualityDropdownMenu');
      if (!menu) return;
      const curQ = localStorage.getItem('aurora_quality') || 'ultra';
      menu.innerHTML = '';
      QUALITY_OPTIONS.forEach(opt => {
        const isActive = curQ === opt.key;
        const div = document.createElement('div');
        div.className = 'ytm-dropdown-item' + (isActive ? ' active' : '');
        const localizedTitle = opt.key === 'high' ? (t('qualityHigh') || 'High') :
                               opt.key === 'normal' ? (t('qualityNormal') || 'Normal') :
                               opt.key === 'data' ? (t('qualityData') || 'Saver') : opt.badge;
        div.innerHTML = \`
          <div>
            <div class="ytm-dropdown-item-title">\${localizedTitle}</div>
            <div class="ytm-dropdown-item-desc">\${opt.label}</div>
          </div>
          <span class="ytm-dropdown-check">&#10003;</span>
        \`;
        div.onclick = (e) => {
          e.stopPropagation();
          selectAudioQualityOption(opt.key);
        };
        menu.appendChild(div);
      });
    }

    function toggleQualityDropdown(e) {
      if (e) e.stopPropagation();
      const wrap = $('qualityDropdownWrap');
      if (!wrap) return;
      const isOpen = wrap.classList.contains('open');
      const lWrap = $('langDropdownWrap');
      if (lWrap) lWrap.classList.remove('open');
      if (!isOpen) {
        populateQualityDropdown();
        wrap.classList.add('open');
      } else {
        wrap.classList.remove('open');
      }
    }

    function selectAudioQualityOption(q) {
      const wrap = $('qualityDropdownWrap');
      if (wrap) wrap.classList.remove('open');
      setAudioQuality(q);
      populateQualityDropdown();
      updateDropdownTriggerLabels();
    }

    function updateDropdownTriggerLabels() {
      const lCode = $('langSelectedCode');
      const lName = $('langSelectedName');
      if (lCode) lCode.textContent = currentLang.toUpperCase();
      if (lName) lName.textContent = I18N[currentLang]?.langName || currentLang;

      const curQ = localStorage.getItem('aurora_quality') || 'ultra';
      const qBadge = $('qualitySelectedBadge');
      const qLabel = $('qualitySelectedLabel');
      const matched = QUALITY_OPTIONS.find(o => o.key === curQ) || QUALITY_OPTIONS[0];
      if (qBadge) qBadge.textContent = matched.badge;
      if (qLabel) qLabel.textContent = matched.label;
    }

    function getLegalArticlesHtml(lang) {
      const isEs = (lang === 'es');
      if (isEs) {
        return \`
          <div class="legal-article">
            <h3>1. Naturaleza Jur&iacute;dica del Servicio e Intermediaci&oacute;n T&eacute;cnica</h3>
            <p><b>Aurora Music</b> (en adelante, "la Plataforma") opera como un motor de b&uacute;squeda indexador algor&iacute;tmico, interfaz de agregaci&oacute;n y herramienta de localizaci&oacute;n de metadatos de contenidos multimedia p&uacute;blicos disponibles en la red Internet. La Plataforma funciona conforme al principio de <i>mero conducto</i> y proveedor de herramientas de localizaci&oacute;n de la informaci&oacute;n. Aurora Music no opera como sello fonogr&aacute;fico ni casa editorial, no comercializa grabaciones sonoras protegidas ni almacena de forma permanente en sus servidores copias maestras no autorizadas de obras musicales sujetas a derechos de autor.</p>
          </div>
          <div class="legal-article">
            <h3>2. Exenci&oacute;n de Responsabilidad y Safe Harbor DMCA (17 U.S.C. &sect; 512)</h3>
            <p>De conformidad con el T&iacute;tulo II de la <i>Digital Millennium Copyright Act</i> de los Estados Unidos (DMCA / 17 U.S.C. &sect; 512), y en particular con las secciones <b>512(c)</b> (almacenamiento temporal a instancia de usuarios) y <b>512(d)</b> (herramientas de localizaci&oacute;n de informaci&oacute;n, hiperenlaces y motores de indexaci&oacute;n), Aurora Music se acoge formalmente al r&eacute;gimen de <b>Safe Harbor</b> (puerto seguro). La Plataforma carece de conocimiento efectivo (<i>actual knowledge</i>) de infracciones y de conocimiento evidente (<i>red flag knowledge</i>). Al recibir notificaci&oacute;n fehaciente, Aurora Music act&uacute;a con la m&aacute;xima diligencia para inhabilitar el acceso o retirar expeditamente el identificador indexado.</p>
          </div>
          <div class="legal-article">
            <h3>3. Directiva (UE) 2019/790 y Tratados Internacionales</h3>
            <p>Para usuarios y titulares sujetos a la jurisdicci&oacute;n de la Uni&oacute;n Europea y convenios internacionales (Convenio de Berna y Tratado OMPI), el servicio opera en estricto cumplimiento del marco legal aplicable a prestadores de servicios de la sociedad de la informaci&oacute;n, aplicando medidas t&eacute;cnicas proporcionadas de filtrado y exclusi&oacute;n previa notificaci&oacute;n motivada.</p>
          </div>
          <div class="legal-article">
            <h3>4. Procedimiento Formal de Notificaci&oacute;n y Retirada ("Notice and Takedown")</h3>
            <p>Cualquier titular leg&iacute;timo de derechos de propiedad intelectual, artista, sello fonogr&aacute;fico o representante legal acreditado que considere que un enlace o resultado indexado lesiona sus derechos exclusivos, puede remitir una notificaci&oacute;n formal con los siguientes requisitos obligatorios:</p>
            <ul style="padding-left:22px;margin:8px 0 12px 0;color:#ccc;font-size:13px;line-height:1.65;">
              <li><b>Identificaci&oacute;n de la obra protegida:</b> T&iacute;tulo, artista, &aacute;lbum o fonograma presuntamente infringido.</li>
              <li><b>Localizaci&oacute;n exacta:</b> El identificador espec&iacute;fico (ID o URL) que figura indexado en la Plataforma.</li>
              <li><b>Datos de contacto verificables:</b> Nombre completo, persona jur&iacute;dica (si procede), direcci&oacute;n f&iacute;sica, tel&eacute;fono y correo electr&oacute;nico.</li>
              <li><b>Declaraci&oacute;n de buena fe:</b> Manifestaci&oacute;n expresa de que el reclamante considera de buena fe que el uso del material no est&aacute; autorizado por el titular, su representante o la legislaci&oacute;n.</li>
              <li><b>Declaraci&oacute;n bajo pena de perjurio:</b> Declaraci&oacute;n bajo pena de perjurio de que la informaci&oacute;n remitida es exacta y que el firmante est&aacute; facultado para actuar en nombre del titular leg&iacute;timo.</li>
              <li><b>Firma v&aacute;lida:</b> Firma manuscrita o firma electr&oacute;nica reconocida.</li>
            </ul>
          </div>
          <div class="legal-article">
            <h3>5. Agente Designado y Canal Exclusivo de Atenci&oacute;n</h3>
            <p>A efectos de recibir notificaciones de infracci&oacute;n conforme a 17 U.S.C. &sect; 512(c)(2) y solicitudes de plataformas o sellos fonogr&aacute;ficos, el canal de comunicaci&oacute;n exclusivo y agente designado es:</p>
            <div class="settings-legal-contact-box" style="margin:14px 0;">
              <div style="display:flex;align-items:center;gap:12px;">
                <div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                  <svg width="24" height="24" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22 6c0-.55-.45-1-1-1h-2v5.5l3-2.25V6z"/>
                    <path fill="#34A853" d="M2 6v2.25l3 2.25V5H3c-.55 0-1 .45-1 1z"/>
                    <path fill="#EA4335" d="M19 5L12 10.5 5 5H2v13c0 .55.45 1 1 1h2V11l7 5.25L19 11v8h2c.55 0 1-.45 1-1V5h-3z"/>
                    <path fill="#FBBC04" d="M2 19h1a1 1 0 0 0 1-1V11l-2 1.5V19z"/>
                  </svg>
                </div>
                <div>
                  <div style="font-size:13px;font-weight:700;color:#fff;">Agente Designado para Retirada de Contenidos</div>
                  <div style="font-size:12.5px;color:#bbb;margin-top:2px;">Correo de contacto directo: <b style="color:#fff;">aliinasalzar@gmail.com</b></div>
                </div>
              </div>
              <a class="settings-legal-contact-btn" href="mailto:aliinasalzar@gmail.com?subject=Notificaci%C3%B3n%20Formal%20DMCA%20-%20Aurora%20Music" target="_blank" rel="noopener">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                Redactar Correo en Gmail
              </a>
            </div>
            <p style="font-size:12.5px;color:#10b981;margin-top:8px;"><b>Compromiso de retirada expedita:</b> Las notificaciones conformes recibidas a trav&eacute;s de este canal son tramitadas con la m&aacute;xima prioridad, garantiz&aacute;ndose la retirada o desindexaci&oacute;n del contenido en un plazo estricto no superior a 24 a 48 horas h&aacute;biles tras su recepci&oacute;n.</p>
          </div>
          <div class="legal-article">
            <h3>6. Propiedad Industrial y Marcas de Terceros</h3>
            <p>YouTube&trade;, YouTube Music&trade;, Google&trade; y cualesquiera otros signos distintivos, marcas registradas o logotipos mencionados en la aplicaci&oacute;n pertenecen en exclusiva a sus respectivos titulares. Su menci&oacute;n obedece a fines estrictamente referenciales, informativos y de identificaci&oacute;n de origen (<i>nominative fair use</i>), sin que de ello se desprenda relaci&oacute;n asociativa, patrocinio, afiliaci&oacute;n comercial ni aprobaci&oacute;n de Aurora Music por parte de dichos titulares.</p>
          </div>
          <div class="legal-article">
            <h3>7. Privacidad, Integridad y Almacenamiento Local Seguro</h3>
            <p>Aurora Music no recolecta, perfila ni comercializa informaci&oacute;n personal sensible de sus usuarios. Los datos de listas de reproducci&oacute;n, favoritos, configuraci&oacute;n de idioma y registro hist&oacute;rico de reproducciones y b&uacute;squedas se procesan y almacenan de forma estrictamente local en el dispositivo del usuario (IndexedDB y LocalStorage). Para salvaguardar la persistencia e integridad de la biblioteca musical del usuario, el historial no se somete a reseteos forzosos ni a divulgaci&oacute;n externa.</p>
          </div>
          <div class="legal-article">
            <h3>8. Exclusi&oacute;n de Garant&iacute;as y Limitaci&oacute;n de Responsabilidad</h3>
            <p>La Plataforma se suministra 'tal cual' y 'seg&uacute;n disponibilidad' (<i>as is</i> y <i>as available</i>), sin garant&iacute;as expresas ni impl&iacute;citas de disponibilidad ininterrumpida. En la m&aacute;xima medida permitida por el ordenamiento jur&iacute;dico, Aurora Music no asume responsabilidad por da&ntilde;os directos, indirectos, incidentales o consecuentes derivados del acceso o uso de contenidos enlazados de terceros.</p>
          </div>
        \`;
      }

      // Default English
      return \`
        <div class="legal-article">
          <h3>1. Legal Nature & Technical Intermediation</h3>
          <p><b>Aurora Music</b> (hereinafter, "the Platform") operates as an algorithmic search engine, indexing interface, and metadata location tool for publicly available multimedia streams on the Internet. The Platform functions strictly under the doctrine of <i>mere conduit</i> and information location provider. Aurora Music does not operate as a record label or publisher, does not sell copyrighted recordings, and does not permanently store unauthorized master copies on central servers.</p>
        </div>
        <div class="legal-article">
          <h3>2. Safe Harbor Limitation of Liability (17 U.S.C. &sect; 512)</h3>
          <p>Pursuant to Title II of the Digital Millennium Copyright Act (DMCA, 17 U.S.C. &sect; 512), specifically sections <b>512(c)</b> (limitation for storage at user direction) and <b>512(d)</b> (information location tools and search directories), Aurora Music operates under formal <b>Safe Harbor</b> immunity. The Platform lacks actual knowledge of infringement and red flag knowledge. Upon receipt of valid infringement notification, Aurora Music acts with maximum diligence to expeditiously disable access or de-index the identifier.</p>
        </div>
        <div class="legal-article">
          <h3>3. EU Directive 2019/790 & International Treaties</h3>
          <p>For users and rights holders under European Union jurisdiction and international conventions (Berne Convention, WIPO Copyright Treaty), the service operates in full compliance with the legal framework for information society service providers, enforcing proportionate technical filtering and de-indexing upon substantiated notice.</p>
        </div>
        <div class="legal-article">
          <h3>4. Formal Notice & Takedown Procedure</h3>
          <p>Any legitimate copyright owner, artist, record label, or authorized representative who believes an indexed link infringes exclusive rights may submit a formal notification with the following required criteria:</p>
          <ul style="padding-left:22px;margin:8px 0 12px 0;color:#ccc;font-size:13px;line-height:1.65;">
            <li><b>Clear identification of the protected work:</b> Title, artist, album, or sound recording subject to the claim.</li>
            <li><b>Exact location:</b> The specific identifier (track ID or URL) indexed on the Platform.</li>
            <li><b>Verifiable contact details:</b> Full name, legal entity, physical address, telephone number, and email.</li>
            <li><b>Good faith statement:</b> An explicit statement that the use is not authorized by the copyright owner, its agent, or the law.</li>
            <li><b>Statement under penalty of perjury:</b> A declaration under penalty of perjury of accuracy and authority to act on behalf of the owner.</li>
            <li><b>Valid signature:</b> A physical or recognized electronic signature.</li>
          </ul>
        </div>
        <div class="legal-article">
          <h3>5. Designated Agent & Exclusive Contact Channel</h3>
          <p>For formal DMCA notifications pursuant to 17 U.S.C. &sect; 512(c)(2) and platform or label inquiries, the designated agent and exclusive channel is:</p>
          <div class="settings-legal-contact-box" style="margin:14px 0;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22 6c0-.55-.45-1-1-1h-2v5.5l3-2.25V6z"/>
                  <path fill="#34A853" d="M2 6v2.25l3 2.25V5H3c-.55 0-1 .45-1 1z"/>
                  <path fill="#EA4335" d="M19 5L12 10.5 5 5H2v13c0 .55.45 1 1 1h2V11l7 5.25L19 11v8h2c.55 0 1-.45 1-1V5h-3z"/>
                  <path fill="#FBBC04" d="M2 19h1a1 1 0 0 0 1-1V11l-2 1.5V19z"/>
                </svg>
              </div>
              <div>
                <div style="font-size:13px;font-weight:700;color:#fff;">Designated Agent for Content Takedown</div>
                <div style="font-size:12.5px;color:#bbb;margin-top:2px;">Direct contact email: <b style="color:#fff;">aliinasalzar@gmail.com</b></div>
              </div>
            </div>
            <a class="settings-legal-contact-btn" href="mailto:aliinasalzar@gmail.com?subject=DMCA%20Formal%20Notification%20-%20Aurora%20Music" target="_blank" rel="noopener">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Compose Email in Gmail
            </a>
          </div>
          <p style="font-size:12.5px;color:#10b981;margin-top:8px;"><b>Expeditious takedown commitment:</b> Valid notices received through this channel are prioritized, ensuring removal or de-indexing within a strict 24 to 48 business hour window.</p>
        </div>
        <div class="legal-article">
          <h3>6. Third-Party Trademarks & Industrial Property</h3>
          <p>YouTube&trade;, YouTube Music&trade;, Google&trade;, and any other distinctive signs or trademarks mentioned in this application belong exclusively to their respective owners. Their mention serves strictly referential, informative, and nominative fair use purposes, without implying affiliation, endorsement, sponsorship, or approval by said trademark holders.</p>
        </div>
        <div class="legal-article">
          <h3>7. Privacy, Local Data Integrity & History Persistence</h3>
          <p>Aurora Music does not collect, profile, or monetize sensitive personal user data. Playlists, favorites, language preferences, and historical playback and search logs are stored strictly locally on the user's device (IndexedDB and LocalStorage). To preserve the integrity and stability of the user's music library, historical activity is not subject to forced automated clearing or external disclosure.</p>
        </div>
        <div class="legal-article">
          <h3>8. Disclaimer of Warranties & Limitation of Liability</h3>
          <p>The Platform is provided on an 'as is' and 'as available' basis, without express or implied warranties of uninterrupted uptime. To the maximum extent permitted by law, Aurora Music disclaims liability for direct, indirect, incidental, or consequential damages resulting from access to or use of third-party linked content.</p>
        </div>
      \`;
    }
    function renderAllLegalViews() {
      const html = getLegalArticlesHtml(currentLang);
      const mCont = $('legalModalArticles');
      if (mCont) mCont.innerHTML = html;
      const tCont = $('termsPageContent');
      if (tCont) tCont.innerHTML = html;
    }

    // --------------------------------------------------------
    // IndexedDB Management (version 2 with user_albums)
    // --------------------------------------------------------
    const DB_NAME = 'aurora_music_db';
    const DB_VERSION = 2;
    let dbInstance = null;

    function openDatabase() {
      return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('likes')) {
            db.createObjectStore('likes', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('history')) {
            db.createObjectStore('history', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('recent_searches')) {
            db.createObjectStore('recent_searches', { keyPath: 'query' });
          }
          if (!db.objectStoreNames.contains('user_albums')) {
            db.createObjectStore('user_albums', { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => {
          dbInstance = e.target.result;
          resolve(dbInstance);
        };
        req.onerror = (e) => reject(e);
      });
    }

    async function dbGet(storeName, key) {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    async function dbGetAll(storeName) {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    async function dbPut(storeName, item) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(item);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }

    async function dbDelete(storeName, key) {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    }

    async function dbClear(storeName) {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    }

    // --------------------------------------------------------
    // Search Query History (Recent Searches)
    // --------------------------------------------------------
    async function saveRecentSearch(text) {
      const clean = (text || '').trim();
      if (!clean) return;
      try {
        await dbPut('recent_searches', { query: clean.toLowerCase(), text: clean, timestamp: Date.now() });
      } catch (_) {}
    }

    async function removeRecentSearch(queryKey) {
      try {
        await dbDelete('recent_searches', queryKey);
        renderRecentSearches();
      } catch (_) {}
    }

    async function clearAllRecentSearches() {
      console.log('Search history is permanently preserved.');
    }

    async function renderRecentSearches() {
      const listEl = $('searchRecentList');
      if (!listEl) return;
      try {
        const all = await dbGetAll('recent_searches');
        all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const items = all.slice(0, 10);
        listEl.innerHTML = '';

        if (!items.length) {
          listEl.innerHTML = \`<div style="padding:14px;color:var(--text-dim);font-size:13px;text-align:center;">\${t('searchHint')}</div>\`;
          return;
        }

        items.forEach(it => {
          const row = document.createElement('div');
          row.className = 'search-recent-item';
          row.innerHTML = \`
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span style="flex:1;">\${it.text}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          \`;
          row.onclick = () => {
            if (sInput) sInput.value = it.text;
            executeSearch(it.text);
          };





          listEl.appendChild(row);
        });
      } catch (_) {}
    }

    function renderSearchSuggestions() {
      const c = $('searchSuggestChips');
      if (!c) return;
      const suggestions = ['Bad Bunny', 'Taylor Swift', 'The Weeknd', 'Feid', 'Coldplay', 'Billie Eilish', 'Quevedo', 'Duki', 'Karol G'];
      c.innerHTML = '';
      suggestions.forEach(query => {
        const btn = document.createElement('button');
        btn.className = 'search-suggest-chip';
        btn.textContent = query;
        btn.onclick = () => {
          if (sInput) sInput.value = query;
          executeSearch(query);
        };
        c.appendChild(btn);
      });
    }

    // --------------------------------------------------------
    // Search Tabs (Canciones, Álbumes, Artistas)
    // --------------------------------------------------------
    let currentSearchTab = 'songs';
    window._lastSearchResults = { songs: [], albums: [], artists: [] };

    function switchSearchTab(tabName) {
      currentSearchTab = tabName;
      ['Songs', 'Albums', 'Artists'].forEach(name => {
        const btn = $('searchTabBtn' + name);
        const sec = $('searchSection' + name);
        const isActive = name.toLowerCase() === tabName;
        if (btn) btn.classList.toggle('active', isActive);
        if (sec) sec.style.display = isActive ? 'block' : 'none';
      });

      if (tabName === 'albums') {
        renderSearchAlbumsGrid(window._lastSearchResults.albums);
      } else if (tabName === 'artists') {
        renderSearchArtistsList(window._lastSearchResults.artists);
      }
    }

    function renderSearchAlbumsGrid(albums) {
      const grid = $('searchAlbumsGrid');
      if (!grid) return;
      grid.innerHTML = '';
      if (!albums || !albums.length) {
        grid.innerHTML = \`<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-dim);font-size:13.5px;">\${t('noResults')}</div>\`;
        return;
      }
      albums.forEach(alb => {
        const card = document.createElement('div');
        card.className = 'ytm-search-album-card';
        card.innerHTML = \`
          <img class="ytm-search-album-thumb" src="\${alb.thumb}" loading="lazy" alt="Cover" onerror="this.src='/icon.svg'">
          <div class="ytm-search-album-title">\${alb.title}</div>
          <div class="ytm-search-album-artist">\${alb.subtitle || t('albums')}</div>
        \`;
        card.onclick = () => {
          if (sInput) sInput.value = alb.title;
          executeSearch(alb.title);
        };
        grid.appendChild(card);
      });
    }

    function renderSearchArtistsList(artists) {
      const list = $('searchArtistsList');
      if (!list) return;
      list.innerHTML = '';
      if (!artists || !artists.length) {
        list.innerHTML = \`<div style="padding:24px;text-align:center;color:var(--text-dim);font-size:13.5px;">\${t('noResults')}</div>\`;
        return;
      }
      artists.forEach(art => {
        const card = document.createElement('div');
        card.className = 'ytm-artist-card';
        card.innerHTML = \`
          <img class="ytm-artist-avatar" src="\${art.thumb}" loading="lazy" alt="Artist" onerror="this.src='/icon.svg'">
          <div class="ytm-artist-info">
            <div class="ytm-artist-name">\${art.name}</div>
            <div class="ytm-artist-sub">\${art.subtitle || t('searchTabArtists')}</div>
          </div>
          <div class="ytm-artist-play-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        \`;
        card.onclick = () => {
          if (sInput) sInput.value = art.name;
          executeSearch(art.name);
        };
        list.appendChild(card);
      });
    }

    // --------------------------------------------------------
    // Search Execution
    // --------------------------------------------------------
    async function executeSearch(query) {
      const clean = (query || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;

      saveRecentSearch(clean);
      switchView('search');

      const recentBox = $('searchRecentContainer');
      const resultsBox = $('searchResultsContainer');
      const list = $('searchResultsList');

      if (recentBox) recentBox.style.display = 'none';
      if (resultsBox) resultsBox.style.display = 'block';

      if (list) {
        list.innerHTML = \`
          <div style="padding:40px;text-align:center;color:var(--text-dim);">
            <div class="spinner" style="width:32px;height:32px;margin:0 auto 12px auto;border-width:3px;"></div>
            <div style="font-size:14px;">\${t('searchPlaceholder')}</div>
          </div>
        \`;
      }

      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(clean));
        if (!res.ok) throw new Error('Search failed: ' + res.status);
        const data = await res.json();

        const songs = data.results || [];
        const albums = data.albums || [];
        const artists = data.artists || [];

        window._lastSearchResults = { songs, albums, artists };

        // Default to songs tab
        switchSearchTab('songs');

        if (!songs.length && !albums.length && !artists.length) {
          if (list) {
            list.innerHTML = \`<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:14px;">\${t('noResults')}</div>\`;
          }
          return;
        }

        renderTrackRows(songs, list);
        renderSearchAlbumsGrid(albums);
        renderSearchArtistsList(artists);
      } catch (err) {
        if (list) {
          list.innerHTML = \`<div style="padding:40px;text-align:center;color:var(--danger);font-size:14px;">Error: \${err.message}</div>\`;
        }
      }
    }

    // --------------------------------------------------------
    // Home Mood Chips & Feed (In-place on Home, no search bar contamination)
    // --------------------------------------------------------
    window._moodCache = {};
    let activeMoodId = 'all';

    function resetMoodChips() {
      activeMoodId = 'all';
      document.querySelectorAll('.ytm-chip').forEach(b => b.classList.remove('active'));
      const firstChip = document.querySelector('.ytm-chip');
      if (firstChip) firstChip.classList.add('active');

      const feed = $('homeMoodFeed');
      const def = $('homeDefaultSections');
      if (feed) feed.style.display = 'none';
      if (def) def.style.display = 'block';
    }

    async function selectMoodChip(cat) {
      if (!cat || !cat.id || cat.id === 'all' || !cat.query) {
        resetMoodChips();
        return;
      }

      activeMoodId = cat.id;
      const feed = $('homeMoodFeed');
      const def = $('homeDefaultSections');
      const list = $('homeMoodList');
      const title = $('homeMoodTitle');
      const sub = $('homeMoodSub');

      if (def) def.style.display = 'none';
      if (feed) feed.style.display = 'block';

      if (title) title.textContent = t('cat_' + cat.id) || cat.name;
      if (sub) sub.textContent = t('moodCurated');

      // Check cache first
      if (window._moodCache[cat.id] && window._moodCache[cat.id].length) {
        renderTrackRows(window._moodCache[cat.id], list);
        return;
      }

      if (list) {
        list.innerHTML = \`
          <div style="padding:40px;text-align:center;color:var(--text-dim);">
            <div class="spinner" style="width:28px;height:28px;margin:0 auto 10px auto;border-width:3px;"></div>
            <div style="font-size:13.5px;">Cargando...</div>
          </div>
        \`;
      }

      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(cat.query));
        if (!res.ok) throw new Error('Failed to load mood: ' + res.status);
        const data = await res.json();
        const tracks = data.results || [];
        window._moodCache[cat.id] = tracks;
        renderTrackRows(tracks, list);
      } catch (err) {
        if (list) {
          list.innerHTML = \`<div style="padding:30px;text-align:center;color:var(--text-dim);font-size:13.5px;">\${t('noResults')}</div>\`;
        }
      }
    }

    function renderChips() {
      const chipsContainer = $('homeChips');
      if (!chipsContainer || !window._homeData || !window._homeData.categories) return;

      chipsContainer.innerHTML = '';
      window._homeData.categories.forEach((cat, idx) => {
        const btn = document.createElement('button');
        const isActive = (cat.id === activeMoodId) || (activeMoodId === 'all' && idx === 0);
        btn.className = 'ytm-chip' + (isActive ? ' active' : '');
        btn.textContent = t('cat_' + cat.id) || cat.name;

        btn.onclick = () => {
          document.querySelectorAll('.ytm-chip').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectMoodChip(cat);
        };
        chipsContainer.appendChild(btn);
      });
    }

    // --------------------------------------------------------
    // User Custom Albums (IndexedDB version 2)
    // --------------------------------------------------------
    let currentViewingAlbum = null;
    let pendingAddToAlbum = false;

    function openCreateAlbumModal(addToCurrentPending = false) {
      pendingAddToAlbum = !!addToCurrentPending;
      const modal = $('createAlbumModal');
      const input = $('createAlbumInput');
      if (modal) {
        modal.classList.add('open', 'active');
        document.body.classList.add('modal-open');
        if (input) {
          input.value = '';
          setTimeout(() => input.focus(), 120);
        }
      }
    }

    function closeCreateAlbumModal(e) {
      if (e && e.target && e.target.id !== 'createAlbumModal') return;
      const modal = $('createAlbumModal');
      if (modal) {
        modal.classList.remove('open', 'active');
        document.body.classList.remove('modal-open');
      }
    }

    async function submitCreateAlbum() {
      const input = $('createAlbumInput');
      const name = input ? input.value.trim() : '';
      if (!name) {
        showToast(t('albumNamePrompt') || 'Introduce un nombre válido');
        return;
      }
      closeCreateAlbumModal();

      const albumId = 'alb_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const newAlbum = {
        id: albumId,
        name: name,
        createdAt: Date.now(),
        tracks: []
      };
      try {
        await dbPut('user_albums', newAlbum);
        showToast(t('albumCreatedToast'));
      } catch (dbErr) {
        console.warn('album save error:', dbErr);
        showToast(t('albumNamePrompt') ? 'No se pudo guardar el álbum (almacenamiento no disponible)' : 'No se pudo guardar el álbum (almacenamiento no disponible)');
        openCreateAlbumModal(pendingAddToAlbum);
        return;
      }

      if (pendingAddToAlbum && activeMenuTrack) {
        await addTrackToAlbum(albumId, activeMenuTrack);
        closeAddToAlbumModal();
      }

      loadUserAlbums();
    }

    function promptCreateAlbum(addToCurrentPending = false) {
      openCreateAlbumModal(addToCurrentPending);
    }

    async function loadUserAlbums() {
      const grid = $('libAlbumsGrid');
      if (!grid) return;
      try {
        const albums = await dbGetAll('user_albums');
        albums.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        grid.innerHTML = '';

        if (!albums.length) {
          grid.innerHTML = \`
            <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-dim);">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.5;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
              <div style="font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 4px;">\${t('noAlbumsYet')}</div>
              <div style="font-size: 13px;">\${t('noAlbumsHint')}</div>
            </div>
          \`;
          return;
        }

        albums.forEach(alb => {
          const card = document.createElement('div');
          card.className = 'ytm-user-album-card';
          const firstThumb = alb.tracks && alb.tracks.length ? alb.tracks[0].thumb : '';
          card.innerHTML = \`
            <div class="ytm-user-album-cover">
              \${firstThumb ? \`<img src="\${firstThumb}" alt="Cover" style="width:100%;height:100%;object-fit:cover;">\` : \`<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>\`}
            </div>
            <div class="ytm-user-album-name">\${alb.name}</div>
            <div class="ytm-user-album-count">\${alb.tracks ? alb.tracks.length : 0} \${t('artistTracksCount')}</div>
          \`;
          card.onclick = () => openUserAlbum(alb.id);
          grid.appendChild(card);
        });
      } catch (_) {}
    }

    async function openUserAlbum(albumId) {
      const alb = await dbGet('user_albums', albumId);
      if (!alb) return;
      currentViewingAlbum = alb;

      const mainList = $('libAlbumsMain');
      const detailView = $('userAlbumDetail');
      if (mainList) mainList.style.display = 'none';
      if (detailView) detailView.style.display = 'block';

      $('albumDetailTitle').textContent = alb.name;
      $('albumDetailMeta').textContent = \`\${alb.tracks ? alb.tracks.length : 0} \${t('artistTracksCount')}\`;

      const coverEl = $('albumDetailCover');
      if (coverEl) {
        const thumb = alb.tracks && alb.tracks.length ? alb.tracks[0].thumb : '';
        coverEl.innerHTML = thumb
          ? \`<img src="\${thumb}" alt="Cover" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">\`
          : \`<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>\`;
      }

      const listEl = $('albumDetailTrackList');
      if (listEl) {
        listEl.innerHTML = '';
        if (!alb.tracks || !alb.tracks.length) {
          listEl.innerHTML = \`
            <div style="padding:40px 20px;text-align:center;color:var(--text-dim);">
              <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;">\${t('emptyAlbum')}</div>
              <div style="font-size:13px;">\${t('emptyAlbumHint')}</div>
            </div>
          \`;
          return;
        }
        renderTrackRows(alb.tracks, listEl, true, albumId);
      }
    }

    function closeUserAlbumDetail() {
      currentViewingAlbum = null;
      const mainList = $('libAlbumsMain');
      const detailView = $('userAlbumDetail');
      if (detailView) detailView.style.display = 'none';
      if (mainList) mainList.style.display = 'block';
      loadUserAlbums();
    }

    async function deleteCurrentAlbum() {
      if (!currentViewingAlbum) return;
      if (!confirm(t('deleteAlbumConfirm'))) return;
      await dbDelete('user_albums', currentViewingAlbum.id);
      showToast(t('albumDeletedToast'));
      closeUserAlbumDetail();
    }

    function playCurrentAlbum() {
      if (!currentViewingAlbum || !currentViewingAlbum.tracks || !currentViewingAlbum.tracks.length) return;
      playTrack(currentViewingAlbum.tracks[0], currentViewingAlbum.tracks, true, false);
    }

    function promptAddTracksToAlbum() {
      switchView('search');
      showToast(t('emptyAlbumHint'));
    }

    async function openAddToAlbumModal() {
      closeTrackMenu();
      if (!activeMenuTrack) return;
      const modal = $('addToAlbumModal');
      const listEl = $('addToAlbumList');
      if (!modal || !listEl) return;

      const albums = await dbGetAll('user_albums');
      listEl.innerHTML = '';

      if (!albums.length) {
        listEl.innerHTML = \`<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px;">\${t('noAlbumsYet')}</div>\`;
      } else {
        albums.forEach(alb => {
          const item = document.createElement('div');
          item.className = 'ytm-artist-card';
          item.style.padding = '8px 12px';
          const count = alb.tracks ? alb.tracks.length : 0;
          item.innerHTML = \`
            <div style="width:36px;height:36px;background:rgba(255,255,255,0.06);border-radius:6px;display:flex;align-items:center;justify-content:center;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
            </div>
            <div style="flex:1;">
              <div style="font-size:13.5px;font-weight:600;color:#fff;">\${alb.name}</div>
              <div style="font-size:11.5px;color:var(--text-dim);">\${count} \${t('artistTracksCount')}</div>
            </div>
          \`;
          item.onclick = async () => {
            await addTrackToAlbum(alb.id, activeMenuTrack);
            closeAddToAlbumModal();
          };
          listEl.appendChild(item);
        });
      }

      modal.classList.add('open');
    }

    function closeAddToAlbumModal(e) {
      if (e && e.target && e.target.id !== 'addToAlbumModal') return;
      const modal = $('addToAlbumModal');
      if (modal) modal.classList.remove('open');
    }

    async function addTrackToAlbum(albumId, track) {
      const alb = await dbGet('user_albums', albumId);
      if (!alb) return;
      if (!alb.tracks) alb.tracks = [];
      if (!alb.tracks.some(t => t.id === track.id)) {
        alb.tracks.push(track);
        await dbPut('user_albums', alb);
        showToast(t('trackAddedToast'));
      }
    }

    async function removeTrackFromAlbum(albumId, trackId) {
      const alb = await dbGet('user_albums', albumId);
      if (!alb || !alb.tracks) return;
      alb.tracks = alb.tracks.filter(t => t.id !== trackId);
      await dbPut('user_albums', alb);
      showToast(t('trackRemovedToast'));
      openUserAlbum(albumId);
    }

    // --------------------------------------------------------
    // View Switcher (Clean Encapsulation)
    // --------------------------------------------------------
    function switchView(viewName) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const target = $('view-' + viewName);
      if (target) target.classList.add('active');

      document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
      const sideBtn = $('side-' + viewName);
      if (sideBtn) sideBtn.classList.add('active');

      document.querySelectorAll('.ytm-nav-item').forEach(b => b.classList.remove('active'));
      const tabBtn = $('tab-' + viewName);
      if (tabBtn) tabBtn.classList.add('active');

      document.querySelectorAll('.ytm-mob-item').forEach(b => b.classList.remove('active'));
      const mobBtn = $('mob-' + viewName);
      if (mobBtn) mobBtn.classList.add('active');

      if (viewName === 'terms') {
        renderAllLegalViews();
      }

      // YouTube Music Sticky Chips: ONLY visible on Home!
      const chips = $('homeChips');
      if (chips) {
        chips.style.display = (viewName === 'home') ? 'flex' : 'none';
      }

      if (viewName === 'library') {
        const activeBtn = document.querySelector('.library-tab-btn.active');
        const tabKey = activeBtn ? activeBtn.id.replace('libTab', '').toLowerCase() : 'likes';
        switchLibraryTab(tabKey);
      } else if (viewName === 'explore') {
        renderExploreView();
      } else if (viewName === 'search') {
        const hasQuery = sInput && sInput.value.trim().length > 0;
        const recentBox = $('searchRecentContainer');
        const resultsBox = $('searchResultsContainer');
        if (!hasQuery) {
          if (recentBox) recentBox.style.display = 'block';
          if (resultsBox) resultsBox.style.display = 'none';
          renderRecentSearches();
          renderSearchSuggestions();
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function switchLibraryTab(tabName) {
      ['Likes', 'Albums', 'History'].forEach(name => {
        const btn = $('libTab' + name);
        const sec = $('libSection' + name);
        const isActive = name.toLowerCase() === tabName;
        if (btn) btn.classList.toggle('active', isActive);
        if (sec) sec.style.display = isActive ? 'block' : 'none';
      });

      if (tabName === 'likes') {
        loadLikesView();
      } else if (tabName === 'albums') {
        closeUserAlbumDetail();
      } else if (tabName === 'history') {
        loadHistoryView();
      }
    }
    const switchLibTab = switchLibraryTab; // Alias for backward compatibility

    // --------------------------------------------------------
    // Audio Player Engine (Zero-Latency, Real-Time Scrubbing, Full Controls)
    // --------------------------------------------------------
    let currentTrack = null;
    let playlist = [];
    let currentIndex = -1;
    let isPlaying = false;
    let isShuffle = false;
    let isScrubbing = false;
    let repeatMode = localStorage.getItem('aurora_repeat') || 'off'; // 'off', 'one', 'all'
    let ytPlayer = null;
    let isYtFallback = false;
    let nearEndPreloaded = false; // re-armar precarga del siguiente track (1 vez por cancion)
    let lastPosSyncMs = 0;        // throttle de syncMediaPositionState en timeupdate

    const audio = $('audioEngine');
    const pTitle = $('playerTitle');
    const pArtist = $('playerArtist');
    const pCover = $('playerCover');
    const pPlayBtn = $('playBtn') || $('btnPlay');
    const pScrubber = $('scrubber');
    const pProgressBar = $('progressBar');
    const pCurTime = $('currentTime') || $('curTime');
    const pDurTime = $('totalDuration') || $('durTime');
    const sInput = $('searchInput');

    function updateRepeatUI() {
      const btn = $('btnRepeat');
      const mBtn = $('modalBtnRepeat');
      let svg = '';
      let title = '';
      if (repeatMode === 'one') {
        svg = \`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="10" y="16" fill="var(--primary)" font-size="9" font-weight="bold">1</text></svg>\`;
        title = "Repetir una canci\u00f3n";
      } else if (repeatMode === 'all') {
        svg = \`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>\`;
        title = "Repetir lista completa";
      } else {
        svg = \`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>\`;
        title = "Bucle desactivado";
      }
      if (btn) { btn.innerHTML = svg; btn.title = title; }
      if (mBtn) { mBtn.innerHTML = svg; mBtn.title = title; }
    }

    function toggleRepeat() {
      if (repeatMode === 'off') repeatMode = 'all';
      else if (repeatMode === 'all') repeatMode = 'one';
      else repeatMode = 'off';
      localStorage.setItem('aurora_repeat', repeatMode);
      updateRepeatUI();
      showToast(repeatMode === 'one' ? 'Repitiendo esta canci\u00f3n' : (repeatMode === 'all' ? 'Repitiendo lista' : 'Bucle desactivado'));
    }

    function toggleShuffle() {
      isShuffle = !isShuffle;
      if (isShuffle && playlist.length > 1) {
        const cur = playlist[currentIndex] || currentTrack;
        const rest = playlist.filter(t => !cur || t.id !== cur.id);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        playlist = cur ? [cur, ...rest] : rest;
        currentIndex = 0;
        showToast('Modo aleatorio activado');
      } else {
        showToast('Modo aleatorio desactivado');
      }
      const b1 = $('btnShuffle');
      const b2 = $('modalBtnShuffle');
      [b1, b2].forEach(b => {
        if (b) {
          b.style.color = isShuffle ? 'var(--primary)' : 'inherit';
          b.classList.toggle('active', isShuffle);
        }
      });
    }

    function formatDuration(sec) {
      if (!sec || isNaN(sec) || sec < 0) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function syncMediaPositionState() {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
      try {
        const dur = (audio.duration && isFinite(audio.duration)) ? audio.duration : ((currentTrack && currentTrack.duration) || 0);
        if (dur > 0) {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(Math.max(0, audio.currentTime || 0), dur)
          });
        }
      } catch (_) {}
    }

    // Sync de POSICION hacia el puente nativo de la APK (AndroidBridge).
    // La notificacion nativa de la app se congela en el punto exacto al
    // pausar y continua desde ahi al reanudar. Protocolo en segundos:
    //   { position, duration, playing, rate }
    // Retrocompatible: si la APK no implementa onPositionChanged, no-op.
    let lastAndroidSyncMs = 0;
    function syncAndroidPositionState(playingOverride) {
      try {
        if (!(window.AndroidBridge && typeof window.AndroidBridge.onPositionChanged === 'function')) return;
        let pos = 0;
        let dur = 0;
        let rate = 1;
        if (isYtFallback && ytPlayer) {
          try { if (typeof ytPlayer.getCurrentTime === 'function') pos = ytPlayer.getCurrentTime() || 0; } catch (_) {}
          dur = getSafeTrackDuration() || 0;
        } else {
          pos = audio.currentTime || 0;
          dur = (audio.duration && isFinite(audio.duration)) ? audio.duration : ((currentTrack && currentTrack.duration) || 0);
          rate = audio.playbackRate || 1;
        }
        const playing = (typeof playingOverride === 'boolean') ? playingOverride : isPlaying;
        window.AndroidBridge.onPositionChanged(JSON.stringify({
          position: pos,
          duration: dur,
          playing: playing,
          rate: rate
        }));
        lastAndroidSyncMs = Date.now();
      } catch (_) {}
    }

    function updatePlayIcons(playing) {
      if (window.AndroidBridge && typeof window.AndroidBridge.onPlaybackState === 'function') {
        try { window.AndroidBridge.onPlaybackState(playing); } catch (_) {}
      }
      // Posicion exacta hacia la APK: la notificacion nativa congela/continua
      // la barra en el segundo correcto en vez de resetearla a 0:00.
      syncAndroidPositionState(playing);
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        } catch (_) {}
      }
      const pPlay = $('playIcon');
      const pPause = $('pauseIcon');
      if (pPlay) pPlay.style.display = playing ? 'none' : 'block';
      if (pPause) pPause.style.display = playing ? 'block' : 'none';

      const mPlay = $('modalPlayIcon');
      const mPause = $('modalPauseIcon');
      if (mPlay) mPlay.style.display = playing ? 'none' : 'block';
      if (mPause) mPause.style.display = playing ? 'block' : 'none';

      const pBtn = $('playBtn') || $('btnPlay');
      if (pBtn) {
        pBtn.setAttribute('title', playing ? (t('pause') || 'Pausar') : (t('play') || 'Reproducir'));
      }
    }

    function updateLikeButtonState(trackId) {
      const isLiked = likesSet.has(trackId);
      const btn = $('btnModalLike');
      if (btn) {
        btn.style.color = isLiked ? '#f43f5e' : 'inherit';
        const svg = btn.querySelector('svg');
        if (svg) {
          svg.setAttribute('fill', isLiked ? '#f43f5e' : 'none');
          svg.setAttribute('stroke', isLiked ? '#f43f5e' : 'currentColor');
        }
      }
    }

    function openExpandedPlayer() {
      if (!currentTrack) return;
      const modal = $('expandedModal');
      if (modal) {
        modal.classList.add('visible', 'active');
        const mCover = $('modalCover');
        const mTitle = $('modalTitle');
        const mArtist = $('modalArtist');
        if (mCover) mCover.src = currentTrack.thumb || \`https://i.ytimg.com/vi/\${currentTrack.id}/hqdefault.jpg\`;
        if (mTitle) mTitle.textContent = currentTrack.title;
        if (mArtist) mArtist.textContent = currentTrack.artist;
        updateLikeButtonState(currentTrack.id);
        updatePlayIcons(isPlaying);
        updateRepeatUI();
        const cur = audio ? audio.currentTime : 0;
        const dur = (audio && audio.duration) || currentTrack.duration || 1;
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        const mSlider = $('modalSlider');
        if (mSlider) mSlider.value = pct;
        const mCur = $('modalTimeElapsed');
        if (mCur) mCur.textContent = formatDuration(cur);
        const mDur = $('modalTimeTotal');
        if (mDur) mDur.textContent = formatDuration(dur);
      }
    }

    function closeExpandedPlayer() {
      const modal = $('expandedModal');
      if (modal) modal.classList.remove('visible', 'active');
    }

    function getSafeTrackDuration() {
      if (isYtFallback && ytPlayer && typeof ytPlayer.getDuration === 'function') {
        try {
          const d = ytPlayer.getDuration();
          if (d && !isNaN(d) && isFinite(d) && d > 0) return d;
        } catch (_) {}
      }
      if (audio && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration) && audio.duration > 0) {
        return audio.duration;
      }
      if (currentTrack && currentTrack.duration && !isNaN(currentTrack.duration) && isFinite(currentTrack.duration) && currentTrack.duration > 0) {
        return Number(currentTrack.duration);
      }
      return 0;
    }

    function onModalScrubInput(val) {
      isScrubbing = true;
      const dur = getSafeTrackDuration();
      const pct = Math.max(0, Math.min(100, parseFloat(val) || 0));
      const seekTime = (pct / 100) * dur;
      const mCur = $('modalTimeElapsed');
      if (mCur) mCur.textContent = formatDuration(seekTime);
      const pCur = $('currentTime') || $('curTime');
      if (pCur) pCur.textContent = formatDuration(seekTime);
      const pBar = $('progressBar');
      if (pBar) pBar.style.width = pct + '%';
    }

    function onModalScrubChange(val) {
      const dur = getSafeTrackDuration();
      const pct = Math.max(0, Math.min(100, parseFloat(val) || 0));
      if (dur > 0) {
        const seekTime = Math.min(dur - 0.5, Math.max(0, (pct / 100) * dur));
        if (isFinite(seekTime)) {
          if (isYtFallback && ytPlayer && typeof ytPlayer.seekTo === 'function') {
            try { ytPlayer.seekTo(seekTime, true); } catch (_) {}
          } else if (audio) {
            try { audio.currentTime = seekTime; } catch (_) {}
          }
        }
      }
      isScrubbing = false;
    }

    let isFetchingRadio = false;
    let currentRadioVid = null;
    let radioPromise = null;

    async function fetchRadioQueueForTrack(track) {
      if (!track || !track.id) return;
      if (isFetchingRadio && currentRadioVid === track.id) return radioPromise;
      currentRadioVid = track.id;
      isFetchingRadio = true;
      radioPromise = (async () => {
        try {
          const res = await fetch('/api/radio?vid=' + encodeURIComponent(track.id));
          if (res.ok) {
            const data = await res.json();
            const radioTracks = (data && data.results) ? data.results : [];
            if (radioTracks.length > 0) {
              if (currentTrack && currentTrack.id === track.id) {
                const played = (playlist && currentIndex >= 0) ? playlist.slice(0, currentIndex + 1) : [track];
                const playedIds = new Set(played.map(t => t.id));
                const newUpcoming = radioTracks.filter(t => !playedIds.has(t.id));
                playlist = [...played, ...newUpcoming];
                currentIndex = played.length - 1;
                prefetchNextTrack();
              }
            }
          }
        } catch (err) {
          console.warn('Radio queue fetch error:', err);
        } finally {
          isFetchingRadio = false;
        }
      })();
      return radioPromise;
    }

    async function playTrack(track, fromPlaylist = null, isAlbum = false, isInternalQueue = false) {
      if (!track) return;

      if (isAlbum && fromPlaylist && Array.isArray(fromPlaylist)) {
        playlist = fromPlaylist;
        currentIndex = playlist.findIndex(t => t.id === track.id);
        if (currentIndex === -1) currentIndex = 0;
      } else if (isInternalQueue) {
        const idx = (playlist && playlist.length) ? playlist.findIndex(t => t.id === track.id) : -1;
        if (idx !== -1) {
          currentIndex = idx;
        }
        if (playlist.length - currentIndex <= 4) {
          fetchRadioQueueForTrack(track);
        }
      } else {
        playlist = [track];
        currentIndex = 0;
        fetchRadioQueueForTrack(track);
      }

      currentTrack = track;

      // Sync track info with native Android notification & background service
      if (window.AndroidBridge && typeof window.AndroidBridge.onTrackChanged === 'function') {
        try {
          window.AndroidBridge.onTrackChanged(JSON.stringify(track));
        } catch (_) {}
      }
      // Cancion nueva: decirle a la APK que arranca en 0 (la duracion
      // real del stream se manda en cuanto el audio la reporte)
      syncAndroidPositionState(true);

      // Sync with OS MediaSession for lock screen, background audio, and controls
      if ('mediaSession' in navigator) {
        try {
          // Artwork multiresolucion para la notificacion/lockscreen
          const artSrc = (img, sz) => ({ src: \`https://i.ytimg.com/vi/\${track.id}/\${img}.jpg\`, sizes: sz, type: 'image/jpeg' });
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.artist,
            album: 'Aurora Music',
            artwork: track.thumb
              ? [{ src: track.thumb, sizes: '480x360', type: 'image/jpeg' }, artSrc('maxresdefault', '1280x720')]
              : [artSrc('default', '120x90'), artSrc('mqdefault', '320x180'), artSrc('hqdefault', '480x360'), artSrc('maxresdefault', '1280x720')]
          });
          const setAct = (act, fn) => { try { navigator.mediaSession.setActionHandler(act, fn); } catch (_) {} };
          // play/pause conscientes del estado: el SO a veces pausa/reanuda
          // por si mismo (auriculares, notificacion, lockscreen); un toggle
          // a ciegas re-arrancaria la musica al pausar desde la notificacion.
          setAct('play', () => { if (!isPlaying && typeof togglePlay === 'function') togglePlay(); });
          setAct('pause', () => { if (isPlaying && typeof togglePlay === 'function') togglePlay(); });
          setAct('previoustrack', () => { if (typeof prevTrack === 'function') prevTrack(); });
          setAct('nexttrack', () => { if (typeof nextTrack === 'function') nextTrack(); });
          setAct('stop', () => { try { if (isYtFallback && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo(); audio.pause(); } catch (_) {} });
          setAct('seekto', (d) => {
            try {
              if (d && d.seekTime != null && isFinite(d.seekTime)) {
                if (isYtFallback && ytPlayer && typeof ytPlayer.seekTo === 'function') ytPlayer.seekTo(d.seekTime, true);
                else audio.currentTime = d.seekTime;
                syncMediaPositionState();
              }
            } catch (_) {}
          });
          setAct('seekbackward', (d) => {
            try {
              const cur = isYtFallback && ytPlayer && typeof ytPlayer.getCurrentTime === 'function' ? (ytPlayer.getCurrentTime() || 0) : (audio.currentTime || 0);
              const t = Math.max(0, cur - ((d && d.seekOffset) || 10));
              if (isYtFallback && ytPlayer && typeof ytPlayer.seekTo === 'function') ytPlayer.seekTo(t, true);
              else audio.currentTime = t;
              syncMediaPositionState();
            } catch (_) {}
          });
          setAct('seekforward', (d) => {
            try {
              const dur = getSafeTrackDuration();
              const cur = isYtFallback && ytPlayer && typeof ytPlayer.getCurrentTime === 'function' ? (ytPlayer.getCurrentTime() || 0) : (audio.currentTime || 0);
              let t = cur + ((d && d.seekOffset) || 10);
              if (dur > 0) t = Math.min(t, Math.max(0, dur - 0.5));
              if (isYtFallback && ytPlayer && typeof ytPlayer.seekTo === 'function') ytPlayer.seekTo(t, true);
              else audio.currentTime = t;
              syncMediaPositionState();
            } catch (_) {}
          });
          syncMediaPositionState();
        } catch (_) {}
      }

      // Stop any existing YouTube player & timer immediately
      stopYtTimeTracker();
      if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        try { ytPlayer.stopVideo(); } catch (_) {}
      }
      isYtFallback = false;

      // Update bottom player bar
      if (pTitle) pTitle.textContent = track.title;
      if (pArtist) pArtist.textContent = track.artist;
      if (pCover) pCover.src = track.thumb || \`https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg\`;
      const pBar = $('playerBar');
      if (pBar) pBar.classList.add('visible', 'active');

      // Update expanded modal if open
      const mTitle = $('modalTitle');
      const mArtist = $('modalArtist');
      const mCover = $('modalCover');
      if (mTitle) mTitle.textContent = track.title;
      if (mArtist) mArtist.textContent = track.artist;
      if (mCover) mCover.src = track.thumb || \`https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg\`;

      // Reset scrubber & time immediately
      if (pProgressBar) pProgressBar.style.width = '0%';
      const curEl = $('currentTime') || $('curTime');
      if (curEl) curEl.textContent = '0:00';
      const durText = (track.duration && track.duration > 0) ? formatDuration(track.duration) : '--:--';
      const durEl = $('totalDuration') || $('durTime');
      if (durEl) durEl.textContent = durText;
      const mSlider = $('modalSlider');
      if (mSlider) mSlider.value = 0;
      const mCur = $('modalTimeElapsed');
      if (mCur) mCur.textContent = '0:00';
      const mDur = $('modalTimeTotal');
      if (mDur) mDur.textContent = durText;

      // Instant UI response (0ms visual delay)
      isPlaying = true;
      updatePlayIcons(true);
      updateLikeButtonState(track.id);

      // Record in playback history
      recordHistory(track);

      // Preload next track's connection & R2 key in warm worker cache
      nearEndPreloaded = false; // nueva cancion: re-armar la precarga near-end
      prefetchNextTrack();

      // Cargador inteligente: carrera servidor vs puente local + cache
      startSmartAudioLoad(track);
    }

    // --------------------------------------------------------
    // Puente local (receta DevMP3): si el servidor no puede resolver
    // el stream (IPs datacenter bloqueadas por YouTube), este
    // navegador intenta resolver con su propia IP. Si lo logra,
    // reproduce directo y ademas deja la cancion cacheada en la VM
    // (via /api/bridge) para que todos los usuarios la tengan al
    // instante.
    // --------------------------------------------------------
    const YTBR_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const ytbrVisitors = {};
    function ytbrNonce(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += YTBR_ALPHABET.charAt(Math.floor(Math.random() * YTBR_ALPHABET.length));
      return s;
    }
    async function ytbrVisitor(c) {
      if (ytbrVisitors[c.name]) return ytbrVisitors[c.name];
      try {
        const r = await fetch('https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: { client: Object.assign({}, c.client, { userAgent: c.ua }) } }),
          signal: AbortSignal.timeout(9000),
        });
        const j = await r.json();
        const v = j && j.responseContext && j.responseContext.visitorData;
        if (v && v.length > 20) { ytbrVisitors[c.name] = v; return v; }
      } catch (_) {}
      return null;
    }
    const YTBR_CLIENTS = [
      { name: 'ANDROID_VR', host: 'https://www.youtube.com/youtubei/v1/player',
        ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'es', gl: 'US' } },
      { name: 'IOS', host: 'https://www.youtube.com/youtubei/v1/player',
        ua: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
        client: { clientName: 'IOS', clientVersion: '21.26.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'es', gl: 'US' } },
      { name: 'ANDROID', host: 'https://www.youtube.com/youtubei/v1/player',
        ua: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
        client: { clientName: 'ANDROID', clientVersion: '21.26.364', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'es', gl: 'US' } },
      { name: 'VISIONOS', host: 'https://youtubei.googleapis.com/youtubei/v1/player', gapis: true,
        ua: 'com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; US)',
        client: { clientName: 'VISIONOS', clientVersion: '1.04', clientScreen: 'WATCH', platform: 'MOBILE', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.6.0.23O770', hl: 'es', gl: 'US' } },
    ];
    async function ytmResolveLocal(vid) {
      for (const c of YTBR_CLIENTS) {
        try {
          const vis = await ytbrVisitor(c);
          const client = Object.assign({}, c.client, { userAgent: c.ua });
          if (vis) client.visitorData = vis;
          const headers = { 'Content-Type': 'application/json' };
          if (c.gapis) headers['X-Goog-Api-Format-Version'] = '2';
          let u = c.host + '?prettyPrint=false';
          if (c.gapis) u += '&t=' + ytbrNonce(12) + '&id=' + encodeURIComponent(vid);
          const r = await fetch(u, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ context: { client: client }, videoId: vid, cpn: ytbrNonce(16), contentCheckOk: true, racyCheckOk: true }),
            signal: AbortSignal.timeout(12000),
          });
          if (!r.ok) continue;
          const j = await r.json();
          const ps = j.playabilityStatus || {};
          if (ps.status !== 'OK') continue;
          const fmts = (j.streamingData || {}).adaptiveFormats || [];
          let pick = fmts.find(f => f.itag === 140 && f.url) || fmts.find(f => f.url && (f.mimeType || '').indexOf('audio/mp4') !== -1);
          if (pick) return { u: pick.url, ua: c.ua };
        } catch (_) {}
      }
      return null;
    }

    // URLs resueltas por este navegador (replay instantaneo en la sesion)
    const gvStreamCache = new Map();
    let smartLoadToken = 0;
    let smartBridgePendingVid = null; // vid con puente en curso (el listener de error lo respeta)

    function switchToGvStream(url, vid) {
      stopYtTimeTracker();
      if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        try { ytPlayer.stopVideo(); } catch (_) {}
      }
      isYtFallback = false;
      audio.src = url;
      const p = audio.play();
      if (p !== undefined) {
        p.catch(err => {
          if (err.name === 'AbortError') return;
          playViaYouTubeIframe(vid);
        });
      }
    }

    function serverAudioReady() {
      return !audio.paused && !audio.ended && audio.readyState >= 2;
    }

    // v2.6 — tope de paciencia: si a los 45s nada esta sonando (servidor
    // lento + puente todavia resolviendo), el iframe toma el mando. El
    // puente sigue su curso: lo que resuelva se cachea en la VM para todos.
    let smartIframeDeadlineMs = 45000;

    async function startSmartAudioLoad(track) {
      const vid = track.id;
      const myToken = ++smartLoadToken;
      smartBridgePendingVid = vid;
      setTimeout(() => {
        if (myToken !== smartLoadToken) return;      // la cancion ya cambio
        if (isYtFallback) return;                    // el iframe ya esta activo
        if (!isPlaying) return;                      // el usuario pauso
        if (!currentTrack || currentTrack.id !== vid) return; // track obsoleto
        if (serverAudioReady()) return;              // el servidor ya esta sonando
        playViaYouTubeIframe(vid);
      }, smartIframeDeadlineMs);

      // 0) URL ya resuelta por este navegador en esta sesion: replay al instante
      const cached = gvStreamCache.get(vid);
      if (cached && cached.u) {
        switchToGvStream(cached.u, vid);
        smartBridgePendingVid = null;
        return;
      }

      // VIA A (servidor): R2 -> VM conv -> innertube. El error listener y
      // el play().catch gestionan los fallos de esta via.
      const streamUrl = \`/api/stream?vid=\${encodeURIComponent(vid)}&id=\${encodeURIComponent(vid)}\`;
      const sameSrc = audio.src && audio.src === new URL(streamUrl, window.location.href).href;
      if (!sameSrc) {
        audio.src = streamUrl;
      } else if (audio.readyState >= 1) {
        try { audio.currentTime = 0; } catch (_) {}
      }
      const p = audio.play();
      if (p !== undefined) {
        p.catch(err => {
          if (err.name === 'AbortError') return;
          // la via del servidor fallo al arrancar: el puente (si puede) o
          // el iframe se encargan; si el puente ya no esta pendiente, iframe
          if (myToken === smartLoadToken && !isYtFallback && smartBridgePendingVid !== vid) {
            playViaYouTubeIframe(vid);
          }
        });
      }

      // VIA B (puente local) en paralelo: el navegador resuelve con su IP
      ytmResolveLocal(vid).then(res => {
        if (myToken !== smartLoadToken) return; // el usuario ya cambio de cancion
        if (smartBridgePendingVid === vid) smartBridgePendingVid = null;
        if (res && res.u) {
          gvStreamCache.set(vid, res);
          // v2.6 — cachear en la VM SIEMPRE (ayuda a todos los usuarios),
          // incluso si aqui ya estamos escuchando por el iframe
          fetch('/api/bridge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vid: vid, u: res.u, ua: res.ua })
          }).catch(() => {});
          if (!serverAudioReady() && !isYtFallback) {
            // el servidor no llego (o fallo) y el iframe no esta sonando:
            // reproducir directo con la IP de este navegador
            switchToGvStream(res.u, vid);
          }
        } else if (!serverAudioReady() && !isYtFallback) {
          // puente fallido y servidor sin audio: iframe de YouTube
          playViaYouTubeIframe(vid);
        }
      }).catch(() => {
        if (myToken === smartLoadToken && smartBridgePendingVid === vid) smartBridgePendingVid = null;
      });
    }

    function prefetchNextTrack(withAudio) {
      try {
        if (playlist && playlist.length > 0 && currentIndex >= 0) {
          const nextIdx = (currentIndex + 1 < playlist.length) ? currentIndex + 1 : (repeatMode === 'all' ? 0 : -1);
          if (nextIdx >= 0 && playlist[nextIdx] && playlist[nextIdx].id) {
            const nextVid = playlist[nextIdx].id;
            // Calentar caches del servidor (barato, sin cuerpo)
            fetch(\`/api/stream?vid=\${encodeURIComponent(nextVid)}&id=\${encodeURIComponent(nextVid)}\`, { method: 'HEAD' }).catch(() => {});
            // Precarga REAL de audio (solo cuando se pide, p.ej. al acercarse
            // al final): llena el cache HTTP del navegador para que el cambio
            // de cancion — incluso en segundo plano o pantalla bloqueada —
            // arranque al instante sin depender de la red.
            if (withAudio === true) preloadNextAudioData(nextVid);
          }
        }
      } catch (_) {}
    }

    // Preloader del siguiente track: <audio> oculto muteado que descarga el
    // stream por adelantado. R2 sirve los streams con Cache-Control public
    // immutable, asi el swap del src principal sale del cache de disco.
    let preloaderAudio = null;
    const preloadedVids = new Set();
    function preloadNextAudioData(vid) {
      try {
        if (!vid || preloadedVids.has(vid)) return;
        // Respetar el modo ahorro de datos del usuario
        if (navigator.connection && navigator.connection.saveData) return;
        preloadedVids.add(vid);
        if (preloadedVids.size > 24) preloadedVids.clear();
        if (!preloaderAudio) {
          preloaderAudio = document.createElement('audio');
          preloaderAudio.preload = 'auto';
          preloaderAudio.muted = true; // nunca suena, solo llena el cache
        }
        try { preloaderAudio.pause(); } catch (_) {}
        preloaderAudio.src = \`/api/stream?vid=\${encodeURIComponent(vid)}&id=\${encodeURIComponent(vid)}\`;
        try { preloaderAudio.load(); } catch (_) {}
      } catch (_) {}
    }

    let ytTimeInterval = null;

    function startYtTimeTracker() {
      stopYtTimeTracker();
      ytTimeInterval = setInterval(() => {
        if (!isYtFallback || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
        try {
          const cur = ytPlayer.getCurrentTime() || 0;
          const dur = (typeof ytPlayer.getDuration === 'function' ? ytPlayer.getDuration() : 0) || (currentTrack ? (currentTrack.duration || 0) : 0) || 0;
          
          if (cur >= 0) {
            const pct = (dur > 0) ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
            const pBar = $('progressBar');
            if (pBar) pBar.style.width = pct + '%';
            
            const curStr = formatDuration(cur);
            const pCur = $('currentTime') || $('curTime');
            if (pCur) pCur.textContent = curStr;

            if (dur > 0) {
              const durStr = formatDuration(dur);
              const pDur = $('totalDuration') || $('durTime');
              if (pDur) pDur.textContent = durStr;
              const mDur = $('modalTimeTotal');
              if (mDur) mDur.textContent = durStr;
            }

            const mSlider = $('modalSlider');
            if (mSlider && !isScrubbing) mSlider.value = pct;
            const mCur = $('modalTimeElapsed');
            if (mCur) mCur.textContent = curStr;
          }
        } catch (_) {}
      }, 250);
    }

    function stopYtTimeTracker() {
      if (ytTimeInterval) {
        clearInterval(ytTimeInterval);
        ytTimeInterval = null;
      }
    }

    // AURORA-MUSIC v2.6 — anti doble-audio: NUNCA dos motores sonando.
    // Mata la via del servidor (stream pendiente incluido): si no, cuando el
    // stream "despierta" minutos despues suena junto con el iframe, y al
    // pausar solo se pausa uno de los dos (la doble queda "debajo").
    function stopServerAudio() {
      try { audio.pause(); } catch (_) {}
      try { audio.removeAttribute('src'); } catch (_) {}
      try { audio.load(); } catch (_) {}
    }

    // v2.6 — videos con iframe ya fallido (embed deshabilitado, red, etc.)
    const iframeFailedVids = new Set();
    // v2.6 — video que el iframe esta reproduciendo ahora
    let ytActiveVid = null;

    function playViaYouTubeIframe(videoId) {
      // v2.6 — si el iframe ya esta sonando ESTE video, no re-arrancarlo
      // (un loadVideoById reiniciaria la cancion desde cero)
      if (isYtFallback && ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        try {
          const st = ytPlayer.getPlayerState();
          if ((st === 1 || st === 3) && typeof ytPlayer.getVideoUrl === 'function' &&
              String(ytPlayer.getVideoUrl()).indexOf(videoId) !== -1) return;
        } catch (_) {}
      }
      // v2.6 — a este video el iframe ya le fallo una vez: no reintentarlo
      // (y NO matar la via del servidor, que sigue siendo la ultima carta)
      if (iframeFailedVids.has(videoId)) return;
      stopServerAudio();
      ytActiveVid = videoId;
      isYtFallback = true;
      if (!ytPlayer) {
        if (window.YT && window.YT.Player) {
          initYTPlayer(videoId);
        } else {
          window.onYouTubeIframeAPIReady = () => initYTPlayer(videoId);
        }
      } else {
        try {
          ytPlayer.loadVideoById(videoId);
          ytPlayer.playVideo();
          isPlaying = true;
          updatePlayIcons(true);
          startYtTimeTracker();
        } catch (_) {}
      }
    }

    function initYTPlayer(videoId) {
      ytPlayer = new YT.Player('ytPlayerContainer', {
        height: '200',
        width: '200',
        videoId: videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
          modestbranding: 1
        },
        events: {
          onReady: (e) => {
            e.target.playVideo();
            isPlaying = true;
            updatePlayIcons(true);
            startYtTimeTracker();
          },
          // v2.6 — el iframe fallo (embed deshabilitado, red, etc.):
          // devolver el control a la via servidor/puente con UN reintento
          onError: (e) => {
            try {
              if (isYtFallback && ytActiveVid) {
                iframeFailedVids.add(ytActiveVid);
                if (iframeFailedVids.size > 50) iframeFailedVids.clear();
                isYtFallback = false;
                isPlaying = false;
                updatePlayIcons(false);
                stopYtTimeTracker();
                if (currentTrack && currentTrack.id === ytActiveVid && !serverAudioReady()) {
                  startSmartAudioLoad(currentTrack);
                }
              }
            } catch (_) {}
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) {
              isPlaying = true;
              updatePlayIcons(true);
              startYtTimeTracker();
              try {
                const dur = ytPlayer.getDuration();
                if (dur && dur > 1) {
                  const durStr = formatDuration(dur);
                  const pDur = $('totalDuration') || $('durTime');
                  if (pDur) pDur.textContent = durStr;
                  const mDur = $('modalTimeTotal');
                  if (mDur) mDur.textContent = durStr;
                }
              } catch (_) {}
            } else if (e.data === YT.PlayerState.PAUSED) {
              isPlaying = false;
              updatePlayIcons(false);
              stopYtTimeTracker();
            } else if (e.data === YT.PlayerState.ENDED) {
              stopYtTimeTracker();
              handleTrackEnded();
            }
          }
        }
      });
    }

    function togglePlay() {
      if (!currentTrack) {
        if (playlist.length > 0) playTrack(playlist[0], playlist, false, true);
        return;
      }
      if (isYtFallback && ytPlayer) {
        if (isPlaying) {
          try { ytPlayer.pauseVideo(); } catch (_) {}
          // v2.6 — defensa: si quedara audio del servidor sonando "debajo", matarlo
          try { if (!audio.paused) audio.pause(); } catch (_) {}
          isPlaying = false;
          updatePlayIcons(false);
          stopYtTimeTracker();
        } else {
          try { ytPlayer.playVideo(); } catch (_) {}
          isPlaying = true;
          updatePlayIcons(true);
          startYtTimeTracker();
        }
        return;
      }
      if (audio.paused) {
        isPlaying = true;
        updatePlayIcons(true);
        const p = audio.play();
        if (p !== undefined) {
          p.catch(err => {
            if (err.name !== 'AbortError') {
              console.warn('Play error:', err);
              isPlaying = false;
              updatePlayIcons(false);
            }
          });
        }
      } else {
        audio.pause();
        // v2.6 — defensa: detener el iframe si por cualquier ruta quedo vivo
        try { if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo(); } catch (_) {}
        isPlaying = false;
        updatePlayIcons(false);
      }
    }

    async function playNext() {
      if (isFetchingRadio && radioPromise) {
        try { await radioPromise; } catch (_) {}
      }
      if (!playlist.length && currentTrack) {
        try { await fetchRadioQueueForTrack(currentTrack); } catch (_) {}
      }
      if (!playlist.length) return;
      if (repeatMode === 'one' && currentTrack) {
        playTrack(currentTrack, playlist, false, true);
        return;
      }
      let nextIdx = currentIndex + 1;
      if (nextIdx >= playlist.length) {
        if (currentTrack) {
          try { await fetchRadioQueueForTrack(currentTrack); } catch (_) {}
          if (currentIndex + 1 < playlist.length) {
            nextIdx = currentIndex + 1;
          } else if (repeatMode === 'all') {
            nextIdx = 0;
          } else {
            return;
          }
        } else if (repeatMode === 'all') {
          nextIdx = 0;
        } else {
          return;
        }
      }
      playTrack(playlist[nextIdx], playlist, false, true);
    }

    function playPrev() {
      if (!playlist.length) return;
      if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
      }
      let prevIdx = currentIndex - 1;
      if (prevIdx < 0) {
        if (repeatMode === 'all') prevIdx = playlist.length - 1;
        else prevIdx = 0;
      }
      playTrack(playlist[prevIdx], playlist, false, true);
    }

    const nextTrack = playNext;
    const prevTrack = playPrev;

    let lastEndedCallTime = 0;
    function handleTrackEnded() {
      const now = Date.now();
      if (now - lastEndedCallTime < 600) return;
      lastEndedCallTime = now;

      // Verify track actually played to near completion before skipping
      if (isYtFallback && ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && typeof ytPlayer.getDuration === 'function') {
        try {
          const cur = ytPlayer.getCurrentTime() || 0;
          const dur = ytPlayer.getDuration() || 0;
          if (dur > 3 && cur < dur - 2.5) return;
        } catch (_) {}
      } else if (audio && audio.duration && isFinite(audio.duration) && audio.duration > 3) {
        if (audio.currentTime < audio.duration - 2.5) return;
      }

      if (repeatMode === 'one' && currentTrack) {
        playTrack(currentTrack, playlist, false, true);
        return;
      }
      playNext();
    }

    // Audio element event listeners
    audio.addEventListener('play', () => {
      if (isYtFallback) return; // v2.6 — el motor activo es el iframe: ignorar al otro
      isPlaying = true;
      updatePlayIcons(true);
      syncMediaPositionState();
    });

    audio.addEventListener('seeked', () => {
      syncMediaPositionState();
      syncAndroidPositionState();
    });

    audio.addEventListener('playing', () => {
      if (isYtFallback) return; // v2.6
      isPlaying = true;
      updatePlayIcons(true);
    });

    audio.addEventListener('pause', () => {
      if (isYtFallback) return; // v2.6 — no pintar "pausado" si el iframe esta sonando
      isPlaying = false;
      updatePlayIcons(false);
    });

    audio.addEventListener('loadedmetadata', () => {
      syncMediaPositionState();
      syncAndroidPositionState();
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        const durStr = formatDuration(audio.duration);
        const pDur = $('totalDuration') || $('durTime');
        if (pDur) pDur.textContent = durStr;
        const mDur = $('modalTimeTotal');
        if (mDur) mDur.textContent = durStr;
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (isYtFallback || isScrubbing) return;
      const cur = audio.currentTime || 0;
      const dur = (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration))
        ? audio.duration
        : (currentTrack ? (currentTrack.duration || 0) : 0);

      const pct = (dur > 0) ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;

      if (pProgressBar) pProgressBar.style.width = pct + '%';
      
      const curStr = formatDuration(cur);
      const pCur = $('currentTime') || $('curTime');
      if (pCur) pCur.textContent = curStr;

      const mCur = $('modalTimeElapsed');
      if (mCur) mCur.textContent = curStr;

      if (dur > 0) {
        const durStr = formatDuration(dur);
        const pDur = $('totalDuration') || $('durTime');
        if (pDur) pDur.textContent = durStr;
        const mDur = $('modalTimeTotal');
        if (mDur) mDur.textContent = durStr;
      }

      const mSlider = $('modalSlider');
      if (mSlider) mSlider.value = pct;

      // Mantener fresca la posicion del Media Session (cada ~5s) para que
      // el scrubber de la lockscreen/notificacion no se quede atras.
      const nowMs = Date.now();
      if (nowMs - lastPosSyncMs > 5000) {
        lastPosSyncMs = nowMs;
        syncMediaPositionState();
      }

      // Posicion hacia la APK cada ~2s: el SO anima la barra de la
      // notificacion por si mismo; esto mantiene la deriva a ~0 y
      // asegura un freeze exacto en la proxima pausa.
      if (nowMs - lastAndroidSyncMs > 2000) {
        syncAndroidPositionState();
      }

      // A ~90s del final: precarga REAL del siguiente track para que la
      // transicion sea instantanea incluso en segundo plano.
      if (!nearEndPreloaded && !isYtFallback && dur > 0 && (dur - cur) <= 90) {
        nearEndPreloaded = true;
        prefetchNextTrack(true);
      }
    });

    audio.addEventListener('ended', handleTrackEnded);

    // Al volver del segundo plano: resincronizar el icono de play con
    // el estado real del audio (el SO pudo pausar/reanudar por fuera)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentTrack && !isYtFallback) {
        const actuallyPlaying = !audio.paused && !audio.ended;
        if (actuallyPlaying !== isPlaying) updatePlayIcons(actuallyPlaying);
        // Resincronizar posicion: el audio pudo seguir en segundo plano
        // mientras la UI estuvo congelada
        syncMediaPositionState();
        syncAndroidPositionState();
      }
    });

    audio.addEventListener('error', (e) => {
      // Ignore user-aborted loads (from rapid skips, seeks, or switching tracks)
      if (audio.error && audio.error.code === 1) return;
      if (!audio.src || audio.src === 'about:blank' || audio.src === window.location.href) return;
      console.warn('Audio stream error:', audio.error);
      // si hay un puente local en curso para esta cancion, dejarlo decidir
      // (reproduce directo o cae al iframe el mismo); solo si ya no hay
      // puente pendiente, ir al iframe de inmediato
      if (currentTrack && !isYtFallback) {
        if (smartBridgePendingVid === currentTrack.id) return;
        playViaYouTubeIframe(currentTrack.id);
      }
    });

    // Real-Time Bottom Scrubber Click & Drag Handler
    if (pScrubber) {
      pScrubber.onclick = (e) => {
        const rect = pScrubber.getBoundingClientRect();
        if (!rect.width) return;
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getSafeTrackDuration();
        if (dur > 0) {
          const seekTime = Math.min(dur - 0.5, Math.max(0, pos * dur));
          if (isFinite(seekTime)) {
            if (isYtFallback && ytPlayer && typeof ytPlayer.seekTo === 'function') {
              try { ytPlayer.seekTo(seekTime, true); } catch (_) {}
            } else if (audio) {
              try { audio.currentTime = seekTime; } catch (_) {}
            }
          }
          const pBar = $('progressBar');
          if (pBar) pBar.style.width = (pos * 100) + '%';
          const pCur = $('currentTime') || $('curTime');
          if (pCur) pCur.textContent = formatDuration(seekTime);
          const mSlider = $('modalSlider');
          if (mSlider) mSlider.value = pos * 100;
          const mCur = $('modalTimeElapsed');
          if (mCur) mCur.textContent = formatDuration(seekTime);
        }
      };
    }

    function toggleCurrentLike() {
      if (currentTrack) toggleLike(currentTrack);
    }

    function downloadCurrentTrack() {}

    function copyCurrentShareLink() {
      if (currentTrack) openShareModal(currentTrack);
    }

    function menuPlayCurrent() {
      closeTrackMenu();
      if (activeMenuTrack) playTrack(activeMenuTrack, null, activeMenuIsAlbum, false);
    }

    function menuToggleLike() {
      if (activeMenuTrack) toggleLike(activeMenuTrack);
      closeTrackMenu();
    }

    function clearSearch() {
      if (sInput) {
        sInput.value = '';
        sInput.focus();
      }
      const clearBtn = $('searchClear');
      if (clearBtn) clearBtn.style.display = 'none';
      const recentBox = $('searchRecentContainer');
      const resultsBox = $('searchResultsContainer');
      if (recentBox) recentBox.style.display = 'block';
      if (resultsBox) resultsBox.style.display = 'none';
      renderRecentSearches();
    }

    function setAudioQuality(q) {
      localStorage.setItem('aurora_quality', q);
      ['ultra', 'high', 'normal', 'data'].forEach(k => {
        const btn = $('btnQuality' + k.charAt(0).toUpperCase() + k.slice(1));
        if (btn) btn.classList.toggle('active', k === q);
      });
      showToast((t('audioQuality') || 'Calidad') + ': ' + q.toUpperCase());
    }
    // --------------------------------------------------------
    // Likes & Playback History
    // --------------------------------------------------------
    let likesSet = new Set();

    async function loadLikesSet() {
      try {
        const likes = await dbGetAll('likes');
        likesSet = new Set(likes.map(t => t.id));
        if (currentTrack) updateLikeButtonState(currentTrack.id);
      } catch (_) {}
    }

    async function toggleLike(track) {
      if (!track) return;
      if (likesSet.has(track.id)) {
        await dbDelete('likes', track.id);
        likesSet.delete(track.id);
        showToast(t('unlikedToast'));
      } else {
        await dbPut('likes', { ...track, likedAt: Date.now() });
        likesSet.add(track.id);
        showToast(t('likedToast'));
      }
      updateLikeButtonState(track.id);
      if ($('view-library')?.classList.contains('active')) {
        loadLikesView();
      }
    }

    function updateLikeButtonState(trackId) {
      const isLiked = likesSet.has(trackId);
      const btn = $('btnLike');
      if (btn) {
        btn.innerHTML = isLiked
          ? \`<svg width="20" height="20" viewBox="0 0 24 24" fill="#f43f5e" stroke="#f43f5e" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>\`
          : \`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>\`;
      }
      const menuText = $('menuLikeText');
      if (menuText) {
        menuText.textContent = isLiked ? t('removeFromFavorites') : t('addToFavorites');
      }
    }

    async function recordHistory(track) {
      try {
        const existing = await dbGet('history', track.id);
        const now = Date.now();
        const recentPlays = existing && existing.recentPlays ? existing.recentPlays : [];
        recentPlays.unshift(now);
        const updated = {
          ...track,
          lastPlayed: now,
          playCount: (existing ? existing.playCount : 0) + 1,
          recentPlays: recentPlays.slice(0, 20)
        };
        await dbPut('history', updated);
      } catch (_) {}
    }

    async function clearFullHistory() {
      console.log('Playback history is permanently preserved.');
    }

    async function loadLikesView() {
      const container = $('libLikesList');
      if (!container) return;
      const likes = await dbGetAll('likes');
      const badge = $('likesCountBadge');
      if (badge) {
        badge.textContent = likes.length + ' ' + (likes.length === 1 ? (t('savedSong') || 'guardada') : (t('savedSongs') || 'guardadas'));
      }
      likes.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
      container.innerHTML = '';
      if (!likes.length) {
        container.innerHTML = \`<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:14px;">\${t('favoritesEmpty')}</div>\`;
        return;
      }
      renderTrackRows(likes, container);
    }

    async function loadHistoryView() {
      const container = $('historyDateGroupedContainer');
      if (!container) return;
      const history = await dbGetAll('history');
      history.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
      container.innerHTML = '';

      if (!history.length) {
        container.innerHTML = \`<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:14px;">\${t('recentHistoryEmpty')}</div>\`;
        return;
      }

      // Group by date (Today, Yesterday, Last 7 Days, Older)
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const yesterdayStart = todayStart - 86400000;
      const weekStart = todayStart - 6 * 86400000;

      const groups = {
        today: [],
        yesterday: [],
        week: [],
        older: []
      };

      history.forEach(t => {
        const lp = t.lastPlayed || 0;
        if (lp >= todayStart) groups.today.push(t);
        else if (lp >= yesterdayStart) groups.yesterday.push(t);
        else if (lp >= weekStart) groups.week.push(t);
        else groups.older.push(t);
      });

      const groupLabels = [
        { key: 'today', title: 'Hoy' },
        { key: 'yesterday', title: 'Ayer' },
        { key: 'week', title: 'Esta semana' },
        { key: 'older', title: 'M\u00e1s antiguos' }
      ];

      groupLabels.forEach(g => {
        const list = groups[g.key];
        if (!list || !list.length) return;

        const header = document.createElement('div');
        header.className = 'ytm-sec-header';
        header.style.marginTop = '18px';
        header.innerHTML = \`<h3 style="font-size:16px;font-weight:700;color:var(--primary);">\${g.title} (\${list.length})</h3>\`;
        container.appendChild(header);

        const listDiv = document.createElement('div');
        listDiv.className = 'track-list';
        renderTrackRows(list, listDiv);
        container.appendChild(listDiv);
      });
    }

    // --------------------------------------------------------
    // Track List Renderer (Clean, YouTube Music Style with 3 dots)
    // --------------------------------------------------------
    function renderTrackRows(tracks, containerEl, isAlbumDetail = false, albumId = null) {
      if (!containerEl) return;
      containerEl.innerHTML = '';

      tracks.forEach((track, idx) => {
        const row = document.createElement('div');
        row.className = 'track-row' + (currentTrack && currentTrack.id === track.id ? ' active' : '');
        row.innerHTML = \`
          <div class="track-row-index">\${idx + 1}</div>
          <div class="track-row-thumb-wrap">
            <img class="track-row-thumb" src="\${track.thumb || 'https://i.ytimg.com/vi/' + track.id + '/hqdefault.jpg'}" loading="lazy" alt="Cover">
            <div class="track-row-play">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
          <div class="track-row-info">
            <div class="track-row-title">\${track.title}\${track.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
            <div class="track-row-artist">\${track.artist}</div>
          </div>
          <div class="track-row-duration">\${formatDuration(track.duration || 0)}</div>
          <button class="track-row-menu" title="M\u00e1s opciones">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        \`;

        row.onclick = (e) => {
          if (e.target.closest('.track-row-menu')) {
            e.stopPropagation();
            openTrackMenu(track, isAlbumDetail, albumId);
            return;
          }
          if (isAlbumDetail) {
            playTrack(track, tracks, true, false);
          } else {
            playTrack(track, null, false, false);
          }
        };

        containerEl.appendChild(row);
      });
    }

    // --------------------------------------------------------
    // Track Context Menu (3-dots) & Direct Device Download
    // --------------------------------------------------------
    let activeMenuTrack = null;
    let activeMenuIsAlbum = false;
    let activeMenuAlbumId = null;

    function openWebTrackMenu(track, isAlbum = false, albumId = null) {
      if (!track) return;
      const openMenu = () => {
        const m = $('trackMenuModal');
        if (m) {
          m.classList.add('active', 'open');
          document.body.classList.add('modal-open');
        }
      };
      try {
      activeMenuTrack = track;
      activeMenuIsAlbum = isAlbum;
      activeMenuAlbumId = albumId;

      const modal = $('trackMenuModal');
      const thumb = $('menuTrackThumb');
      const title = $('menuTrackTitle');
      const artist = $('menuTrackArtist');
      const likeText = $('menuLikeText');

      if (thumb) thumb.src = track.thumb || \`https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg\`;
      if (title) title.textContent = track.title || '-';
      if (artist) artist.textContent = track.artist || '-';
      if (likeText) {
        const liked = (typeof likesSet !== 'undefined' && likesSet && typeof likesSet.has === 'function') ? likesSet.has(track.id) : false;
        likeText.textContent = liked ? t('removeFromFavorites') : t('addToFavorites');
      }

      openMenu();
      } catch (err) {
        // aunque falle algo cosmético (miniatura, i18n, likes…), el
        // menú SIEMPRE debe abrirse
        console.warn('track menu error:', err);
        openMenu();
      }
    }

    window.openTrackMenuWeb = function(track) {
      openWebTrackMenu(track);
    };

    function openTrackMenu(track, isAlbum = false, albumId = null) {
      if (!track) return;
      if (window.AndroidBridge && typeof window.AndroidBridge.showEnhancedTrackMenu === 'function') {
        try {
          window.AndroidBridge.showEnhancedTrackMenu(JSON.stringify(track));
          return;
        } catch (_) {}
      }
      openWebTrackMenu(track, isAlbum, albumId);
      return;
    }
    const _ignoredUnused = function() {
      activeMenuTrack = track;
      activeMenuIsAlbum = isAlbum;
      activeMenuAlbumId = albumId;

      const titleEl = $('menuTrackTitle');
      const artistEl = $('menuTrackArtist');
      const thumbEl = $('menuTrackThumb') || $('menuTrackCover');
      if (titleEl) titleEl.textContent = track.title;
      if (artistEl) artistEl.textContent = track.artist;
      if (thumbEl) thumbEl.src = track.thumb || \`https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg\`;
      
      const likeText = $('menuLikeText');
      if (likeText) {
        likeText.textContent = likesSet.has(track.id) ? (t('removeFromFavorites') || 'Quitar de Favoritos') : (t('addToFavorites') || 'A\u00f1adir a Favoritos');
      }

      const modal = $('trackMenuModal');
      if (modal) modal.classList.add('active', 'open');
    }

    function closeTrackMenu() {
      const modal = $('trackMenuModal');
      if (modal) modal.classList.remove('active', 'open');
    }

    function menuLike() {
      if (activeMenuTrack) toggleLike(activeMenuTrack);
      closeTrackMenu();
    }

    function menuDownload() { closeTrackMenu(); }

    function openShareModal(track = null) {
      closeTrackMenu();
      const target = track || activeMenuTrack || currentTrack;
      if (!target || !target.id) return;
      const url = \`\${window.location.origin}/?v=\${encodeURIComponent(target.id)}\`;
      const text = \`\${target.title || 'Cancion'} - \${target.artist || 'Artista'}\`;

      const input = $('shareLinkInput');
      if (input) input.value = url;

      const waBtn = $('shareBtnWhatsapp');
      if (waBtn) waBtn.href = \`https://api.whatsapp.com/send?text=\${encodeURIComponent(text + ' ' + url)}\`;

      const twBtn = $('shareBtnTwitter');
      if (twBtn) twBtn.href = \`https://twitter.com/intent/tweet?url=\${encodeURIComponent(url)}&text=\${encodeURIComponent(text)}\`;

      const fbBtn = $('shareBtnFacebook');
      if (fbBtn) fbBtn.href = \`https://www.facebook.com/sharer/sharer.php?u=\${encodeURIComponent(url)}\`;

      const tgBtn = $('shareBtnTelegram');
      if (tgBtn) tgBtn.href = \`https://t.me/share/url?url=\${encodeURIComponent(url)}&text=\${encodeURIComponent(text)}\`;

      const emBtn = $('shareBtnEmail');
      if (emBtn) emBtn.href = \`mailto:?subject=\${encodeURIComponent(text)}&body=\${encodeURIComponent(url)}\`;

      const modal = $('shareModal');
      if (modal) modal.classList.add('open', 'active');
    }

    function closeShareModal(e) {
      if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('ytm-share-close')) return;
      const modal = $('shareModal');
      if (modal) modal.classList.remove('open', 'active');
    }

    function copyShareModalLink() {
      const input = $('shareLinkInput');
      const url = input ? input.value : (currentTrack ? \`\${window.location.origin}/?v=\${currentTrack.id}\` : window.location.href);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          showToast('Enlace copiado al portapapeles');
          const btnText = $('shareCopyBtnText');
          if (btnText) {
            btnText.textContent = '¡Copiado!';
            setTimeout(() => { btnText.textContent = 'Copiar'; }, 2000);
          }
        }).catch(() => {
          if (input) input.select();
          showToast('Enlace copiado al portapapeles');
        });
      } else {
        if (input) input.select();
        showToast('Enlace copiado al portapapeles');
      }
    }

    const menuCopyLink = openShareModal;

    let savedScrollY = 0;

    function lockBodyScroll() {
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.documentElement.classList.add('modal-open');
      document.body.classList.add('modal-open');
      document.body.style.top = \`-\${savedScrollY}px\`;
    }

    function unlockBodyScroll() {
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
      document.body.style.top = '';
      window.scrollTo(0, savedScrollY);
    }

        function openDownloadFallbackModal() {}
    function closeDownloadFallbackModal() {}
    function downloadTrackToDevice() {}
    const downloadTrackDirect = downloadTrackToDevice;

    // --------------------------------------------------------
    // Settings Modal (With Strict Background Scroll Lock)
    // --------------------------------------------------------
    function openSettingsModal() {
      renderLanguageGrid();
      const modal = $('settingsModal');
      if (modal) {
        modal.classList.add('open');
        lockBodyScroll();
      }
    }

    function closeSettingsModal(e = null) {
      if (e && e.target && e.target !== $('settingsModal') && !e.target.classList.contains('settings-close-btn')) {
        return;
      }
      const modal = $('settingsModal');
      if (modal) {
        modal.classList.remove('open');
        unlockBodyScroll();
      }
    }

    function openLegalModal() {
      renderAllLegalViews();
      const modal = $('legalModal');
      if (modal) {
        modal.classList.add('open');
        lockBodyScroll();
      }
    }

    function closeLegalModal() {
      const modal = $('legalModal');
      if (modal) {
        modal.classList.remove('open');
        unlockBodyScroll();
      }
    }
    function navigateToTerms() {
      closeSettingsModal();
      closeLegalModal();
      renderAllLegalViews();
      switchView('terms');
      try { history.pushState({ view: 'terms' }, '', '/terms'); } catch (_) {}
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function navigateToHome() {
      switchView('home');
      try { history.pushState({ view: 'home' }, '', '/'); } catch (_) {}
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // AURORA-MUSIC v2.3 — Pagina "Obtener la app"
    function navigateToApp() {
      closeSettingsModal();
      closeLegalModal();
      switchView('app');
      try { history.pushState({ view: 'app' }, '', '/app'); } catch (_) {}
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Explicit global attachments for HTML inline onclick handlers
    window.navigateToTerms = navigateToTerms;
    window.navigateToHome = navigateToHome;
    window.navigateToApp = navigateToApp;
    window.toggleLangDropdown = toggleLangDropdown;
    window.toggleQualityDropdown = toggleQualityDropdown;
    window.selectLanguageOption = selectLanguageOption;
    window.selectAudioQualityOption = selectAudioQualityOption;
    window.openLegalModal = openLegalModal;
    window.closeLegalModal = closeLegalModal;

    // --------------------------------------------------------
    // Toast Notification
    // --------------------------------------------------------
    let toastTimeout = null;
    function showToast(msg) {
      const el = $('appToast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      if (toastTimeout) clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        el.classList.remove('show');
      }, 2500);
    }

    // --------------------------------------------------------
    // Home View Feed & Reusable Renderers
    // --------------------------------------------------------
    async function renderQuickPicks() {
      const grid = $('homeQuickPicksGrid');
      if (!grid) return;
      let tracks = [];
      try {
        const history = await dbGetAll('history');
        if (history && history.length >= 2) {
          history.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
          tracks = history.slice(0, 12);
        }
      } catch (_) {}
      if (!tracks.length && window._homeData) {
        tracks = (window._homeData.featured || window._homeData.trending || []).slice(0, 12);
      }
      if (!tracks.length) return;
      grid.innerHTML = '';
      tracks.forEach(t => {
        const card = document.createElement('div');
        card.className = 'ytm-quick-card';
        card.innerHTML = \`
          <div class="ytm-quick-thumb-box">
            <img class="ytm-quick-thumb" src="\${t.thumb}" loading="lazy" alt="Cover" onerror="this.src='https://i.ytimg.com/vi/\${t.id}/hqdefault.jpg'">
            <div class="ytm-quick-play-btn" title="Reproducir">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </div>
          </div>
          <div class="ytm-quick-info">
            <div class="ytm-quick-title">\${t.title}\${t.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
            <div class="ytm-quick-artist">\${t.artist}</div>
          </div>
          <button class="ytm-quick-opt-btn" title="M\u00e1s opciones">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        \`;
        card.onclick = (e) => {
          if (e.target.closest('.ytm-quick-opt-btn')) {
            e.stopPropagation();
            openTrackMenu(t);
            return;
          }
          playTrack(t, null, false, false);
        };
        grid.appendChild(card);
      });
    }

    async function renderRecommendedMix() {
      const container = $('homeRecommendedGrid');
      const section = $('secRecommended');
      if (!container || !section) return;

      try {
        const history = await dbGetAll('history');
        const likes = await dbGetAll('likes');
        const poolMap = new Map();
        const now = Date.now();
        const oneWeekAgo = now - 7 * 86400000;

        history.forEach(t => {
          const playsThisWeek = (t.recentPlays || []).filter(ts => ts > oneWeekAgo).length;
          const score = playsThisWeek * 10 + (t.playCount || 1);
          poolMap.set(t.id, { ...t, weeklyScore: score });
        });
        likes.forEach(t => {
          if (!poolMap.has(t.id)) poolMap.set(t.id, { ...t, weeklyScore: 5 });
        });
        let pool = Array.from(poolMap.values());

        if (pool.length < 2 && window._homeData && window._homeData.trending) {
          pool = window._homeData.trending;
        }

        if (pool.length < 2) {
          section.style.display = 'none';
          return;
        }

        section.style.display = 'block';

        let selected = [...pool];
        selected.sort((a, b) => (b.weeklyScore || 0) - (a.weeklyScore || 0));
        selected = selected.slice(0, 10);

        container.innerHTML = '';
        selected.forEach(track => {
          const card = document.createElement('div');
          card.className = 'card';
          card.innerHTML = \`
            <div class="card-thumb-wrap">
              <img class="card-thumb" src="\${track.thumb}" loading="lazy" alt="Cover" onerror="this.src='https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg'">
              <div class="card-play-overlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
            </div>
            <div class="card-title">\${track.title}\${track.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
            <div class="card-artist">\${track.artist}</div>
          \`;
          card.onclick = () => playTrack(track, null, false, false);
          container.appendChild(card);
        });
      } catch (_) {
        section.style.display = 'none';
      }
    }

    function renderHomeTrending() {
      const container = $('homeTrendingGrid');
      if (!container || !window._homeData || !window._homeData.trending) return;
      const list = window._homeData.trending.slice(0, 16);
      container.innerHTML = '';
      list.forEach((track, idx) => {
        const rank = idx + 1;
        const rankClass = rank === 1 ? 'top-1' : (rank === 2 ? 'top-2' : (rank === 3 ? 'top-3' : ''));
        const card = document.createElement('div');
        card.className = 'ytm-quick-card';
        card.innerHTML = \`
          <div class="ytm-quick-thumb-box">
            <img class="ytm-quick-thumb" src="\${track.thumb}" loading="lazy" alt="Cover" onerror="this.src='https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg'">
            <div class="card-rank-badge \${rankClass}">#\${rank}</div>
            <div class="ytm-quick-play-btn" title="Reproducir">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </div>
          </div>
          <div class="ytm-quick-info">
            <div class="ytm-quick-title">\${track.title}\${track.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
            <div class="ytm-quick-artist">\${track.artist}</div>
          </div>
          <button class="ytm-quick-opt-btn" title="Más opciones">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        \`;
        card.onclick = (e) => {
          if (e.target.closest('.ytm-quick-opt-btn')) {
            e.stopPropagation();
            openTrackMenu(track);
            return;
          }
          playTrack(track, null, false, false);
        };
        container.appendChild(card);
      });
    }

    function renderExploreView() {
      const list = $('exploreTrendingList');
      if (!list || !window._homeData || !window._homeData.trending) return;
      list.innerHTML = '';
      const items = window._homeData.trending.slice(0, 20);
      items.forEach((track, idx) => {
        const rank = idx + 1;
        const rankClass = rank === 1 ? 'top-1' : (rank === 2 ? 'top-2' : (rank === 3 ? 'top-3' : ''));
        const card = document.createElement('div');
        card.className = 'ytm-quick-card';
        card.innerHTML = \`
          <div class="ytm-quick-thumb-box">
            <img class="ytm-quick-thumb" src="\${track.thumb}" loading="lazy" alt="Cover" onerror="this.src='https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg'">
            <div class="card-rank-badge \${rankClass}">#\${rank}</div>
            <div class="ytm-quick-play-btn" title="Reproducir">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </div>
          </div>
          <div class="ytm-quick-info">
            <div class="ytm-quick-title">\${track.title}\${track.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
            <div class="ytm-quick-artist">\${track.artist}</div>
          </div>
          <button class="ytm-quick-opt-btn" title="Más opciones">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        \`;
        card.onclick = (e) => {
          if (e.target.closest('.ytm-quick-opt-btn')) {
            e.stopPropagation();
            openTrackMenu(track);
            return;
          }
          playTrack(track, null, false, false);
        };
        list.appendChild(card);
      });
    }

    // --------------------------------------------------------
    // Initializer
    // --------------------------------------------------------
    function $(id) { return document.getElementById(id); }

    function prepareTrackInPlayer(track) {
      if (!track) return;
      currentTrack = track;
      if (pTitle) pTitle.textContent = track.title;
      if (pArtist) pArtist.textContent = track.artist;
      if (pCover) pCover.src = track.thumb || \`https://i.ytimg.com/vi/\${track.id}/hqdefault.jpg\`;
      const pBar = $('playerBar');
      if (pBar) pBar.classList.add('visible', 'active');
      const curEl = $('currentTime') || $('curTime');
      if (curEl) curEl.textContent = '0:00';
      const durEl = $('totalDuration') || $('durTime');
      if (durEl) durEl.textContent = (track.duration && track.duration > 0) ? formatDuration(track.duration) : '--:--';
      updatePlayIcons(false);
    }

    async function initApp() {
      // Explicitly stop any audio on startup/page reload (PREVENTS AUTOPLAY BUG!)
      if (audio) {
        try { audio.pause(); audio.currentTime = 0; } catch (_) {}
      }
      isPlaying = false;
      updatePlayIcons(false);

      applyLanguage(currentLang);
      loadLikesSet();

      // Close dropdowns on outside click
      document.addEventListener('click', (e) => {
        const lWrap = langDropdownWrap;
        if (lWrap && !lWrap.contains(e.target)) lWrap.classList.remove('open');
        const qWrap = qualityDropdownWrap;
        if (qWrap && !qWrap.contains(e.target)) qWrap.classList.remove('open');
      });

      // AURORA-MUSIC v2.3 — "Obtener la app": SOLO en navegadores.
      // La APK nativa inyecta window.AndroidBridge (addJavascriptInterface)
      // y marca el UA con AuroraMusicNativeApp -> ocultamos las entradas.
      const inNativeApp = () => {
        try {
          if (typeof window.AndroidBridge !== 'undefined' && !!window.AndroidBridge) return true;
          if (/AuroraMusicNativeApp/i.test(navigator.userAgent || '')) return true;
        } catch (_) {}
        return false;
      };
      try {
        if (!inNativeApp()) {
          const tabApp = $('tab-app'); if (tabApp) tabApp.style.display = '';
          const gas = $('getAppSection'); if (gas) gas.style.display = '';
        } else {
          const note = $('appInstalledNote'); if (note) note.style.display = 'flex';
          const cta = $('appDownloadCard'); if (cta) cta.style.display = 'none';
        }
        // iOS / escritorio: nota informativa (la app es solo para Android)
        const ua = navigator.userAgent || '';
        const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
        if (isIOS) {
          const other = $('appOtherPlatformNote'); if (other) other.style.display = 'flex';
        }
        // Cinturon y tirantes: re-chequeo tardio por si el puente llega tarde
        setTimeout(() => {
          try {
            if (inNativeApp()) {
              const tabApp = $('tab-app'); if (tabApp) tabApp.style.display = 'none';
              const gas = $('getAppSection'); if (gas) gas.style.display = 'none';
              const note = $('appInstalledNote'); if (note) note.style.display = 'flex';
              const cta = $('appDownloadCard'); if (cta) cta.style.display = 'none';
            }
          } catch (_) {}
        }, 1500);
      } catch (_) {}

      // Handle direct URL path routing (/terms, /legal, /app)
      const initialPath = window.location.pathname.toLowerCase();
      if (initialPath === '/terms' || initialPath === '/legal' || initialPath === '/dmca') {
        navigateToTerms();
      } else if (initialPath === '/app' || initialPath === '/get-app' || initialPath === '/download') {
        navigateToApp();
      }

      window.addEventListener('popstate', (e) => {
        const p = window.location.pathname;
        const v = (e.state && e.state.view) || (p.startsWith('/terms') ? 'terms' : (p.startsWith('/app') ? 'app' : 'home'));
        switchView(v);
      });

      // Search input listeners
      if (sInput) {
        sInput.addEventListener('focus', () => {
          if (sInput.value.trim().length === 0) {
            switchView('search');
          }
        });
        sInput.addEventListener('input', () => {
          const val = sInput.value.trim();
          const clearBtn = $('searchClear');
          if (clearBtn) clearBtn.style.display = val.length > 0 ? 'block' : 'none';
          if (val.length === 0) {
            const recentBox = $('searchRecentContainer');
            const resultsBox = $('searchResultsContainer');
            if (recentBox) recentBox.style.display = 'block';
            if (resultsBox) resultsBox.style.display = 'none';
          }
        });
        sInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            executeSearch(sInput.value);
          }
        });
      }

      const sClear = $('searchClear');
      if (sClear) {
        sClear.onclick = () => {
          if (sInput) {
            sInput.value = '';
            sInput.focus();
          }
          sClear.style.display = 'none';
          const recentBox = $('searchRecentContainer');
          const resultsBox = $('searchResultsContainer');
          if (recentBox) recentBox.style.display = 'block';
          if (resultsBox) resultsBox.style.display = 'none';
        };
      }

      // Fetch curated home feed from backend
      try {
        const res = await fetch('/api/home');
        if (res.ok) {
          const data = await res.json();
          window._homeData = data;
          try { if (window.__auroraOffline) window.__auroraOffline.setDataReady(); } catch (_) {}
          renderChips();
          renderQuickPicks();
          renderRecommendedMix();
          renderHomeTrending();

          // Render Ultra HQ Grid (4 and 4 side-by-side)
          const grid = $('homeGrid');
          if (grid && data.featured) {
            grid.innerHTML = '';
            data.featured.slice(0, 16).forEach(t => {
              const card = document.createElement('div');
              card.className = 'ytm-quick-card';
              card.innerHTML = \`
                <div class="ytm-quick-thumb-box">
                  <img class="ytm-quick-thumb" src="\${t.thumb}" loading="lazy" alt="Cover" onerror="this.src='https://i.ytimg.com/vi/\${t.id}/hqdefault.jpg'">
                  <div class="ytm-quick-play-btn" title="Reproducir">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                  </div>
                </div>
                <div class="ytm-quick-info">
                  <div class="ytm-quick-title">\${t.title}\${t.r2Ready ? '<span class="r2-badge">HQ R2</span>' : ''}</div>
                  <div class="ytm-quick-artist">\${t.artist}</div>
                </div>
                <button class="ytm-quick-opt-btn" title="Más opciones">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
              \`;
              card.onclick = (e) => {
                if (e.target.closest('.ytm-quick-opt-btn')) {
                  e.stopPropagation();
                  openTrackMenu(t);
                  return;
                }
                playTrack(t, null, false, false);
              };
              grid.appendChild(card);
            });
          }
        }
      } catch (err) {
        console.warn('Failed to load home feed:', err);
        try { if (window.__auroraOffline) window.__auroraOffline.reportNetFail(); } catch (_) {}
      }

      // Strict background scroll prevention on mobile touch for modals
      const sModalEl = $('settingsModal');
      if (sModalEl) {
        sModalEl.addEventListener('touchmove', (e) => {
          if (e.target === sModalEl) e.preventDefault();
        }, { passive: false });
      }

      // Check URL query parameters (?v=...)
      const urlParams = new URLSearchParams(window.location.search);
      const vid = urlParams.get('v');
      if (vid && vid.length === 11) {
        // Load into player in PAUSED state (DO NOT AUTOPLAY!)
        prepareTrackInPlayer({ id: vid, title: 'Canci\u00f3n', artist: 'YouTube Music', thumb: \`https://i.ytimg.com/vi/\${vid}/hqdefault.jpg\`, duration: 210 });
        try { window.history.replaceState({}, '', window.location.pathname); } catch (_) {}
      }
    }

        if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initApp);
    } else {
      initApp();
    }
  </script>`;
