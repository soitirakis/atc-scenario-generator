# Test strategy

This document describes what each test layer covers, and why it is there.

## Layers at a glance

<!-- test-counts:start -->
| File | What it covers | Tests |
|---|---|---|
| `tests/unit/airac.test.js` | ENR 4.1 and 4.4 parsers against fixtures, the FRA role rule, AIRAC diffs and edition dates | 17 |
| `tests/unit/areas.test.js` | ENR 5.2 parsers (PDF text, HTML table text), strict vertical limits and the known AIP misprints, loading the areas | 20 |
| `tests/unit/civmil.test.js` | military data (training constructs), OAT tracks and non-RVSM minima, the COMLOSS chain, short-notice extensions | 12 |
| `tests/unit/cmdline.test.js` | command line shorthand, malformed input, callsign completion | 17 |
| `tests/unit/country.test.js` | Romania data integrity and the country loader | 15 |
| `tests/unit/geo.test.js` | projection, AIP coordinate parsing, plane geometry, the seeded RNG | 12 |
| `tests/unit/grading.test.js` | per-inject objectives: a pass and a fail case for every inject type, the debrief data | 39 |
| `tests/unit/link.test.js` | two-window protocol, what the trainee snapshot contains, trainee commands | 14 |
| `tests/unit/nets.test.js` | APW, CLAM, RAM and MTCD on plain data and in the simulator | 21 |
| `tests/unit/performance.test.js` | OpenAP WRAP conversion, ISA airspeeds, wind | 12 |
| `tests/unit/radio.test.js` | readbacks, the busy frequency, one transmission per command line, similar callsigns | 8 |
| `tests/unit/records.test.js` | session record builder and validator, the clearance log, import of single records and bundles, storage unavailable | 22 |
| `tests/unit/progress.test.js` | a trainee's progress from fixture records: grouping by name, per inject type (seen, met rate, median, trend), separation and routine per session, the weakest objectives in plain words | 13 |
| `tests/unit/charts.test.js` | inline SVG charts for the Progress view: bars, closest pair against 5 NM, last-sessions squares, escaping | 5 |
| `tests/unit/pdf.test.js` | PDF debrief from a fixture record: page count, header, objective and criteria, injects, stats, timeline, snapshots, remarks, signatures, the training mark on every page, page breaks, text for the PDF fonts | 20 |
| `tests/unit/scenario-file.test.js` | scenario export and import validation, the sample library | 24 |
| `tests/unit/sector-volumes.test.js` | sector layers and vertical limits (KOMAN 1/2), collapsed layers, delegated airspace, several source AIPs, upper-airspace-only units | 27 |
| `tests/unit/scenario.test.js` | local scenario builder and the Claude reply validator | 10 |
| `tests/unit/sim.test.js` | determinism, traffic and built-in conflicts, injects, clearances, the sector routine, pseudo-pilot, performance and wind in the simulator, robustness | 61 |
| `tests/unit/tools.test.js` | range-bearing line, SEP, level probe | 15 |
| `tests/e2e/app.spec.js` | the single window: loading, clearances, injects, data blocks, tools, command line, COMLOSS, no requests to other hosts | 17 × 2 viewports |
| `tests/e2e/two-windows.spec.js` | instructor and trainee windows: sync, what the trainee sees, commands through the link, grading | 9 × 2 viewports |
| `tests/e2e/session-records.spec.js` | session history: save, reload, list, open, replay, export one and all, delete, import, no storage | 5 × 2 viewports |
| `tests/e2e/scenario-files.spec.js` | export, reload and import round trip, the library in both windows, invalid files | 3 × 2 viewports |
| **Total** | 20 unit files, 4 end-to-end files | 384 unit, 34 end-to-end × 2 viewports |
<!-- test-counts:end -->

The counts come from the test runners: `node scripts/test-counts.mjs` rewrites them, and CI fails if they differ (`--check`). The coverage gate (`npm run test:coverage`, `vite.config.js`) requires 85% per file on `src/sim.js`, `src/scenario.js`, `src/cmdline.js`, `src/records.js`, `src/pdf.js`, `src/progress.js`, `src/charts.js`, `src/nets/*.js` and `src/tools/*.js`.

