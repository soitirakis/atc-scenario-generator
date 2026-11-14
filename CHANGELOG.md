# Changelog

## 1.0.0 (2026-11-14)

The first release: pull requests #1 to #40. #12 and #14 were closed unmerged and replaced by #15 and #16.

### Simulation
- Romania (Bucharest ACC, LRBB) radar training simulator on real AIP data: sector polygons, VOR/DMEs, FRA points, aerodromes; seeded, repeatable traffic with built-in conflicts.
- Main airports for arrivals and departures, generalised per country (#2).
- Sector routine: assume and transfer of control, agreed exit levels, late assumes, late transfers and wrong exit levels in the debrief (#8); an emergency descent releases the agreed exit level (#17).
- Per-type aircraft performance from OpenAP WRAP, ISA airspeeds and wind; speed, Mach and rate clearances (#11).
- Sector volumes: vertical layers (KOMAN 1/2), delegated airspace, modules built from several AIPs, upper-airspace-only units (#29).
- Seeded random numbers throughout (#26).

### Injects and grading
- A measurable objective for every inject type, graded live and in the debrief (#16).
- Military area activation uses a real TRA layer from eAIP ENR 5.2 (#20); strict ENR 5.2 limits (#23).
- Readback error and similar-callsign injects (#24).
- Civil-military training constructs: COMLOSS and QRA scramble, non-RVSM OAT formation, short-notice military area extension (#25).

### Radar, safety nets and tools
- Data blocks placed around tracks to avoid overlap; draggable labels (#5).
- APW, CLAM, RAM and an MTCD list alongside STCA (#21).
- Range-bearing line, SEP and a what-if level probe (#22).

### Radio and voice
- Command line in controller shorthand; pilot readbacks that occupy the frequency, "say again" when busy (#24).
- Pilot voices: readbacks and requests spoken in ICAO phraseology with telephony designators, local English voices only, offline (#37).
- Readback slot of 4 s (#39).
- Voices speak only at 1× sim speed (#40).

### Instructor and trainee
- Instructor and trainee windows synced over BroadcastChannel: inject timeline, pseudo-pilot, live grading; the trainee sees only what a controller would know (#10).

### Scenarios, records and progress
- Scenario export and import with validation; a library of sample scenarios (#18), including a night shift on the collapsed KNL sector (#23).
- Session records: local history with debrief, replay, export and import (#31).
- PDF debrief with radar snapshots and instructor remarks (#33).
- Progress view per trainee, with an optional PDF progress page (#35).
- Suggest next scenario from a trainee's records, with reasons, loaded only on Accept (#36).

### Data and AIRAC
- AIRAC update script: diff against the eAIP, report points that lose their FRA role (#1); source links follow `--write` (#7); eAIP edition 2026-10-29 (#7).
- Hungary (LHCC) added as the second country (#3), with `npm run airac -- --country HU` (#6), then withdrawn pending HungaroControl's written consent; its parsers stay, tested on synthetic fixtures (#32).
- Data permissions: where each source stands, attribution "Source: AIP Romania © ROMATSA", what GPL-3.0 covers (#34).
- OpenAP performance data source and GPL-3.0 licence documented (#15).

### Build, tests and CI
- Single-file build deployed to GitHub Pages from CI (#4).
- Coverage gate, test strategy, README screenshots and GIF (#9, #19); bundled fonts and test counts checked against the docs (#26).
- Vite 8, Vitest 5, Dependabot (#27); dependency updates (#28, #30).
- CI runners pinned to ubuntu-24.04, Chromium installed without apt (#38).
- `main` protected; CLAUDE.md notes it (#13).
- User guide with reproducible screenshots (`npm run guide:shots`) and this changelog.
