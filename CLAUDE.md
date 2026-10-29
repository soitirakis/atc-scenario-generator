# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
En-route ATC radar training simulator. Vanilla JS (ES modules) built with Vite into one self-contained HTML file. No framework, no runtime dependencies.

## Commands
- `npm run dev` — dev server
- `npm test` — Vitest unit tests (fast; run after every change)
- `npm run test:e2e` — Playwright against the production build, desktop + phone
- `npm run build` — single-file `dist/index.html`
- `npm run airac` — AIRAC diff for Romania (needs network to aisro.ro)

## Architecture rules
- `src/sim.js` must stay DOM-free. All simulation state lives on the `Sim` instance; the UI only reads it and calls command methods (`clearLevel`, `turn`, `direct`, `speed`, `answer`, `ackEmergency`, `fireNow`), which return `{ ok, msg }`.
- Time advances only through `Sim.step()` (1 simulated second). Never use `Math.random()` inside the sim; use `this.rng` so seeds stay reproducible. The reproducibility test in `tests/unit/sim.test.js` guards this.
- `src/render.js` never mutates simulation state.
- Geometry is in a flat NM plane: x east, y **south** (screen-like). Bearings: 0 = north = negative y. Use helpers in `geo.js`.
- New inject types: add to `TYPES` in `sim.js`, implement in `fireInject`, add text in `scenario.js` `INJECT_TEXT`, and add a unit test. The Claude prompt lists `TYPES` automatically.

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
