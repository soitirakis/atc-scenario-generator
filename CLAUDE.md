# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
En-route ATC radar training simulator. Vanilla JS (ES modules) built with Vite into one self-contained HTML file. No framework, no runtime dependencies.

## Commands
- `npm run dev` — dev server
- `npm test` — Vitest unit tests (fast; run after every change)
- `npm run test:e2e` — Playwright against the production build, desktop + phone
- `npm run build` — single-file `dist/index.html`
- `npm run airac` — AIRAC diff for Romania; `-- --country HU` for Hungary (needs network to aisro.ro / ais-en.hungarocontrol.hu)

## Architecture rules
- `src/sim.js` must stay DOM-free. All simulation state lives on the `Sim` instance; the UI only reads it and calls command methods (`clearLevel`, `turn`, `direct`, `speed`, `answer`, `ackEmergency`, `fireNow`), which return `{ ok, msg }`.
- Time advances only through `Sim.step()` (1 simulated second). Never use `Math.random()` inside the sim; use `this.rng` so seeds stay reproducible. The reproducibility test in `tests/unit/sim.test.js` guards this.
- `src/render.js` never mutates simulation state.
- Geometry is in a flat NM plane: x east, y **south** (screen-like). Bearings: 0 = north = negative y. Use helpers in `geo.js`.
- Sector routine: each aircraft has a control state `ctl` (`none`, `pend`, `ass`, `xfer`) and an agreed exit level `xfl`. Only `pend`/`ass` aircraft take clearances (`_cmd` refuses the rest); `assume` and `transfer` change the state and count late assumes, late transfers and wrong exit levels in `stats`. Entry, exit and hand-off times come from `lookAhead`, which follows the route; a boundary crossing only counts if the flight stays on the other side for `ROUTINE.crossS`.
- New inject types: add to `TYPES` in `sim.js`, implement in `fireInject`, add text in `scenario.js` `INJECT_TEXT`, and add a unit test. The Claude prompt lists `TYPES` automatically.

## Two windows
- `src/link.js` is DOM-free like `sim.js`; the instructor window owns the Sim, the trainee window only has a `SimView` built from snapshots.
- `makeSnapshot` decides what a trainee may see. Add aircraft fields to `AC_FIELDS` only if a controller would know them. Log lines meant only for the instructor use `sim.log(text, cls, 'i')`; priority items only for the instructor carry `instr: true`.
- A trainee window may only run the commands in `TRAINEE_COMMANDS`. New controller actions go there; instructor actions (injects, pseudo-pilot) never do.

## Performance and wind
- Climb/descent rates, speeds and Mach come only from `data/performance.json` (OpenAP WRAP, GPL-3.0), regenerated with `node scripts/openap-wrap.mjs`; do not hand-edit it and do not add BADA data. A new aircraft type in `traffic.json` needs an entry in that script's `TYPE_MAP` with a reason.
- `a.gs` and `a.trk` are derived (TAS + wind) every step; change `a.spd` (IAS/Mach clearance), `a.rate` (rate clearance) or `a.hdg`/route instead. `a.vr` is only for scripted overrides (built-in conflicts, level bust).
- Anything that predicts motion (STCA, look-ahead) must use the same model: `levelProfile`/`flAfter` for levels, track and ground speed for position.

## Data rules
- Country data lives in `data/<CODE>/` as JSON. Keep coordinates in AIP DMS notation, exactly as published, so they can be diffed against the source.
- Anything not from an official source (border approximations, flows, TSA geometry) must be labelled as such in the file's `_note` and in the README.
- Point roles: `E`, `X`, `EX`, `L` (entry/exit only up to FL175), `I`. The rule is implemented in `scripts/airac-lib.mjs` `classifyRole`; data must agree with it.
- Do not delete points still referenced by `traffic.json`.

## Style
- Plain modern JS, 2-space indent, single quotes, no semicolon-free style changes.
- UI copy: short, plain, operational. Use real ATC terms (CFL, STCA, squawk), no marketing tone.
- Keep the UI working at 400 px width; the e2e phone project checks horizontal overflow.

## Before committing
`npm test && npm run test:e2e` must pass.

main is protected: never push to main. Work on a branch and open a pull request; the `test` CI check must pass before merging.