The unit tests run in Node in a few seconds and need no browser or network. The end-to-end tests run against the production build, on a desktop and a phone viewport. CI (`.github/workflows/ci.yml`) runs the unit tests with coverage, checks these counts, then runs the end-to-end tests, on every push and pull request. A push to `main` deploys to GitHub Pages only if all of that passes.

## Data integrity

**What.** Each country module is checked after loading, as the simulator sees it:
- **Sectors:** every elementary sector contains its own label point; no two elementary sectors claim the same label point (a cheap overlap test); collapsed configurations reference existing sectors.
- **Aerodromes:** all published aerodromes lie inside the FIR.
- **Points:** every point has a known FRA role (`E`, `X`, `EX`, `L`, `I`), and names are unique.
- **Traffic:**
  - every gate point exists;
  - flows run between gates or main airports, never airport to airport;
  - every gate group used in a flow has at least one entry-capable and one exit-capable point;
  - closed gates carry no flows.
- **Main airports:** each has an approach unit, a hand-off distance and both connection points for every flow that uses it.
- **Exit levels:** every open gate and main airport has an agreed level, and the `_note` states that the levels are modelled, not taken from a Letter of Agreement.

**Why.** The data is hand-assembled from PDFs and HTML pages. Most mistakes in that process (a swapped coordinate, a misnamed border segment, a gate that lost its last exit point) do not crash anything. They produce traffic that spawns in the wrong place, or a sector that is silently wrong. These checks turn that kind of mistake into a failing test with the point or sector named in the message. The README asks anyone adding a country to copy this file.

## Determinism

**What.** The same seed, sector and difficulty must produce the same session:
- the unit suite steps two sessions for ten minutes and compares every aircraft's position, level and the full event log;
- a different seed must produce different traffic.

**Why.** Instructors rerun a scenario to compare trainees, and debugging a reported problem needs the exact session back. The simulator advances only through `Sim.step()` (one simulated second) and draws random numbers only from the seeded `this.rng`; `CLAUDE.md` makes both a rule. A stray `Math.random()` or wall-clock dependency breaks this test.

During refactors that should not change behaviour, the same idea is applied more broadly. One example is the change that generalised main airports: 126 seeded sessions (every sector, three difficulties, three seeds, every inject type) were hashed before and after and compared. That check is not part of the suite, because intentional behaviour changes alter the hashes.

## Simulation and inject behaviour

**What.** `sim.test.js` tests behaviour through the same public methods the UI calls (`clearLevel`, `turn`, `direct`, `speed`, `answer`, `assume`, `transfer`, `ackEmergency`, `fireNow`). It never reaches into rendering.
- **Session loading:** traffic count per difficulty; most traffic is relevant to the training sector; cruising transits use semicircular levels.
- **Built-in conflicts:** STCA predicts them at least 60 s before the loss of separation, and a single level change resolves them.
- **Injects:** each inject has a test for its observable effect. For example:
  - a level bust makes the selected level disagree with the clearance;
  - a radio failure squawks 7600 and clearances get no reply until contact returns;
  - an emergency descent descends at about 4000 ft/min towards the nearest aerodrome;
  - a TSA warns five minutes ahead and then activates inside the sector;
  - a coordination request changes the agreed exit level only when accepted;
  - a late transfer arrives inside the sector unannounced and must be assumed.
- **Sector routine:**
  - initial control states;
  - each flight's agreed exit level;
  - a late assume counted once per flight;
  - a late transfer;
  - transfer at the right level against a wrong one;
  - only aircraft on frequency take clearances and raise requests.
