# ATC Scenario Generator

En-route radar training simulator that builds scenarios and injects for a chosen country, sector and traffic level, on top of real AIP data. Romania (Bucharest ACC, LRBB) and Hungary (Budapest ACC, LHCC) are available from the country selector; more are added one module at a time.

- **Radar display** with the real sector polygons, VOR/DMEs, Free Route points and aerodromes.
- **Simulated traffic** flying Free Route directs between real entry and exit points, scaled by difficulty, with crossing conflicts deliberately built into the training sector.
- **STCA** at 5 NM / 1000 ft with a 3-minute look-ahead.
- **Injects that execute** in the simulation, shown in a priorities panel:
  - level bust
  - weather cell with deviation requests
  - radio failure (7600)
  - emergency descent (7700)
  - TSA activation
  - uncoordinated traffic
  - level requests
- **Clearances**: level, heading, direct-to, speed, and approve/unable on requests.
- **Debrief** at the end of the session.
- **Repeatable sessions**: the same seed, sector and difficulty always give the same traffic.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # one self-contained file: dist/index.html
```

`dist/index.html` has the code, styles and data inlined. Open it directly, host it anywhere, or publish it as a claude.ai artifact. The latest `main` is live at https://soitirakis.github.io/atc-scenario-generator/.

## Tests

```bash
npm test             # unit tests (Vitest): geometry, data integrity, simulation, scenarios, AIRAC parser
npm run test:e2e     # end-to-end (Playwright) against the built file, desktop and phone viewports
```

CI runs both on every push and pull request, and uploads the single-file build. On `main`, once both pass, it deploys that same file to GitHub Pages: https://soitirakis.github.io/atc-scenario-generator/

## Project layout

```
data/
  countries.js        registry of country modules
  RO/                 Romania: one JSON file per AIP source (see below)
  HU/                 Hungary: same files
src/
  geo.js              projection, AIP coordinate parsing, plane geometry, seeded RNG
  country.js          raw country module -> projected data
  sim.js              simulation engine (no DOM): traffic, physics, STCA, injects, clearances
  scenario.js         local scenario builder, Claude prompt and validator
  render.js           canvas radar display
  main.js             UI wiring
scripts/
  airac-update.mjs    pull ENR 4.1 / 4.4 from the eAIP and diff against data/RO
  airac-lib.mjs       pure parsing helpers (unit tested), including Hungary's ENR 4.4.1 format
tests/
  unit/  e2e/  fixtures/
