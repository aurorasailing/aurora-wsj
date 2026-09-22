// Aurora WSJ Wind · Cloudflare Worker · v1.0 · 2026-09-22
// Marina Błotnik / Martwa Wisła edition — for the 26th World Scout Jamboree (Poland 2027).
// Same job as the Lakes Worker: fetch each source, normalise to ONE JSON shape, cache ~1 min,
// add CORS. The pages never see a raw feed. Everything is in knots + compass strings.
//
// Routes (one JSON shape for all):
//   /blotnik.json   Marina Błotnik — Open-Meteo model wind at the marina point (+ 24h history)
//   /gdansk.json    Gdańsk           ┐
//   /hel.json       Hel              ├ IMGW-PIB synop (public JSON, hourly, one current reading)
//   /elblag.json    Elbląg           │
//   /platforma.json Baltic Platform  ┘ (offshore)
//   /gorki.json     Górki Zachodnie (NCŻ) — Holfuy #1441, scraped LIVE from the public widget.
//
// Output row shape (newest first):
//   { wind_spd_kt, gust_kt, wind_dir, wind_dir_deg, air_temp, local_date_time_full, name }
//   local_date_time_full = YYYYMMDDHHMMSS in Poland's wall-clock (Europe/Warsaw).
//
// ── FIRST-DEPLOY TUNING (the Polish feeds can't be reached from the build sandbox) ──────────
//  1. IMGW_WIND_UNIT — synop wind is m/s (confirmed against the live feed); leave as "ms".
//  2. IMGW_STATION ids are real synop ids from the live feed (Gdańsk 12155, Hel 12135, Elbląg
//     12160, Baltic Platform 12001). Świbno and Gdynia are NOT synop stations. Swap an id for
//     another coastal one if wanted — e.g. Łeba 12120, Ustka 12115, Świnoujście 12200.
//  3. Górki Zachodnie is read from the public Holfuy widget (no key). The parser was checked
//     against a real widget payload; if Holfuy ever changes the widget markup, either fix the
//     regexes in gorkiWidget() or drop a key into HOLFUY_KEY to use the keyed API fallback.
// ────────────────────────────────────────────────────────────────────────────────────────────

const MARINA = { lat: 54.276, lon: 18.875, name: "Marina Błotnik" };   // Open-Meteo point

// IMGW-PIB public synop, fetched per station by id (small, unambiguous; ids are from the live
// feed). NOTE: Świbno and Gdynia are NOT synop stations — the coastal backbone is the four real
// ones ringing the bay: Gdańsk (inner), Hel (peninsula), Elbląg (SE), and the offshore Baltic
// Platform. The feed's `godzina_pomiaru` is UTC and is converted to Warsaw wall-clock below.
const IMGW_BASE = "https://danepubliczne.imgw.pl/api/data/synop";
const IMGW_WIND_UNIT = "ms";   // synop wind is m/s → knots (kept as a switch just in case)

const IMGW_STATION = {
  gdansk:    { id: "12155", name: "Gdańsk" },
  hel:       { id: "12135", name: "Hel" },
  elblag:    { id: "12160", name: "Elbląg" },
  platforma: { id: "12001", name: "Baltic Platform" },
};

// Holfuy on-water station at Górki Zachodnie (NCŻ). Read live from the PUBLIC widget page —
// the current reading is server-rendered straight into its HTML, so NO API KEY is needed and the
// station is live from day one. Attribution required (the pages name Holfuy and link station #1441).
// The keyed live API is kept only as an optional fallback (set HOLFUY_KEY to enable it).
const HOLFUY_ID     = 1441;
const HOLFUY_NAME   = "Górki Zachodnie (NCŻ)";
const HOLFUY_WIDGET = "https://widget.holfuy.com/?station=" + HOLFUY_ID + "&su=knots&t=C&lang=en&mode=detailed";
const HOLFUY_KEY    = "";          // optional: set to allow the keyed api.holfuy.com fallback

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=60",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    const id = (path.match(/\/([a-z]+)\.json$/i) || [])[1];

    try {
      if (id === "blotnik")            return json(await openMeteo(), 200, cors);
      if (id in IMGW_STATION)          return json(await imgw(id), 200, cors);
      if (id === "gorki")              return json(await gorki(), 200, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
    return json({ error: "use /{station}.json", stations: ["blotnik", ...Object.keys(IMGW_STATION), "gorki"] }, 404, cors);
  }
};

