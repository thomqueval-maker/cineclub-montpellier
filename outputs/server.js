"use strict";

// Local server for live Pathé schedules and best-effort AlloCiné metadata.
// Uses Node's built-in modules only.
const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const ROOT = __dirname;
const PATHE = "https://www.pathe.fr/api";
const BOOKING_SUFFIX = "/booking?pos=c2VhdGluZw%3D%3D";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
  "Referer": "https://www.pathe.fr/"
};
const CINEMAS = {
  odysseum: { terms: ["odysseum", "pathe odysseum"], fallbacks: ["pathe-odysseum", "cinema-pathe-odysseum"], name: "Pathé Odysseum" },
  comedie: { terms: ["comedie", "pathe comedie"], fallbacks: ["pathe-comedie", "cinema-pathe-comedie"], name: "Pathé Comédie" }
};
const cache = new Map();

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/œ/gi, "oe").replace(/æ/gi, "ae").toLowerCase().replace(/\s+/g, " ").trim();
}
function localISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function withCache(key, ttlMs, build) {
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.value;
  const pending = Promise.resolve().then(build).then(value => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }).catch(error => { cache.delete(key); throw error; });
  cache.set(key, { value: pending, expires: Date.now() + ttlMs });
  return pending;
}
async function fetchText(url, accept = "application/json, text/plain, */*;q=0.8") {
  const referer = new URL(url).hostname.includes("allocine") ? "https://www.allocine.fr/" : "https://www.pathe.fr/";
  const response = await fetch(url, { headers: { ...HEADERS, Referer: referer, Accept: accept }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} depuis ${new URL(url).hostname}`);
  return response.text();
}
async function pathJson(path) {
  return JSON.parse(await fetchText(PATHE + path));
}
function items(payload, key) {
  const value = Array.isArray(payload) ? payload : (payload?.[key] ?? payload?.data ?? payload);
  return Array.isArray(value) ? value : (value && typeof value === "object" ? Object.values(value) : []);
}
async function cinemaSlug(index, key) {
  for (const cinema of items(index, "cinemas")) {
    if (!cinema || typeof cinema !== "object") continue;
    const fields = [cinema.name, cinema.slug, cinema.city, cinema.address, cinema.citySlug].join(" ");
    const normalized = normalize(fields);
    if (normalized.includes("montpellier") && CINEMAS[key].terms.some(term => normalized.includes(normalize(term)))) {
      const slug = cinema.slug || cinema.id;
      if (slug) return String(slug);
    }
  }
  const candidates = await Promise.all(CINEMAS[key].fallbacks.map(async candidate => {
    try { await pathJson(`/cinema/${encodeURIComponent(candidate)}/shows`); return candidate; }
    catch { return null; }
  }));
  if (candidates.find(Boolean)) return candidates.find(Boolean);
  throw new Error(`Impossible de trouver ${CINEMAS[key].name} dans le catalogue Pathé.`);
}
function posterUrl(show) {
  let value = show?.poster || show?.posterPath || show?.posterUrl || show?.image || show?.cover;
  if (value && typeof value === "object") value = value.lg || value.large || value.url || value.src || value.md || value.path;
  if (typeof value !== "string" || !value.trim()) return null;
  value = value.trim();
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://media.pathe.fr${value}`;
  return value.startsWith("https://") ? value : null;
}
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(item => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const found = item.label || item.name || item.title || item.code || item.value;
      return found ? [String(found)] : [];
    }
    return [];
  });
  if (value && typeof value === "object") return Object.values(value).filter(x => ["string", "number"].includes(typeof x)).map(String);
  return [];
}
function sessionFormat(showtime) {
  const labels = [...strings(showtime.tags), ...strings(showtime.format), ...strings(showtime.auditoriumName), ...strings(showtime.room)].join(" ");
  const value = normalize(labels);
  if (value.includes("70mm") || value.includes("70 mm")) return "IMAX 70 mm";
  if (value.includes("4dx")) return value.includes("3d") ? "4DX 3D" : "4DX";
  if (value.includes("imax")) return value.includes("3d") ? "IMAX 3D" : "IMAX";
  if (value.includes("3d")) return "3D";
  for (const label of strings(showtime.tags)) if (["vip", "dolby", "screenx"].includes(normalize(label))) return label.toUpperCase();
  return "Classique";
}
function sessionVersion(showtime) {
  const value = [...strings(showtime.language), ...strings(showtime.version), ...strings(showtime.tags)].join(" ").toUpperCase();
  for (const version of ["VOSTFR", "VOST", "VFST", "VO", "VF"]) if (value.includes(version)) return version;
  return "VF";
}
function bookingUrl(showtime) {
  const direct = showtime.bookingUrl || showtime.booking_url || showtime.url;
  if (typeof direct === "string" && direct.startsWith("https://") && new URL(direct).hostname.includes("pathe")) return direct;
  const ref = showtime.refCmd || showtime.bookingRef || showtime.reference;
  if (!ref) return null;
  const value = String(ref).trim();
  if (value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `https://s.pathe.fr${value}`;
  return `https://s.pathe.fr/fr/${encodeURIComponent(value)}${BOOKING_SUFFIX}`;
}
function showtimeRecords(payload) {
  if (!payload || typeof payload !== "object") return [];
  const result = [];
  for (const [day, entries] of Object.entries(payload)) {
    if (Array.isArray(entries)) for (const entry of entries) if (entry && typeof entry === "object") result.push([day, entry]);
  }
  return result;
}
function showtimeTime(showtime) {
  const values = [showtime.time, showtime.startsAt, showtime.startTime, showtime.dateTime, showtime.datetime, showtime.start];
  for (const entry of values) {
    const value = entry && typeof entry === "object" ? (entry.dateTime || entry.datetime || entry.time || entry.value || entry.start) : entry;
    if (typeof value === "number" && value > 1000000000) {
      const milliseconds = value > 100000000000 ? value : value * 1000;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    }
    if (typeof value !== "string") continue;
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    }
    const match = value.match(/(?:^|[T\s])(\d{1,2}):([0-5]\d)(?::[0-5]\d)?/);
    if (!match) continue;
    const hour = Number(match[1]);
    if (hour < 24) return `${String(hour).padStart(2,"0")}:${match[2]}`;
  }
  return null;
}
function showtimeEndTime(showtime) {
  return showtimeTime({
    time: showtime.endTime || showtime.end_time || showtime.endsAt || showtime.endAt || showtime.end || showtime.finishTime || showtime.finishAt || showtime.endDatetime || showtime.endDateTime,
    startsAt: showtime.endsAt || showtime.endDatetime || showtime.endDateTime,
    startTime: showtime.endTime || showtime.end_time || showtime.finishTime || showtime.finishAt
  });
}
function allocineId(detail) {
  const value = detail.allocineId || detail.allocine_id || detail.externalIds?.allocine || detail.externalIds?.allocineId || detail.externals?.allocine;
  const match = String(value || "").match(/\d{4,}/);
  return match ? match[0] : null;
}
async function mapLimit(values, concurrency, fn) {
  const out = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await fn(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return out;
}
async function refreshShowtimes(from, to) {
  const index = await pathJson("/cinemas");
  const resolved = await Promise.all(Object.keys(CINEMAS).map(async key => [key, await cinemaSlug(index, key)]));
  const cinemaSlugs = Object.fromEntries(resolved);
  const programEntries = await Promise.all(Object.entries(cinemaSlugs).map(async ([key, slug]) => [key, await pathJson(`/cinema/${encodeURIComponent(slug)}/shows`)]));
  const catalogue = await pathJson("/shows");
  const details = new Map();
  for (const show of items(catalogue, "shows")) if (show?.slug) details.set(String(show.slug), show);
  const jobs = [];
  for (const [key, program] of programEntries) {
    const shows = program?.shows || {};
    const slugs = Array.isArray(shows) ? shows.map(show => show?.slug).filter(Boolean) : Object.keys(shows);
    for (const slug of slugs) jobs.push({ key, slug: String(slug) });
  }
  const results = await mapLimit(jobs, 12, async job => {
    try {
      const data = await pathJson(`/show/${encodeURIComponent(job.slug)}/showtimes/${encodeURIComponent(cinemaSlugs[job.key])}`);
      return { ...job, records: showtimeRecords(data) };
    } catch {
      return { ...job, records: [] };
    }
  });
  const needed = [...new Set(results.filter(item => item.records.some(([day]) => day >= from && day <= to) && !details.has(item.slug)).map(item => item.slug))];
  const fetchedDetails = await mapLimit(needed, 8, async slug => {
    try { return [slug, await pathJson(`/show/${encodeURIComponent(slug)}`)]; }
    catch { return [slug, {}]; }
  });
  for (const [slug, detail] of fetchedDetails) details.set(slug, detail);

  const sessions = [];
  for (const item of results) {
    const detail = details.get(item.slug) || {};
    const title = String(detail.title || detail.name || item.slug.replace(/-/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()));
    let duration = detail.durationMin || detail.duration || detail.runtime || null;
    if (duration && typeof duration === "object") duration = duration.minutes || duration.value || null;
    for (const [day, showtime] of item.records) {
      if (day < from || day > to) continue;
      const time = showtimeTime(showtime);
      if (!time) continue;
      const booking = bookingUrl(showtime);
      sessions.push({
        id: String(showtime.id || showtime.refCmd || `${item.slug}-${day}-${time}-${item.key}`),
        date: day, time, cinemaKey: item.key, cinemaName: CINEMAS[item.key].name,
        title, showSlug: item.slug, format: sessionFormat(showtime), version: sessionVersion(showtime),
        room: String(showtime.auditoriumName || showtime.room || ""), bookingUrl: booking,
        bookable: Boolean(showtime.isBookable ?? showtime.bookable ?? true) && Boolean(booking),
        posterUrl: posterUrl(detail), duration, synopsis: detail.synopsis || detail.description || "",
        genres: strings(detail.genres || detail.genre), allocineId: allocineId(detail),
        endTime: showtimeEndTime(showtime)
      });
    }
  }
  sessions.sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title, "fr") || a.cinemaKey.localeCompare(b.cinemaKey));
  return {
    sessions,
    cinemas: Object.fromEntries(Object.entries(cinemaSlugs).map(([key, slug]) => [key, { slug, name: CINEMAS[key].name }])),
    from, to, updatedAt: new Date().toISOString(), source: "Pathé"
  };
}
function liveShowtimes(from, to) { return withCache(`showtimes:${from}:${to}`, 8 * 60 * 1000, () => refreshShowtimes(from, to)); }