- **A disciplined trainee:** a scripted trainee assumes on transfer, re-clears to the exit level and transfers before the boundary. It must finish with zero late assumes, late transfers and wrong exit levels in every sector of both countries. This test is there because the routine counts errors against the trainee, so it must never count one that could not have been avoided. A wider sweep (5 seeds × 19 sectors) found three such cases during development. All were fixed, and this test fails if the boundary rule behind one of them is removed.
- **Instructor controls:**
  - a held inject does not fire on time, but can still be fired by hand;
  - delay and edit validate the minute (not in the past, not past the end) and the inject type;
  - the pseudo-pilot's requests are answered like any other;
  - a refused or queried clearance is not carried out and is armed for one clearance only;
  - a silent pilot gives no reply, shows no radio failure and keeps their squawk.
- **Robustness:**
  - every inject copes with an empty sector;
  - commands reject unknown aircraft and invalid requests;
  - an unknown sector is refused;
  - a country with no main airport runs transit-only traffic.

**Why.** Injects are the training content. A broken inject usually does not throw: it fires on no aircraft, or on the wrong one. Testing each inject's observable effect catches that. `CLAUDE.md` requires a unit test for every new inject type.

## Two-window link

**What.** `tests/unit/link.test.js` runs the instructor and trainee sides of `src/link.js` against a fake channel that behaves like BroadcastChannel: every message is structured-cloned, delivered asynchronously, and never echoed to the sender.
- **The snapshot shows what a controller would know and nothing more:** no inject list, inject warnings, scenario title or instructor log lines; no built-in conflict flags; a radio failure only when 7600 is squawked; the end-of-session debrief without inject counts. It is plain data that survives structured cloning unchanged.
- **The trainee view rebuilds what the radar reads:** the time, sector, aircraft, STCA pairs and priorities, with references pointing at the view's own aircraft.
- **Commands:**
  - a trainee command runs on the instructor's Sim and returns its result;
  - with two trainee windows open, each gets its own reply;
  - instructor actions (`fireNow`, pseudo-pilot calls) and malformed arguments are refused;
  - with no instructor window, a command fails after a timeout (fake timers).
- **Presence and stray messages:** the instructor sees the trainee's hello; messages from another protocol version, or from the same role, are ignored.

**Why.** The trainee window must not learn what is coming. That rule is enforced in one function (`makeSnapshot`) and one list (`TRAINEE_COMMANDS`), so these tests check both directly. Faking the channel keeps the tests in Node and makes timing deterministic.

## Aircraft performance, ISA and wind

**What.**
- **Conversion** (`performance.test.js`): the WRAP parser is tested against OpenAP's own `a320.txt` (`tests/fixtures/openap-wrap-a320.txt`, unchanged), including unit conversion and a table with a missing row. `data/performance.json` must cover every type in the traffic files, keep its source, commit and licence, and have every typical value inside its range. The one quirk in OpenAP's own data is listed by name.
- **Atmosphere and wind:** ISA reference values (sea level, tropopause, speed of sound); textbook conversions (250 KCAS at FL100 is about 289 KTAS; M0.80 at FL370 is about 459 KTAS); the wind's sign convention, interpolation and validation; a seeded default wind.
- **Behaviour** (`sim.test.js`, one aircraft alone, calm air unless a wind is set):
  - an A320 and a B77W given the same climb clearance reach the level at different times, each inside the range WRAP gives for that band;
  - a crosswind gives a track different from the heading, and a heading clearance drifts by the expected angle and distance;
  - own navigation corrects for the wind;
  - ground speed is TAS plus the head or tail wind;
  - each type cruises at its own Mach;
  - Mach and IAS clearances reach the matching TAS, within the type's maximum Mach;
  - "or greater" and "or less" rate clearances change the time to level, and end at the level; a rate the type cannot make is refused;
  - STCA's level profile matches the simulated climb second by second across a band change.
- **Fair traffic:** no aircraft starts inside 5 NM and 1000 ft of another, except the scripted conflict pairs.

**Why.** Performance decides when aircraft reach their levels, which is what a trainee plans separation around, so the times are checked against the published data ranges rather than fixed numbers. The atmosphere and wind are pure functions, so reference values pin them down. A sweep of a disciplined trainee over 152 sessions (both countries, every sector, 8 seeds) found no routine errors after the change; the unit suite keeps a one-seed version of that check.

