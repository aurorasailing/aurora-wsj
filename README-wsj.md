# Aurora WSJ Wind — deploy & tuning

Live wind for the Jamboree river-sailing at Marina Błotnik, Martwa Wisła
(26th World Scout Jamboree, Poland 2027). Same shape as Aurora Lake Winds:
one Cloudflare Worker for data, static pages that read it.

## Files
- `aurora-wsj-worker.js` — the Worker. Six routes, all normalised to one JSON shape:
  - `/blotnik.json` — Open-Meteo model wind at the marina point (+ ~24h history)
  - `/gdansk.json` `/hel.json` `/elblag.json` `/platforma.json` — IMGW-PIB synop (hourly, one reading)
  - `/gorki.json` — Górki Zachodnie (NCŻ), scraped live from the public Holfuy #1441 widget
- `index.html` — board (all six stations)
- `wsj-map.html` — river map (wind barb per station + Jamboree marinas, campsite, Sea Scout area)
- `sailing-day.html` — the crews' "is it a sailing day?" picture
- `wind-barbs.html` — how to read a barb

## Deploy
1. New Cloudflare Worker named `aurora-wsj` → paste `aurora-wsj-worker.js` → deploy.
   (Its URL must match `DATA_BASE` in the pages: `https://aurora-wsj.gregor-fea.workers.dev`.)
2. Push the four HTML files to the Pages repo. Mirror `DEPLOY-lakes.md` for the rest.

## First-deploy tuning (the Polish feeds can't be reached from the build sandbox)
Open each `/{station}.json` once the Worker is up and check:
- **IMGW wind unit** — defaults to m/s (documented). If Świbno/Gdynia/Hel/Gdańsk read ~3.6× too
  fast, set `IMGW_WIND_UNIT = "kmh"` in the Worker.
- **IMGW stations** — Świbno and Gdynia aren't IMGW synop stations, so the backbone is the four
  real ones by id: Gdańsk (12155), Hel (12135), Elbląg (12160) and the offshore Baltic Platform
  (12001). Swap an id in `IMGW_STATION` for another coastal one (Łeba 12120, Ustka 12115,
  Świnoujście 12200) if you prefer. Wind is m/s (confirmed); times are UTC, converted to Warsaw.
- **Górki Zachodnie** — reads from the public widget, no key. The parser was checked against a real
  widget payload. If Holfuy ever changes the widget markup, fix the regexes in `gorkiWidget()` or
  drop a key into `HOLFUY_KEY` to use the keyed API fallback.

## Two things to confirm
- **Barb convention.** These pages use the Northern-Hemisphere barb (feathers on the left) — correct
  for Poland, but the opposite of the other Aurora (Southern-Hemisphere) pages. Keep, or match the
  brand for uniformity — your call.
- **Marina names on the map** are read from the Jamboree "Main Places" slide. Positions on the
  schematic are approximate and easy to nudge.
