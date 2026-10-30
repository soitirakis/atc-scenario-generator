# Test strategy

This document describes what each test layer covers, and why it is there.

## Layers at a glance

| Layer | Tool | Where | Size | Runs |
|---|---|---|---|---|
| Data integrity | Vitest | `tests/unit/country.test.js`, `country-hu.test.js` | 31 tests | `npm test`, CI |
| Determinism and simulation behaviour | Vitest | `tests/unit/sim.test.js` | 37 tests | `npm test`, CI |
| Scenario builder and Claude reply validator | Vitest | `tests/unit/scenario.test.js` | 10 tests | `npm test`, CI |
| AIP parsers against fixtures | Vitest | `tests/unit/airac.test.js`, `tests/fixtures/` | 19 tests | `npm test`, CI |
| Geometry | Vitest | `tests/unit/geo.test.js` | 12 tests | `npm test`, CI |
| End to end, two viewports | Playwright | `tests/e2e/app.spec.js` | 12 tests × 2 viewports | `npm run test:e2e`, CI |
| Coverage gate | Vitest (V8) | `vite.config.js` | 85% per file on `src/sim.js`, `src/scenario.js` | `npm run test:coverage`, CI |

Unit tests run in Node in under five seconds and need no browser or network. End-to-end tests run against the production build. CI (`.github/workflows/ci.yml`) runs the unit tests with coverage, then the end-to-end tests, on every push and pull request. A push to `main` deploys to GitHub Pages only if both pass.

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
- **Hungary only:**
  - the sector outlines use the published ENR 2.1 FIR corners;
  - approximated geometry is labelled in `_note`;
  - the HU–RO border reuses Romania's vertices;
  - the Romania gate uses the same points as the Hungarian side of Romania's west gate, with identical coordinates;
  - points published by both AIPs have the same coordinates in both modules.

**Why.** The data is hand-assembled from PDFs, HTML pages and, for Hungary, a traced chart. Most mistakes in that process (a swapped coordinate, a misnamed border segment, a gate that lost its last exit point) do not crash anything. They produce traffic that spawns in the wrong place, or a sector that is silently wrong. These checks turn that kind of mistake into a failing test with the point or sector named in the message. The README asks anyone adding a country to copy this file.

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
- **Robustness:**
  - every inject copes with an empty sector;
  - commands reject unknown aircraft and invalid requests;
  - an unknown sector is refused;
  - a country with no main airport runs transit-only traffic.

**Why.** Injects are the training content. A broken inject usually does not throw: it fires on no aircraft, or on the wrong one. Testing each inject's observable effect catches that. `CLAUDE.md` requires a unit test for every new inject type.

## Scenario builder and Claude reply validator

**What.**
- **Builder:** the local builder keeps every inject inside the session, puts the objective's theme first, and adds a conflict when the objective is about separation.
- **Prompt:** the prompt names the sector, its real points, the allowed inject types and the inject count for the difficulty.
- **Validator:** it drops unknown inject types, clamps inject times, caps text lengths and counts, fills a sparse reply from the session settings, and rejects a reply with nothing usable.

**Why.** Claude's reply is untrusted input. Whatever comes back, the validator must produce a scenario the simulator can run, or throw.

## Parser fixtures

**What.** The AIRAC parsers are tested against excerpts of the real AIP text in `tests/fixtures/`:

| Fixture | Source |
|---|---|
| `enr44-excerpt.txt`, `enr41-excerpt.txt` | ROMATSA PDF text |
| `lh-enr441-excerpt.txt`, `lh-enr41-excerpt.txt` | HungaroControl HTML text |

The tests check:
- that every point in an excerpt is found;
- the role assigned to each FRA relevance pattern;
- the committed data agrees with the parser for every point in an excerpt;
- the eAIP index selects the edition in force on a date;
- the change report (`diffPoints`, `diffNavaids`).

**Why.** The AIPs have no data API, and their layout varies (PDF text runs, HTML tables, level bands, combined codes). Fixtures keep the tests fast and offline, and pin the exact text that once caused a misread:
- Hungarian four-letter relevance codes such as `(EXAD)` were first read as intermediate only. Both affected rows are in the fixture, and the test fails with the old three-letter regex.
- For Hungarian navaids, the parser must take the VOR position, not the DME antenna position next to it.

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
- label placement: no two data blocks overlap by more than 20% on desktop; labels stay put between radar updates; a dragged label stays where it was put;
- the sector routine through the panels: assume a pending flight, transfer one at its exit level, accept a coordination request, assume a flight that arrived without transfer;
- the debrief, including the routine counters.

**Why.** Unit tests do not see the DOM, the canvas, or the build. These tests run the artefact that is deployed. The phone viewport is there because the UI must work at about 400 px (`CLAUDE.md`).

The label overlap limit is 65% on the phone instead of 20%. At phone zoom the advanced ARGES tracks sit so close that even the best of the four label positions overlaps by up to about 33%. On the phone the test guards against a broken layout, where labels stacked on each other would be near 100%.

## Coverage gate

**What.** `npm run test:coverage` runs the unit suite with V8 coverage on `src/sim.js` and `src/scenario.js`, and fails if statements, branches, functions or lines fall below 85% in either file. CI writes the result to `coverage.json` on the Pages site, which feeds the README badge.

**Why these two files.** They hold the logic that decides what a trainee experiences and is scored on, and they have no DOM, so unit tests can reach almost every branch. `src/render.js` and `src/main.js` are covered by the end-to-end tests instead. `src/geo.js` and `src/country.js` are covered indirectly by every test that loads a country.

Branch coverage is the binding metric: it reached the threshold only after adding tests for the validator's fallbacks and for injects in an empty sector, which are real behaviours, not padding.

## Not covered

- **Generate with Claude:** this path needs the claude.ai artifact runtime, so CI tests the prompt and the validator, not a live model call.
- **AIRAC downloads:** the eAIP downloads run by hand each cycle (see the README); only the parsing is in CI.
- **Hungarian sector accuracy:** the traced sector boundaries are checked for consistency, not against a ground truth, because none is published.
- **Rendering:** checked through label geometry and the screenshots in `docs/img/` (`npm run screenshots`), not pixel by pixel.
- **Performance:** not measured.

## Running the tests

```bash
npm test                # unit tests
npm run test:coverage   # unit tests with the 85% gate
npm run test:e2e        # end to end, desktop and phone (builds first)
```