// ── Open-Meteo: Marina Błotnik ───────────────────────────────────────────────────────────────
// Ask for knots directly (wind_speed_unit=kn), so there's nothing to convert. `current` gives the
// live point; `hourly` with past_days=1 gives a real 24-hour trail for the graph.
async function openMeteo() {
  const u = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + MARINA.lat + "&longitude=" + MARINA.lon
    + "&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m"
    + "&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m"
    + "&wind_speed_unit=kn&past_days=1&forecast_days=1&timezone=Europe%2FWarsaw";
  const r = await fetch(u, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const j = await r.json();
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;
  const rows = [];

  // hourly trail, oldest→newest in the payload; keep hours up to "now", then reverse to newest-first
  const H = j.hourly || {};
  const times = H.time || [];
  const nowStamp = stampFromISO(warsawISO(new Date()));
  for (let i = 0; i < times.length; i++) {
    const st = stampFromISO(times[i]);
    if (st > nowStamp) continue;                         // don't show the forecast half
    const deg = num(H.wind_direction_10m && H.wind_direction_10m[i]);
    rows.push({
      wind_spd_kt: r1(num(H.wind_speed_10m && H.wind_speed_10m[i])),
      gust_kt:     r1(num(H.wind_gusts_10m && H.wind_gusts_10m[i])),
      wind_dir:    deg == null ? null : degToCardinal(deg),
      wind_dir_deg: deg == null ? null : Math.round(deg),
      air_temp:    r1(num(H.temperature_2m && H.temperature_2m[i])),
      local_date_time_full: st,
      name: MARINA.name,
    });
  }
  rows.reverse();                                         // newest first

  // current reading on top if it's newer than the last hourly row
  const C = j.current;
  if (C) {
    const deg = num(C.wind_direction_10m);
    const cur = {
      wind_spd_kt: r1(num(C.wind_speed_10m)),
      gust_kt:     r1(num(C.wind_gusts_10m)),
      wind_dir:    deg == null ? null : degToCardinal(deg),
      wind_dir_deg: deg == null ? null : Math.round(deg),
      air_temp:    r1(num(C.temperature_2m)),
      local_date_time_full: stampFromISO(C.time) || nowStamp,
      name: MARINA.name,
    };
    if (!rows.length || cur.local_date_time_full > rows[0].local_date_time_full) rows.unshift(cur);
  }

  if (!rows.length) throw new Error("open-meteo empty");
  return { observations: { data: rows } };
}

// ── IMGW-PIB synop: the coastal backbone ─────────────────────────────────────────────────────
// One current reading per station (hourly, no history) → a single-row series; the pages show it
// as a live reading with no 24h graph. The feed's hour is UTC, converted to Warsaw wall-clock here.
async function imgw(id) {
  const cfg = IMGW_STATION[id];
  const r = await fetch(IMGW_BASE + "/id/" + cfg.id, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!r.ok) throw new Error("imgw " + r.status);
  const j = await r.json();
  const hit = Array.isArray(j) ? j[0] : j;
  if (!hit || (hit.predkosc_wiatru == null && hit.temperatura == null)) throw new Error("imgw: empty for " + id);

  const deg = num(hit.kierunek_wiatru);
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;

  // feed hour is UTC → build the reading's time in Poland's wall-clock
  const Y = String(hit.data_pomiaru || "").slice(0, 4);
  const M = String(hit.data_pomiaru || "").slice(5, 7);
  const D = String(hit.data_pomiaru || "").slice(8, 10);
  const hh = num(hit.godzina_pomiaru);
  const stamp = (Y && hh != null)
    ? stampFromISO(warsawISO(new Date(Date.UTC(+Y, +M - 1, +D, hh, 0, 0))))
    : stampFromISO(warsawISO(new Date()));

  return { observations: { data: [{
    wind_spd_kt: r1(toKt(num(hit.predkosc_wiatru), IMGW_WIND_UNIT)),
    gust_kt: null,                                        // synop carries no gust
    wind_dir: deg == null ? null : degToCardinal(deg),
    wind_dir_deg: deg == null ? null : Math.round(deg),
    air_temp: r1(num(hit.temperatura)),
    local_date_time_full: stamp,
    name: hit.stacja || cfg.name,
  }] } };
}

// ── Holfuy #1441 (Górki Zachodnie / NCŻ) — the on-water venue reading ─────────────────────────
// Primary: scrape the public widget HTML (no key). Fallback: the keyed live API, if HOLFUY_KEY set.
async function gorki() {
  try { return await gorkiWidget(); }
  catch (e) { if (HOLFUY_KEY) return await holfuy(); throw e; }
}

// The widget server-renders the current reading into named spans: #j_speed, #j_gust, #j_dir,
// #j_temperature, plus a newWind(dir°,…,'HH:MM') call. Unit of the speed spans is read from the
// page's own `units` JSON, so this stays correct even if the widget is set to km/h or m/s.
async function gorkiWidget() {
  const r = await fetch(HOLFUY_WIDGET, { headers: { "User-Agent": UA, Accept: "text/html" },
                                         cf: { cacheTtl: 240, cacheEverything: true } });
  if (!r.ok) throw new Error("holfuy widget " + r.status);
  const html = await r.text();
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };

  let unit = "knots";
  const um = html.match(/units\s*=\s*JSON\.parse\('([^']+)'\)/);
  if (um) { try { unit = (JSON.parse(um[1]).speed) || "knots"; } catch (_) {} }

  const spd  = num(pick(/id="j_speed"\s*>\s*([\d.]+)/));
  const gst  = num(pick(/id="j_gust"[^>]*>\s*([\d.]+)/));
  let   deg  = num(pick(/newWind\(\s*(-?\d+(?:\.\d+)?)/));            // degrees — most reliable
  if (deg == null) deg = num(pick(/class="act_dir"[^>]*title="\s*(\d+)/));
  const card = pick(/id="j_dir"\s*>\s*([NSEW]{1,3})/);               // cardinal fallback
  const temp = num(pick(/id="j_temperature"[^>]*>\s*([\d.\-]+)/));
  const hhmm = pick(/newWind\([^)]*'(\d{1,2}:\d{2})'/);
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;

  const dir = deg != null ? degToCardinal(deg) : (card || null);
  const row = {
    wind_spd_kt: r1(holfuyToKt(spd, unit)),
    gust_kt:     r1(holfuyToKt(gst, unit)),
    wind_dir: dir,
    wind_dir_deg: deg != null ? Math.round(deg) : null,
    air_temp: r1(temp),
    local_date_time_full: stampFromClock(hhmm) || stampFromISO(warsawISO(new Date())),
    name: HOLFUY_NAME,
  };
  if (row.wind_spd_kt == null && row.air_temp == null) throw new Error("holfuy widget: no data");
  return { observations: { data: [row] } };
}

// Optional keyed live API — only used as a fallback when HOLFUY_KEY is set and the widget fails.
async function holfuy() {
  const u = "https://api.holfuy.com/live/?s=" + HOLFUY_ID + "&pw=" + encodeURIComponent(HOLFUY_KEY)
    + "&m=JSON&tu=C&su=knots";
  const r = await fetch(u, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error("holfuy api " + r.status);
  const j = await r.json();
  const w = j.wind || {};
  const deg = num(w.direction);
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;
  const row = {
    wind_spd_kt: r1(num(w.speed)),                       // su=knots → already knots
    gust_kt: r1(num(w.gust)),
    wind_dir: deg == null ? null : degToCardinal(deg),
    wind_dir_deg: deg == null ? null : Math.round(deg),
    air_temp: r1(num(j.temperature)),
    local_date_time_full: stampFromDateTime(j.dateTime) || stampFromISO(warsawISO(new Date())),
    name: j.stationName || HOLFUY_NAME,
  };
  if (row.wind_spd_kt == null && row.air_temp == null) throw new Error("holfuy api empty");
  return { observations: { data: [row] } };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────
function num(v) { return (v == null || v === "" || !isFinite(parseFloat(v))) ? null : parseFloat(v); }

// strip accents / case, for forgiving IMGW name matching
function fold(s) { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }

function toKt(v, unit) {
  if (v == null) return null;
  return unit === "kmh" ? v / 1.852 : v * 1.94384;       // "ms" default
}

// Holfuy widget speed spans → knots, using the unit string the widget declares.
function holfuyToKt(v, unit) {
  if (v == null) return null;
  unit = String(unit || "knots").toLowerCase();
  if (unit.startsWith("kn")) return v;                   // knots
  if (unit.startsWith("km")) return v / 1.852;           // km/h
  if (unit === "m/s" || unit === "ms") return v * 1.94384;
  if (unit.startsWith("mph") || unit.startsWith("mi")) return v * 0.868976;
  return v;
}

// "09:31" (station wall-clock, Europe/Warsaw) → today's stamp; null if it looks like it rolled
// past midnight (caller then falls back to 'now'), which keeps us clear of month/day underflow.
function stampFromClock(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const iso = warsawISO(new Date());
  const nowMin = (+iso.slice(11, 13)) * 60 + (+iso.slice(14, 16));
  const obsMin = (+m[1]) * 60 + (+m[2]);
  if (obsMin - nowMin > 90) return null;                 // clock ahead of now → rolled past midnight
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + String(+m[1]).padStart(2, "0") + m[2] + "00";
}

function degToCardinal(deg) {
  const pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// "2026-09-22T14:00" (or with seconds) → "20260922140000"
function stampFromISO(iso) {
  if (!iso) return null;
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? m[1] + m[2] + m[3] + m[4] + m[5] + (m[6] || "00") : null;
}
// "2026-09-22 14:00:00" → "20260922140000"
function stampFromDateTime(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? m[1] + m[2] + m[3] + m[4] + m[5] + (m[6] || "00") : null;
}
// Poland wall-clock now, as an ISO-ish string we can stamp
function warsawISO(d) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d || new Date())) p[part.type] = part.value;
  return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
