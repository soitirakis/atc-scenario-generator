# ATC Scenario Generator

En-route radar training simulator that builds scenarios and injects for a chosen country, sector and traffic level, on top of real AIP data. Romania (Bucharest ACC, LRBB) is the first country; more are added one module at a time.

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

`dist/index.html` has the code, styles and data inlined. Open it directly, host it anywhere, or publish it as a claude.ai artifact.

## Tests

```bash
npm test             # unit tests (Vitest): geometry, data integrity, simulation, scenarios, AIRAC parser
npm run test:e2e     # end-to-end (Playwright) against the built file, desktop and phone viewports
```

CI runs both on every push and pull request, and uploads the single-file build.

## Project layout

```
data/
  countries.js        registry of country modules
  RO/                 Romania: one JSON file per AIP source (see below)
src/
  geo.js              projection, AIP coordinate parsing, plane geometry, seeded RNG
  country.js          raw country module -> projected data
  sim.js              simulation engine (no DOM): traffic, physics, STCA, injects, clearances
  scenario.js         local scenario builder, Claude prompt and validator
  render.js           canvas radar display
  main.js             UI wiring
scripts/
  airac-update.mjs    pull ENR 4.1 / 4.4 from the eAIP and diff against data/RO
  airac-lib.mjs       pure parsing helpers (unit tested)
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

## Updating for a new AIRAC cycle

AIRAC cycles change every 28 days. The ROMATSA eAIP has no data API, so updates are a scripted pull of the PDFs:

```bash
npm run airac                          # report changes for the current cycle
npm run airac -- --edition 2026-10-29  # a specific eAIP edition
npm run airac -- --write               # apply, then run npm test and commit
```

What the script does and doesn't do:
- **Updates** coordinates and roles of existing points, and frequency/position of VORs.
- **Adds** new entry/exit points.
- **Reports** points that have been removed. It will not delete a point that `traffic.json` still uses.
- **Does not** add new intermediate points, because the point set is curated.
- **Does not** touch sector polygons. Update `sectors.json` by hand when EUROCONTROL NM publishes a new LR sector file.

## Adding a country

1. Create `data/<CODE>/` with the same eight files as `data/RO/`. Coordinates stay in AIP notation (`DDMMSSN DDDMMSSE`); `{ "b": "KEY" }` inside a sector polygon splices in a border segment from `borders.json`.
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