## Scenario builder and Claude reply validator

**What.**
- **Builder:** the local builder keeps every inject inside the session, puts the objective's theme first, and adds a conflict when the objective is about separation.
- **Prompt:** the prompt names the sector, its real points, the allowed inject types and the inject count for the difficulty.
- **Validator:** it drops unknown inject types, clamps inject times, caps text lengths and counts, fills a sparse reply from the session settings, and rejects a reply with nothing usable.

**Why.** Claude's reply is untrusted input. Whatever comes back, the validator must produce a scenario the simulator can run, or throw.

## Parser fixtures

**What.** The AIRAC parsers are tested against text fixtures in `tests/fixtures/`:

| Fixture | Source |
|---|---|
| `enr44-excerpt.txt`, `enr41-excerpt.txt`, `lr-enr-5-2-excerpt.txt` | excerpts of the ROMATSA PDF text |
| `lh-enr441-excerpt.txt`, `lh-enr41-excerpt.txt`, `lh-enr-5-2-excerpt.txt` | **synthetic**: invented names, coordinates and limits in the layout of the HungaroControl eAIP HTML tables. The Hungarian AIP text was removed while Hungary is withdrawn (see the README); the parsers stay. |

The tests check:
- that every point in an excerpt is found;
- the role assigned to each FRA relevance pattern;
- the committed Romanian data agrees with the parser for every point in an excerpt;
- the eAIP index selects the edition in force on a date;
- the change report (`diffPoints`, `diffNavaids`).

**Why.** The AIPs have no data API, and their layout varies (PDF text runs, HTML tables, level bands, combined codes). Fixtures keep the tests fast and offline, and pin the exact text that once caused a misread:
- Four-letter relevance codes such as `(EXAD)` in the letter-code format were first read as intermediate only. The synthetic fixture keeps two such rows, and the test fails with the old three-letter regex.
- In the DVOR/DME table format, the parser must take the VOR position, not the DME antenna position next to it.

The live download (`npm run airac`) is not run in CI, because it depends on third-party sites.

## Geometry

**What.** AIP coordinate parsing, projection, point-in-polygon, segment intersection, bearings and the seeded random generator.

**Why.** Everything else builds on these. They are small and easy to get subtly wrong at the edges: southern or western hemispheres, bearings near north, collinear segments.

## End to end, on two viewports

**What.** Playwright builds the single-file production bundle (`vite build`), serves it with `vite preview` and runs every test twice: on a desktop viewport (1440 × 900) and on a phone (Pixel 7). Any uncaught page error fails the test. The tests cover:
- loading with no horizontal overflow at phone width;
- selecting a track and clearing a level;
- firing an inject and seeing it in the priorities;
- rebuilding a session for another sector;
- switching country;
- label placement: in an advanced ARGES session, data blocks overlap by no more than 20% on desktop, or by no more than 10 points above the best layout possible when tracks bunch; labels stay put between radar updates; a dragged label stays where it was put;
- the sector routine through the panels: assume a pending flight, transfer one at its exit level, accept a coordination request, assume a flight that arrived without transfer;
- the debrief, including the routine counters;
- **two windows** (`two-windows.spec.js`): the instructor and trainee pages open in one browser context, so they share a BroadcastChannel as two windows on one computer do:
  - the trainee mirrors the instructor's traffic, and an "Inject in" warning shows only on the instructor side;
  - freezing in the instructor window shows "Frozen by the instructor" to the trainee;
  - a trainee clearance changes the instructor's Sim;
  - a pseudo-pilot request appears in the trainee's priorities and is approved there, and a refusal comes back to the trainee;
  - the instructor holds, edits and fires injects;
  - solo mode has no link and keeps its inject list.

**Why.** Unit tests do not see the DOM, the canvas, or the build. These tests run the artefact that is deployed. The phone viewport is there because the UI must work at about 400 px (`CLAUDE.md`).