function decodeEntities(value) {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function stripHtml(value) { return decodeEntities(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function metaContent(page, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>|<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i");
  const match = page.match(pattern);
  return match ? decodeEntities(match[1] || match[2]) : null;
}
function allocineSearchLinks(page, title) {
  const links = [];
  const pattern = /<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(page))) {
    const href = decodeEntities(match[2]);
    if (!href.includes("/film/fichefilm")) continue;
    const attrs = match[0].slice(0, match[0].indexOf(">"));
    const titleAttr = attrs.match(/\btitle=(['"])(.*?)\1/i)?.[2] || "";
    const ariaLabel = attrs.match(/\baria-label=(['"])(.*?)\1/i)?.[2] || "";
    const imageAlt = match[3].match(/\balt=(['"])(.*?)\1/i)?.[2] || "";
    const label = [stripHtml(match[3]), titleAttr, ariaLabel, imageAlt].map(decodeEntities).join(" ");
    const score = SequenceScore(title, label);
    const absolute = href.startsWith("http") ? href : new URL(href, "https://www.allocine.fr").href;
    links.push({ score, url: absolute });
  }
  return links.sort((a,b) => b.score - a.score);
}
function SequenceScore(left, right) {
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return Math.min(a.length,b.length) / Math.max(a.length,b.length);
  const aa = a.split(" "), bb = b.split(" ");
  const overlap = aa.filter(word => bb.includes(word)).length;
  return overlap / Math.max(aa.length,bb.length);
}
function parseAllocineRating(page) {
  const text = stripHtml(page);
  const label = /(?:spectateurs?|note\s+des\s+spectateurs|note\s+spectateurs)/ig;
  let match;
  while ((match = label.exec(text))) {
    const segment = text.slice(match.index, match.index + 240);
    const scoreMatch = segment.match(/(?:^|\D)([0-5](?:[,.]\d)?)\s*(?:\/\s*5)?/);
    if (!scoreMatch) continue;
    const rating = Number(scoreMatch[1].replace(",", "."));
    if (rating > 5) continue;
    const scoreEnd = scoreMatch.index + scoreMatch[0].length;
    const afterScore = segment.slice(scoreEnd);
    const countMatch = afterScore.match(/([\d\s\u202f,.]+)\s*(?:notes?|avis)/i);
    const digits = countMatch ? countMatch[1].replace(/\D/g, "") : "";
    return { rating, votes: digits ? Number(digits) : null };
  }
  // AlloCiné rend parfois la note dans les données structurées plutôt que dans le texte visible.
  // On ne s'en sert que si la page mentionne bien la note des spectateurs.
  if (/spectateurs?/i.test(text)) {
    const scripts = page.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    const findRating = value => {
      if (Array.isArray(value)) {
        for (const entry of value) { const found = findRating(entry); if (found) return found; }
      } else if (value && typeof value === "object") {
        const aggregate = value.aggregateRating;
        if (aggregate && typeof aggregate === "object") {
          const rating = Number(String(aggregate.ratingValue || "").replace(",", "."));
          if (Number.isFinite(rating) && rating >= 0 && rating <= 5) {
            const votes = Number(aggregate.ratingCount || aggregate.reviewCount || 0);
            return { rating, votes: votes > 0 ? votes : null };
          }
        }
        for (const child of Object.values(value)) { const found = findRating(child); if (found) return found; }
      }
      return null;
    };
    for (const script of scripts) {
      try {
        const found = findRating(JSON.parse(script[1]));
        if (found) return found;
      } catch { /* Ignore invalid or partial structured data. */ }
    }
  }
  return { rating: null, votes: null };
}
function parseFilmDuration(page) {
  const parseIso = value => {
    const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (!match) return null;
    const minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
    return minutes > 0 && minutes <= 600 ? minutes : null;
  };
  const meta = page.match(/<meta\b(?=[^>]*\bitemprop=["']duration["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i)
    || page.match(/<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])(?=[^>]*\bitemprop=["']duration["'])[^>]*>/i);
  if (meta) {
    const content = meta[1] || meta[2];
    const minutes = parseIso(content);
    if (minutes) return minutes;
  }
  const scripts = page.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const findDuration = value => {
    if (Array.isArray(value)) {
      for (const entry of value) { const found = findDuration(entry); if (found) return found; }
    } else if (value && typeof value === "object") {
      const minutes = parseIso(value.duration);
      if (minutes) return minutes;
      for (const child of Object.values(value)) { const found = findDuration(child); if (found) return found; }
    }
    return null;
  };
  for (const script of scripts) {
    try { const found = findDuration(JSON.parse(script[1])); if (found) return found; }
    catch { /* Ignore invalid or partial structured data. */ }
  }
  const text = stripHtml(page);
  const match = text.match(/(?:durée|duration)\s*[:·]?\s*(\d+\s*h(?:\s*\d+\s*(?:min|m))?|\d+\s*min)/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  const hours = value.match(/(\d+)\s*h/);
  const mins = value.match(/(\d+)\s*(?:min|m)/);
  const total = Number(hours?.[1] || 0) * 60 + Number(mins?.[1] || 0);
  return total > 0 && total <= 600 ? total : null;
}
async function allocineLookup(title, knownId = null) {
  const queryUrl = `https://www.allocine.fr/rechercher/?${new URLSearchParams({ q: title })}`;
  const fallback = { rating: null, votes: null, duration: null, url: queryUrl, posterUrl: null };
  try {
    let movieUrl = knownId ? `https://www.allocine.fr/film/fichefilm_gen_cfilm=${encodeURIComponent(knownId)}.html` : null;
    if (!movieUrl) {
      const search = await fetchText(queryUrl, "text/html,application/xhtml+xml,*/*;q=0.8");
      const candidate = allocineSearchLinks(search, title)[0];
      if (!candidate || candidate.score < 0.45) return fallback;
      movieUrl = candidate.url;
    }
    let page;
    try {
      page = await fetchText(movieUrl, "text/html,application/xhtml+xml,*/*;q=0.8");
    } catch (error) {
      if (!knownId) throw error;
      const search = await fetchText(queryUrl, "text/html,application/xhtml+xml,*/*;q=0.8");
      const candidate = allocineSearchLinks(search, title)[0];
      if (!candidate || candidate.score < 0.45) return fallback;
      movieUrl = candidate.url;
      page = await fetchText(movieUrl, "text/html,application/xhtml+xml,*/*;q=0.8");
    }
    const { rating, votes } = parseAllocineRating(page);
    return { rating, votes, duration: parseFilmDuration(page), url: movieUrl, posterUrl: metaContent(page, "og:image") || metaContent(page, "twitter:image") };
  } catch {
    return fallback;
  }
}
function allocine(title, id = null) {
  const key = `allocine:${normalize(title)}:${id || ""}`;
  return withCache(key, 60 * 60 * 1000, () => allocineLookup(title, id));
}

function send(response, status, body, type) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}
function json(response, status, body) { send(response, status, JSON.stringify(body), "application/json; charset=utf-8"); }
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try { send(response, 200, require("node:fs").readFileSync(`${ROOT}/cine-zen.html`), "text/html; charset=utf-8"); }
    catch { json(response, 404, { error: "cine-zen.html introuvable" }); }
    return;
  }
  if (url.pathname === "/app.js") {
    try { send(response, 200, require("node:fs").readFileSync(`${ROOT}/app.js`), "text/javascript; charset=utf-8"); }
    catch { json(response, 404, { error: "app.js introuvable" }); }
    return;
  }
  if (url.pathname === "/api/showtimes") {
    const today = new Date();
    const from = url.searchParams.get("from") || localISO(today);
    const parsedFrom = new Date(`${from}T12:00:00`);
    const to = url.searchParams.get("to") || localISO(new Date(parsedFrom.getTime() + 6 * 86400000));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || new Date(`${to}T12:00:00`) < parsedFrom || (new Date(`${to}T12:00:00`) - parsedFrom) / 86400000 > 13) {
      json(response, 400, { error: "La période doit faire entre 1 et 14 jours." });
      return;
    }
    try { json(response, 200, url.searchParams.get("refresh") === "1" ? await refreshShowtimes(from, to) : await liveShowtimes(from, to)); }
    catch (error) { json(response, 502, { error: error.message || "Le programme Pathé est inaccessible.", source: "Pathé" }); }
    return;
  }
  if (url.pathname === "/api/allocine") {
    const title = (url.searchParams.get("title") || "").trim().slice(0, 120);
    if (!title) { json(response, 400, { error: "Titre manquant" }); return; }
    const id = (url.searchParams.get("id") || "").match(/\d{4,}/)?.[0] || null;
    json(response, 200, await allocine(title, id));
    return;
  }
  json(response, 404, { error: "Introuvable" });
});

server.listen(PORT, HOST, () => {
  if (process.env.RENDER) {
    console.log(`Cinéclub écoute sur ${HOST}:${PORT}`);
    return;
  }
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`Cinéclub est prêt : ${address}`);
  console.log("Garde cette fenêtre ouverte pendant l'utilisation. Ctrl+C pour arrêter.");
  import("node:child_process").then(({ exec }) => {
    const command = process.platform === "win32" ? `start "" "${address}"` : process.platform === "darwin" ? `open "${address}"` : `xdg-open "${address}"`;
    exec(command, () => {});
  }).catch(() => {});
});

