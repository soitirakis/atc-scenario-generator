# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
En-route ATC radar training simulator. Vanilla JS (ES modules) built with Vite into one self-contained HTML file. No framework; the only library in the build is jsPDF (MIT), for the PDF debrief. Its optional dependencies are aliased to `src/vendor/no-optional.js` in `vite.config.js`: keep them out of the bundle. The minifier drops licence comments, so every bundled library or font needs its licence notice in the comment in `index.html` (tested in `tests/unit/pdf.test.js`).

## Commands
- `npm run dev` — dev server
- `npm test` — Vitest unit tests (fast; run after every change)
- `npm run test:e2e` — Playwright against the production build, desktop + phone
- `npm run build` — single-file `dist/index.html`
- `npm run airac` — AIRAC diff for Romania (needs network to aisro.ro). Hungary is withdrawn pending HungaroControl's written consent: `--country HU` stops, and nothing may be downloaded from or added back from HungaroControl's eAIP until that consent is given.

## Architecture rules
- `src/sim.js` must stay DOM-free. All simulation state lives on the `Sim` instance; the UI only reads it and calls command methods, which return `{ ok, msg }`. The controller's commands are the ones in `TRAINEE_COMMANDS` (`src/link.js`), the only ones a trainee window may run; instructor commands (injects, the inject timeline, pseudo-pilot, wind) are the other public `Sim` methods the UI calls.
- Time advances only through `Sim.step()` (1 simulated second). Never use `Math.random()` inside the sim; use `this.rng` so seeds stay reproducible. The reproducibility test in `tests/unit/sim.test.js` guards this.
- `src/render.js` never mutates simulation state.
- Safety nets and monitoring aids (STCA aside) live in `src/nets/` as pure modules: they take plain state or trajectories (`Sim.trajectory`) and return alerts, with their settings exported as a config object and their own unit tests. `Sim.netsScan` runs them; priorities read `sim.nets`. Level busts are detected by CLAM, not by the inject's `a.bust` flag.
- Geometry is in a flat NM plane: x east, y **south** (screen-like). Bearings: 0 = north = negative y. Use helpers in `geo.js`.
- Sectors are volumes. `inSector(xy, sec, fl)` (`src/country.js`) checks the level when the sector has vertical limits (`lower`/`upper`, lower inclusive, upper exclusive) or delegated areas (`include`/`exclude`, each with its own band); pass the aircraft's level wherever it is known. Without `fl` it checks the lateral footprint. A sector with neither is lateral only, exactly as before, so existing modules behave the same. `lookAhead` passes the predicted level (`flAfter`) to its visitor when the training sector is vertical (`isVertical`). Collapsed configurations can combine layers and other collapsed configurations (`members` is the flattened list).
- Upper-airspace-only modules (`meta.upperOnly`) have no approach units: main airports name a `lowerUnit` with a hand-off boundary (`handoffNM`) and agreed levels (`arrFL`, `depFL`). Departures appear at that boundary 1000 ft below the unit's lower limit, climbing. Use `apt.unit` for the unit an arrival goes to, never `apt.approach`.
- Sector routine: each aircraft has a control state `ctl` (`none`, `pend`, `ass`, `xfer`) and an agreed exit level `xfl`. Only `pend`/`ass` aircraft take clearances (`_cmd` refuses the rest); `assume` and `transfer` change the state and count late assumes, late transfers and wrong exit levels in `stats`. Entry, exit and hand-off times come from `lookAhead`, which follows the route; a boundary crossing only counts if the flight stays on the other side for `ROUTINE.crossS`.
- New inject types: add to `TYPES` in `sim.js`, implement in `fireInject`, add text in `scenario.js` `INJECT_TEXT`, and add a unit test. The Claude prompt lists `TYPES` automatically.
- Clearances go through `_cmd`, which is the radio: a clearance on a busy frequency gets "say again", and every clearance queues a readback (`RADIO`, timing from `this.radioRng`, never `this.rng`). Several clearances in one transmission go through `transmit`; the command line goes through `command`. Tests that give two clearances in a row must wait for `freqBusy()` to clear.
- Every inject type is graded: give it an objective and limits in `GRADING`, set `inj.g` in `fireInject` to what it acts on, judge it in `judge()`, and add a pass and a fail case in `tests/unit/grading.test.js`. Grading only reads state; it never calls `this.rng`.
- Session records: `buildRecord` and `validateRecord` in `src/records.js` (DOM-free) define the format, with their own `SCHEMA_VERSION`; a change to its shape bumps it. A record embeds a scenario file, so it must also pass `validateScenarioFile`. Storage is `src/store.js` (IndexedDB, with a memory fallback when it is unavailable); nothing is sent anywhere. The clearance log is `sim.clearances`, filled by `clr()`: give every new controller action an entry there. It never calls `this.rng`.
- Version 2 records add `sectorBand`, `snapshots` (JPEG data URLs of the radar, taken by `captureEvents` in `main.js` at inject and loss-of-separation timeline marks) and `remarks`; `upgradeRecord` reads version 1. Read stored or imported records through it.
- The PDF debrief is `buildDebriefPdf` in `src/pdf.js`, DOM-free so it is unit tested in Node. Pass all text through `pdfText` (standard PDF fonts are WinAnsi only), and keep "Training aid, not an official assessment" on every page.
- Progress (`src/progress.js`) only reads records: per inject type, the `STANDING` objectives, the series per session, and the weakest objectives in plain words; settings in `PROGRESS`. Its charts are `src/charts.js` (SVG strings, one measure per chart, no chart library). Both are DOM-free and tested with `tests/fixtures/progress-records.json`, whose expected numbers are worked out in the test's header comment; change both together.
- "Suggest next scenario" is `suggestScenario` in `src/recommend.js` (DOM-free, deterministic, settings in `RECOMMEND`). Every choice it makes gets a reason (`{ rule, text }`); a new rule needs one too. It must always return a file that passes `validateScenarioFile`: `tests/unit/recommend.test.js` checks that over 400 generated histories. The UI never loads a suggestion without Accept.
- Pilot transmissions for the voice are `sim.tx` (`pushTx`): readbacks with their slot (from when the log shows them to the end of the busy frequency) and pilot requests. It only records; never use it to change timing. The words come from `src/phraseology.js` (DOM-free, tested); a new clearance text in `_cmd` needs a case in `spokenClearance`, and a new operator in a `traffic.json` needs a telephony designator in `data/telephony.json` from a cited source. `src/voice.js` speaks only in the solo and trainee windows, and only at 1× sim speed.
- Scenario files: `exportScenario` and `validateScenarioFile` in `scenario.js` define the format. A change to its shape bumps `SCHEMA_VERSION`. Files in `data/scenarios/` must pass validation and every inject in them must find an aircraft when the session runs (`tests/unit/scenario-file.test.js` checks both).