```

## Data sources (Romania)

| File | Content | Source |
|---|---|---|
| `sectors.json` | 9 elementary + 4 collapsed ACC sectors | EUROCONTROL NM RAD sector file `LR_Sector ID_14-08-25` |
| `borders.json` | border vertices between published sector corners | **approximated** from the national boundary |
| `navaids.json` | 16 VOR/DME | eAIP ENR 4.1 (AIRAC AMDT 09/25) |
| `points.json` | 131 significant points with FRA role | eAIP ENR 4.4 (AIRAC AMDT 06/26) |
| `airports.json` | aerodrome reference points | eAIP AD 2 |
| `traffic.json` | gates, flow weights, operators, main airports (LROP) | modelling choice, not published data |

eAIP: https://aisro.ro/aip/2026-10-01/html/ro/aip_toc_enr.html

**FRA point roles** in `points.json`:

| Role | Meaning |
|---|---|
| `E` / `X` / `EX` | Horizontal entry, exit, or both, at upper levels |
| `L` | Entry or exit only in a band topping out at FL175 or below |
| `I` | Intermediate point only |

**What is not real:**
- the TSA geometry, which is a training construct;
- the flow weights;
- the border segments between published sector corners.

The Ukrainian entry and exit points are kept in the data but carry no traffic (`closed: true`).

## Data sources (Hungary)

| File | Content | Source |
|---|---|---|
| `sectors.json` | 4 lateral ACC sectors (WEST, NORTH, EAST, SOUTH) | **traced** from eAIP chart ENR 6-LHCC-SECTOR (19 MAR 2026); FIR corners from ENR 2.1 |
| `borders.json` | border vertices between sector corners | **approximated**: Natural Earth 1:10m; HU-RO reuses Romania's vertices |
| `navaids.json` | 9 DVOR/DME | eAIP ENR 4.1 (AIRAC AMDT 006/2026) |
| `points.json` | 107 FRA significant points with role | eAIP ENR 4.4.1 (AIRAC AMDT 006/2026) |
| `airports.json` | aerodrome reference points | eAIP AD 2.2 |
| `traffic.json` | gates, flow weights, operators, main airport (LHBP) | modelling choice, not published data |

eAIP: https://ais-en.hungarocontrol.hu/aip/2026-09-03/ (AIRAC AMDT 006/2026, effective 2026-09-03). AMDT 007/2026 (effective 2026-11-26) does not change ENR 2.1, 4.1, 4.4.1 or the sector chart.

**Sector polygons are not published data.** The EUROCONTROL NM RAD has no LH sector file, and the eAIP shows Budapest ACC sectors only as a chart. The four internal boundary lines were traced from that chart after fitting its Lambert conformal conic graticule (0.07 NM RMS on the grid ticks); treat them as accurate to about 0.5 NM. Each lateral sector is split into ten elementary layers (0–9, at FL305 to FL385); the simulator uses the lateral outline. Areas of ATS delegation to or from Wien, Bratislava and Košice are not modelled.

**FRA roles** follow the same `classifyRole` rule as Romania. ENR 4.4.1 gives relevance per level band, e.g. ABULI `(I) FL245-FL660` / `(X) 9500 FT AMSL-FL245`; `9500 FT AMSL` is read as FL095. Many border points are entry/exit only up to FL245 and intermediate above (cross-border free route); under the rule they count as `E`/`X`/`EX`, because the band tops out above FL175. Points with only arrival/departure connection relevance, or none, are left out, as for Romania.

**HU-RO border.** The Romania gate uses ODCIH, NARKA and KARIL, the same three points as the Hungarian side of Romania's west gate, with identical coordinates in both AIPs. Their role differs between the AIPs (Romania `I`, Hungary `L`), which reflects what each AIP publishes. The border line reuses Romania's vertices, so both countries draw it the same way.

## Updating for a new AIRAC cycle

AIRAC cycles change every 28 days. Neither eAIP has a data API, so updates are a scripted pull of the published pages, followed by a diff against `data/<CODE>`. Nothing is written without `--write`.

```bash
npm run airac                                    # Romania (default), current cycle, report only
npm run airac -- --country HU                    # Hungary, edition in force today
npm run airac -- --country HU --date 2026-11-26  # Hungary, edition in force on a date
npm run airac -- --edition 2026-10-29            # a specific eAIP edition
npm run airac -- --country HU --write            # apply, then run npm test and commit
```

| | Romania (`RO`) | Hungary (`HU`) |
|---|---|---|
| Source | ROMATSA eAIP, PDF: ENR 4.1, ENR 4.4 | HungaroControl eAIP, HTML: ENR 4.1, ENR 4.4.1 |
| Editions | a new edition every AIRAC cycle | amended on some cycles only; without `--edition`, the script reads the eAIP index and uses the edition in force on `--date` (default today) |
| New points added by `--write` | entry/exit points only (`E`, `X`, `EX`); the point set is curated | every point with an FRA role, as `data/HU` keeps them all |
| `meta.json` on `--write` | `airac.edition` | `airac.edition`, the AMDT number in `airac.enr41`/`enr44`, and the edition in the source links |

Hungary example: on 29 OCT 2026 there is no new Hungarian edition. AMDT 006/2026 (effective 2026-09-03) is still in force, so `--country HU` reports against 2026-09-03, and `--edition 2026-10-29` stops with the list of published effective dates. The next edition, AMDT 007/2026, takes effect 2026-11-26.

What the script does and doesn't do, for both countries:
- **Updates** coordinates and roles of existing points, and frequency/position of VORs.
- **Adds** new points with the roles shown above.
- **Reports** points that have been removed, or that lost their FRA role. It will not delete a point that `traffic.json` still uses (gates or main-airport connection points).
- **Does not** touch sector polygons or borders. Update `sectors.json` by hand when EUROCONTROL NM publishes a new LR sector file. For Hungary, re-trace only if ENR 6-LHCC-SECTOR changes.

## Adding a country

1. Create `data/<CODE>/` with the same eight files as `data/RO/`. Coordinates stay in AIP notation (`DDMMSSN DDDMMSSE`); `{ "b": "KEY" }` inside a sector polygon splices in a border segment from `borders.json`. In `meta.json`, `defaultSector` picks the sector selected when the country loads, and `simNote` is the traffic note shown in the AIP data tab.
2. Choose real FRA entry/exit points as traffic gates and write the flow table. Each flow is `[from, to, weight]` between two gate groups, or between a gate group and a main airport. Flows are flown in both directions.
3. Optionally declare one or more main airports in `traffic.json` to get arrivals and departures:

   ```json
   "mainAirports": [
     {
       "icao": "LROP",
       "approach": "Bucharest APP",
       "handoffNM": 35,
       "arr": { "W": "PEMOK", "S": "SORDU" },
       "dep": { "W": "SOKRU", "S": "POLUN" }
     }
   ]
   ```

   - `icao` must also be in `airports.json`.
   - `arr` and `dep` map each gate group to the FRA point where arrivals leave the network and departures join it. Every gate group that has a flow to the airport needs both.
   - Arrivals are transferred to `approach` once they are within `handoffNM` of the airport.

   Leave `mainAirports` out for a transit-only country.
4. Register it in `data/countries.js`.
5. Copy `tests/unit/country.test.js` for the new module. Its checks catch most data mistakes: sectors that don't contain their own label, overlapping sectors, aerodromes outside the FIR, gates that don't exist, and main airports with missing connection points.

## Claude integration

When the page runs inside a claude.ai artifact, **Generate with Claude** writes a scenario from the instructor's objective. It uses the viewer's own Claude account through the artifact runtime, and the injects it picks run in the simulator.

Outside claude.ai the button stays hidden and the local builder is used. A standalone deployment that wants this would need a small backend holding an API key. Never put a key in browser code.

## Status

Concept and portfolio project. Not validated against any operational system.