The label limit is relative where it has to be. Each minute, the test computes the best layout possible with the four label positions (`tests/e2e/best-layout.js`, a seeded search), and allows `max(20%, best + 10 points)` on desktop and `max(65%, best + 10 points)` on the phone. Where tracks bunch, as they do in the denser minutes of this session with wind and per-type speeds, even the best layout overlaps by about 30% on desktop and 65% on the phone, so a fixed 20% would test the traffic, not the code. The relative limit still fails when the layout is clearly worse than it could be: it caught the renderer keeping a stale 21% layout where 7% was possible.

## Coverage gate

**What.** `npm run test:coverage` runs the unit suite with V8 coverage on `src/sim.js`, `src/scenario.js` and the safety net and tool modules in `src/nets/` and `src/tools/`, and fails if statements, branches, functions or lines fall below 85% in any of them. CI writes the result to `coverage.json` on the Pages site, which feeds the README badge.

**Why these files.** They hold the logic that decides what a trainee experiences and is scored on, and they have no DOM, so unit tests can reach almost every branch. `src/render.js` and `src/main.js` are covered by the end-to-end tests instead. `src/geo.js` and `src/country.js` are covered indirectly by every test that loads a country.

Branch coverage is the binding metric: it reached the threshold only after adding tests for the validator's fallbacks and for injects in an empty sector, which are real behaviours, not padding.

## Defects found by the tool itself

**Built-in conflicts that never happened.** Each scenario builds crossing conflicts into the traffic (`placeConflict` in `src/sim.js`). In the "climbing" variant, aircraft B starts 3000 ft below A and climbs at 1000 ft/min to 1000 ft above A, so it passes A's level after 3 minutes and levels off after 4. That only meets A at the crossing when the crossing is about 3 minutes ahead. Later conflicts are placed 9.5, 15 and 20.5 minutes ahead, and there B had been level 1000 ft above A for minutes when they crossed: separated, not a conflict. Scenarios that promised N built-in conflicts sometimes delivered fewer.

*How it was found.* While adding MTCD, its unit test checked that MTCD lists a built-in conflict beyond STCA's 3-minute look-ahead. MTCD listed none. Tracing the pair showed it passing 0.4 NM apart at FL350 and FL360, exactly 1000 ft: MTCD was right and the generator was wrong. The STCA test had not caught it because it only looks at the first conflict, which is close enough to work.

*Fix and guard.* The climbing variant is used only when the conflict is 4 minutes ahead or less; later conflicts are level. The random draw still happens, so every seed keeps its traffic. The guard is `every built-in pair really loses separation if nobody acts, including the later ones` in `tests/unit/sim.test.js`: four seeds at advanced traffic, nobody acting, and every built-in pair inside 22 minutes must come within 5 NM / 1000 ft. It fails on the old generator (seed 1's third conflict never happens).

**CLAM flagged a climbing aircraft as a level deviation.** CLAM raised DEV whenever the aircraft was more than 300 ft from the cleared level on the selected level's side, without checking that it had actually crossed the cleared level. An aircraft cleared to FL370 but with FL360 selected, still climbing through FL350, was reported as a deviation instead of a selected-level mismatch.

*How it was found.* The fail case of the readback-error inject: the pilot reads back FL360 instead of FL370, sets it, and the test expected CLAM to show SFL. It showed DEV.

*Fix and guard.* DEV now needs the aircraft to be between the cleared and the selected level (it crossed the cleared level towards the selected one), or moving away from the cleared level. Guarded by `still climbing towards a selected level short of the cleared level: SFL, not DEV` in `tests/unit/nets.test.js`, which fails on the old rule.

## Not covered

- **Generate with Claude:** this path needs the claude.ai artifact runtime, so CI tests the prompt and the validator, not a live model call.
- **AIRAC downloads:** the eAIP downloads run by hand each cycle (see the README); only the parsing is in CI.
- **Rendering:** checked through label geometry and the screenshots in `docs/img/` (`npm run screenshots`), not pixel by pixel.
- **Performance:** not measured.

## Running the tests

```bash
npm test                # unit tests
npm run test:coverage   # unit tests with the 85% gate
npm run test:e2e        # end to end, desktop and phone (builds first)
```