## Two windows
- `src/link.js` is DOM-free like `sim.js`; the instructor window owns the Sim, the trainee window only has a `SimView` built from snapshots.
- `makeSnapshot` decides what a trainee may see. Add aircraft fields to `AC_FIELDS` only if a controller would know them. Log lines meant only for the instructor use `sim.log(text, cls, 'i')`; priority items only for the instructor carry `instr: true`.
- A trainee window may only run the commands in `TRAINEE_COMMANDS`. New controller actions go there; instructor actions (injects, pseudo-pilot) never do. Read-only controller tools that need the Sim (`probeLevel`) go there too and return their result in the reply.
- Controller tools live in `src/tools/` as pure modules. Their on-screen state (`R.tools`: RBL lines, SEP pairs, tool mode) belongs to `main.js`; `render.js` only draws it.

## Performance and wind
- Military (OAT) tracks are the one exception: their rates and speeds come from `data/<CODE>/military.json` (training construct, labelled in `_note`), because OpenAP has no fighter models. OAT tracks have `a.oat`, `ctl: 'mil'`, are flown by `oatStep` and skip the civil routine; separation with them uses `vMin` (non-RVSM). Military base positions need an official source; otherwise leave the base out.
- Climb/descent rates, speeds and Mach of civil traffic come only from `data/performance.json` (OpenAP WRAP, GPL-3.0), regenerated with `node scripts/openap-wrap.mjs`; do not hand-edit it and do not add BADA data. A new aircraft type in `traffic.json` needs an entry in that script's `TYPE_MAP` with a reason.
- `a.gs` and `a.trk` are derived (TAS + wind) every step; change `a.spd` (IAS/Mach clearance), `a.rate` (rate clearance) or `a.hdg`/route instead. `a.vr` is only for scripted overrides (built-in conflicts, level bust).
- Anything that predicts motion (STCA, look-ahead) must use the same model: `levelProfile`/`flAfter` for levels, track and ground speed for position.

## Data rules
- Country data lives in `data/<CODE>/` as JSON. Keep coordinates in AIP DMS notation, exactly as published, so they can be diffed against the source. Sector limits too: `"FL 245"`, `"GND"` or `"Lower limit of ATS routes"`; anything else makes the loader fail. A sector that leaves a border part-way uses `{ "b": "KEY", "upTo": "DMS" }`.
- A module built from several states' AIPs lists them in `meta.aips` (`state`, `url`, `edition`, `amendment`); the AIP data tab shows each. Without it, the module's single eAIP comes from `meta.airac` and the first source. `npm run airac` only updates single-AIP modules (RO).
- Before changing the engine, check that RO still behaves the same: the seed reproducibility test only compares two runs, so also compare sessions for every sector before and after (fingerprint the positions, logs and stats over a full session).
- Before adding data from any publisher, read its terms of use and copyright notice (AIP GEN 0.1 and GEN 3.1, website terms, robots.txt). Do not add data whose terms forbid reuse or automated download without written permission; ask the user instead.
- Parser tests for formats whose source may not be redistributed use synthetic fixtures (invented names and coordinates in the same layout).
- Anything not from an official source (border approximations, flows, TSA geometry) must be labelled as such in the file's `_note` and in the README.
- Point roles: `E`, `X`, `EX`, `L` (entry/exit only up to FL175), `I`. The rule is implemented in `scripts/airac-lib.mjs` `classifyRole`; data must agree with it.
- Do not delete points still referenced by `traffic.json`.
- `areas.json` (ENR 5.2) is written only by `npm run airac -- --write`; do not hand-edit it. Limits stay as published. An unrecognised format makes the parser fail; a known AIP misprint is accepted only if listed in `KNOWN_LIMIT_TYPOS` (`scripts/airac-lib.mjs`, with the AIP page), and is kept and read through `upperRead`/`lowerRead` with a `note`. The MILITARY_TSA inject picks from these areas (`Sim.pickArea`).

## Style
- Plain modern JS, 2-space indent, single quotes, no semicolon-free style changes.
- UI copy: short, plain, operational. Use real ATC terms (CFL, STCA, squawk), no marketing tone.
- Keep the UI working at 400 px width; the e2e phone project checks horizontal overflow.

## Before committing
`npm test && npm run test:e2e` must pass.

main is protected: never push to main. Work on a branch and open a pull request; the `test` CI check must pass before merging.
