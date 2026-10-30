// UI wiring: header controls, panel tabs, priorities, aircraft commands,
// injects, log, debrief. All simulation state lives in the Sim instance.
import { COUNTRIES } from '../data/countries.js';
import { loadCountry } from './country.js';
import { fmtFL, fmtT, dist } from './geo.js';
import { Sim, TYPES, DIFF } from './sim.js';
import { buildLocalScenario, buildClaudePrompt, parseClaudeScenario } from './scenario.js';
import { Renderer } from './render.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const loaded = {};
const countryData = code => (loaded[code] ||= loadCountry(COUNTRIES.find(c => c.code === code).data));
let C = countryData(COUNTRIES.find(c => !c.planned).code);
const sim = new Sim(C);
const R = new Renderer($('scope'), sim);
const ui = { running: false, speed: 1, debriefShown: false, acBoxFor: null, acBoxSig: '', lastPanel: 0, toastT: 0 };
window.__sim = sim; // handy for e2e tests and console debugging
window.__radar = R;

/* ---------- session control ---------- */
function readCfg() {
  return {
    sector: $('sector').value, difficulty: $('difficulty').value, duration: +$('duration').value,
    seed: (+$('seed').value | 0) || 1, objective: $('objective').value.trim() || 'General radar handling.'
  };
}
function applyScenario(scn) {
  $('sector').value = scn.sector; $('difficulty').value = scn.difficulty; $('duration').value = String(scn.duration);
  startSession(scn);
  renderScenarioCard();
  switchTab('live');
}
function startSession(scn = sim.scenario) {
  sim.load(scn);
  ui.debriefShown = false; R.sel = null; ui.acBoxFor = -1; R.resetLabels();
  setRunning(false);
  $('pausedTag').hidden = false;
  $('pausedTitle').textContent = 'Scenario ready';
  $('pausedSub').textContent = `${sim.ac.length} aircraft loaded in ${sim.sector.name}. Read the injects, then start.`;
  R.fitSector();
  updatePanel(true);
}
function setRunning(r) {
  ui.running = r;
  $('playBtn').textContent = r ? 'Pause' : (sim.t > 0 ? 'Resume' : 'Start');
  $('playBtn').classList.toggle('primary', !r);
  if (r) $('pausedTag').hidden = true;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(ui.toastT); ui.toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
function result(r) { if (r && !r.ok && r.msg) toast(r.msg); updatePanel(true); }

/* ---------- Claude (only inside a claude.ai artifact viewer) ---------- */
let sampleFn = null;
async function initClaude() {
  try {
    if (!window.claude || !window.claude.use) return;
    sampleFn = await window.claude.use('sample');
    if (sampleFn) {
      $('buildAI').hidden = false;
      $('aiNote').textContent = 'Generate with Claude writes the scenario from your objective using your Claude account. The injects it picks run in the simulator.';
    }
  } catch { sampleFn = null; }
}
async function buildWithClaude() {
  const cfg = readCfg(), btn = $('buildAI'), old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const j = await sampleFn.json(buildClaudePrompt(C, cfg), { cache: false });
    applyScenario(parseClaudeScenario(j, cfg));
  } catch (e) {
    const code = e && e.code;
    if (code === 'not_granted' || code === 'sampling_disabled') btn.hidden = true;
    $('aiNote').textContent = code === 'rate_limited' ? 'Claude is busy for your account right now. The local builder still works.' : 'Claude could not build this one, so the local builder made it instead.';
    applyScenario(buildLocalScenario(C, cfg));
  } finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------- panel ---------- */
function updatePanel(force) {
  if (!force && performance.now() - ui.lastPanel < 500) return;
  ui.lastPanel = performance.now();
  const scn = sim.scenario;
  $('clock').innerHTML = `${fmtT(sim.t)} <small>/ ${fmtT(scn.duration * 60)}</small>`;
  $('secName').textContent = `${sim.sector.name} · ${sim.sector.rad}`;
  $('stIn').textContent = sim.ac.filter(a => a.lastIn).length;
  $('stInb').textContent = sim.ac.filter(a => a.ctl === 'pend').length;
  const pred = sim.stca.filter(c => c.level === 'pred').length, los = sim.stca.filter(c => c.level === 'los').length;
  $('stStca').innerHTML = los ? `<span style="color:var(--alert)">${los} LoS</span>` : `<span style="color:${pred ? 'var(--warn)' : 'var(--text)'}">${pred}</span>`;
  const next = scn.injects.find(i => i.status === 'pending');
  $('stNext').textContent = next ? fmtT(next.min * 60 - sim.t) : '—';

  const pr = sim.priorities();
  $('prio').innerHTML = pr.length ? pr.slice(0, 10).map(it => `<div class="pi p${it.p}" data-ac="${it.ac ? it.ac.id : ''}"><span class="lvl">P${it.p}</span><div class="t"><b>${esc(it.h)}</b><span>${esc(it.s)}</span></div><div class="acts">${actButtons(it)}</div></div>`).join('') : '<div class="empty">No open items. Keep scanning the sector.</div>';

  renderAcBox();
  $('injCount').textContent = `${scn.injects.filter(i => i.status === 'fired').length}/${scn.injects.length} fired`;
  $('injList').innerHTML = scn.injects.map((i, k) => `<div class="inj-row ${i.status}"><span class="tm">${String(i.min).padStart(2, '0')}:00</span><div class="tx"><b>${esc(TYPES[i.type])}${i.target ? ' · ' + esc(i.target) : ''}</b>${esc(i.text)}</div>${i.status === 'pending' ? `<button class="btn sm" data-fire="${k}">Fire now</button>` : `<span class="tag on">fired ${fmtT(i.firedAt)}</span>`}</div>`).join('');
  $('log').innerHTML = sim.logs.slice(0, 40).map(l => `<div class="${l.cls}"><b>${fmtT(l.t)}</b> ${esc(l.text)}</div>`).join('') || '<div>Nothing yet.</div>';
}

function actButtons(it) {
  const id = it.ac && it.ac.id, b = (a, label, cls = '') => `<button class="btn sm ${cls}" data-a="${a}" data-id="${id}">${label}</button>`;
  if (it.act === 'req') return it.ac.req && it.ac.req.kind === 'coord' ? b('ok', 'Accept') + b('no', 'Refuse') : b('ok', 'Approve') + b('no', 'Unable');
  if (it.act === 'ack') return b('ack', 'Ack', 'warn');
  if (it.act === 'assume') return b('assume', 'Assume', 'primary');
  if (it.act === 'xfer') return b('xfer', 'Transfer');
  return '';
}
const CTL = { none: 'NOT CONCERNED', pend: 'PENDING', ass: 'ASSUMED', xfer: 'TRANSFERRED' };

function renderAcBox() {
  const a = sim.get(R.sel);
  if (!a) {
    if (ui.acBoxFor !== null) { $('acBox').innerHTML = '<div class="empty">Click an aircraft on the radar or a priority item to issue clearances.</div>'; ui.acBoxFor = null; }
    return;
  }
  const sig = `${a.id}|${a.req ? a.req.text : ''}|${a.rcf}|${a.emg}${a.emgAck}|${a.ctl}${a.noXfer}|${a.xfl}`;
  if (ui.acBoxFor === a.id && sig === ui.acBoxSig) { updateKv(a); return; }
  ui.acBoxFor = a.id; ui.acBoxSig = sig;
  const lvls = []; for (let f = 100; f <= 410; f += 10) lvls.push(f);
  const pts = [...a.route.slice(a.ri).map(w => w.id), ...C.pointList.filter(p => dist(p.xy, [a.x, a.y]) < 150).map(p => p.id)];
  $('acBox').innerHTML = `<div class="ac-card">
    <div class="ac-head"><b>${esc(a.cs)}</b><span>${esc(a.type)} · ${esc(a.entry)} → ${esc(a.exit)} · ${a.cat.toUpperCase()}</span></div>
    <div class="row-btns" id="acCtl"><span class="note" style="flex:1;min-width:0">${a.noXfer && a.ctl === 'none' ? 'NOT TRANSFERRED by the previous sector' : CTL[a.ctl]}${a.xfl !== null ? ` · agreed exit FL${fmtFL(a.xfl)}` : ''}</span>${a.ctl === 'pend' || a.noXfer ? `<button class="btn sm primary" data-a="assume" data-id="${a.id}">Assume</button>` : a.ctl === 'ass' ? `<button class="btn sm" data-a="xfer" data-id="${a.id}">Transfer</button>` : ''}</div>
    <div class="kv" id="acKv"></div>
    ${a.req ? `<div class="row-btns"><span class="note" style="flex:1;min-width:0">${esc(a.req.text)}</span><button class="btn sm primary" data-a="ok" data-id="${a.id}">${a.req.kind === 'coord' ? 'Accept' : 'Approve'}</button><button class="btn sm" data-a="no" data-id="${a.id}">${a.req.kind === 'coord' ? 'Refuse' : 'Unable'}</button></div>` : ''}
    ${a.emg && !a.emgAck ? `<div class="row-btns"><button class="btn sm warn" data-a="ack" data-id="${a.id}">Acknowledge emergency</button></div>` : ''}
    ${a.rcf ? '<div class="note warn">No two-way contact. Clearances will not be read back.</div>' : ''}
    <div class="cmds">
      <label for="cFl">Level</label><select id="cFl">${lvls.map(f => `<option value="${f}" ${f === Math.round(a.cfl) ? 'selected' : ''}>FL${fmtFL(f)}</option>`).join('')}</select><button class="btn sm" id="bFl">Clear</button>
      <label for="cHdg">Heading</label><input type="number" id="cHdg" min="1" max="360" value="${Math.round(a.hdg) || 360}"><button class="btn sm" id="bHdg">Turn</button>
      <label for="cDct">Direct</label><input type="text" id="cDct" list="dctList" value="${esc(a.route[a.ri] ? a.route[a.ri].id : '')}" autocomplete="off"><button class="btn sm" id="bDct">Direct</button>
      <label for="cSpd">Speed</label><input type="number" id="cSpd" step="10" value="${Math.round(a.tgs)}"><button class="btn sm" id="bSpd">Set</button>
    </div>
    <datalist id="dctList">${[...new Set(pts)].map(p => `<option value="${p}">`).join('')}</datalist>
    <div class="row-btns"><button class="btn sm" id="bOwn">Resume own navigation</button></div>
  </div>`;
  updateKv(a);
  const id = a.id;
  $('bFl').onclick = () => result(sim.clearLevel(id, +$('cFl').value));
  $('bHdg').onclick = () => result(sim.turn(id, +$('cHdg').value));
  $('bDct').onclick = () => result(sim.direct(id, $('cDct').value));
  $('bSpd').onclick = () => result(sim.speed(id, +$('cSpd').value));
  $('bOwn').onclick = () => result(sim.resumeNav(id));
}
function updateKv(a) {
  const k = $('acKv'); if (!k) return;
  const w = a.route[a.ri];
  k.innerHTML = `<div><span>FL</span>${fmtFL(a.fl)}</div><div><span>CFL</span>${fmtFL(a.cfl)}${a.bust ? ' <b style="color:var(--alert)">≠' + fmtFL(a.sfl) + '</b>' : ''}</div><div><span>GS</span>${Math.round(a.gs)}</div><div><span>HDG</span>${String(Math.round(a.hdg) || 360).padStart(3, '0')}</div><div><span>Next</span>${w ? w.id : '—'}</div><div><span>Dist</span>${w ? Math.round(dist([a.x, a.y], w.xy)) + ' NM' : '—'}</div><div><span>Mode</span>${a.mode === 'nav' ? 'OWN NAV' : 'HDG'}</div><div><span>SSR</span>${a.sq}</div><div><span>XFL</span>${a.xfl === null ? '—' : fmtFL(a.xfl) + (a.ctl === 'ass' && Math.round(a.cfl) !== a.xfl ? ' <b style="color:var(--warn)">≠CFL</b>' : '')}</div><div><span>Exit</span>${a.ctl === 'ass' && a.tExit !== null ? fmtT(a.tExit) : a.tEntry !== null ? 'in ' + fmtT(a.tEntry) : '—'}</div>`;
}

function renderScenarioCard() {
  const s = sim.scenario;
  $('scnSource').textContent = s.source === 'claude' ? 'written by Claude' : 'built locally';
  $('scnCard').innerHTML = `<div class="scn">
    <h3>${esc(s.title)}</h3>
    <div class="meta"><span class="tag">${esc(C.sectors[s.sector].name)}</span><span class="tag">${esc(DIFF[s.difficulty].label)}</span><span class="tag">${s.duration} min</span><span class="tag">seed ${s.seed}</span><span class="tag">${s.conflicts} built-in conflicts</span></div>
    <p>${esc(s.objective)}</p>
    <h4>Key challenges</h4><ul>${s.challenges.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    <h4>Injects</h4><ul>${s.injects.map(i => `<li><b style="font-family:var(--f-data);font-weight:500;color:var(--warn)">${String(i.min).padStart(2, '0')}:00</b> ${esc(TYPES[i.type])}: ${esc(i.text)}</li>`).join('')}</ul>
    <h4>Success criteria</h4><ul>${s.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
  </div>`;
}

export function nextAirac(d, ref = Date.UTC(2026, 9, 1)) {
  let t = ref;
  while (t <= d.getTime()) t += 28 * 864e5;
  return new Date(t);
}
function renderDataTab() {
  const m = C.meta;
  $('airacTag').textContent = `eAIP ${m.airac.edition}`;
  const rows = [
    ['FIR', `${m.firName} (${m.fir}) · ${m.unit}`],
    ['Sectors', `${C.elementary.length} elementary + ${C.sectorList.length - C.elementary.length} collapsed · ${m.airac.sectors}`],
    ['Navaids', `${C.navaids.length} VOR/DME · ENR 4.1, ${m.airac.enr41}`],
    ['FRA points', `${C.pointList.length} of the ENR 4.4 list, with entry/exit roles · ${m.airac.enr44}`],
    ['Aerodromes', `${C.airportList.length} reference points`],
    ['Next AIRAC', `${nextAirac(new Date()).toISOString().slice(0, 10)}. Re-check the eAIP for amendments on or after this date.`]
  ];
  $('dataList').innerHTML = rows.map(d => `<div><span>${esc(d[0])}</span><span>${esc(d[1])}</span></div>`).join('') +
    `<div><span>Links</span><span>${m.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join('<br>')}</span></div>`;
  $('simNote').textContent = m.simNote || '';
  $('roadmap').innerHTML = COUNTRIES.map(c => `<div><span>${esc(c.name)}</span><span class="tag ${c.planned ? '' : 'on'}">${c.planned ? 'planned' : 'available'}</span></div>`).join('');
  $('schema').textContent = `data/<CODE>/
  meta.json      fir, center, defaultSector, airac, simNote, sources
  sectors.json   sectors[{id, rad, name, vert, poly:["DMS", {b:"KEY"}]}], collapsed[]
  borders.json   KEY: [[lat, lon], ...]   (border vertices)
  navaids.json   [{id, name, freq, pos:"DMS"}]   ENR 4.1
  points.json    [{id, pos:"DMS", role:E|X|EX|L|I}]   ENR 4.4
  airports.json  [{icao, name, pos:"DMS"}]
  traffic.json   gates, flows, operators, mainAirports[{icao, approach, handoffNM, arr, dep}], exitLevels{gates, arrivals, app}
  map.json       neighbours, coast`;
}

function switchTab(t) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === t);
  for (const p of ['live', 'scenario', 'data']) $('pane-' + p).hidden = p !== t;
}

function showDebrief() {
  const d = sim.debrief(), scn = sim.scenario;
  const items = [
    ['Losses of separation', d.losCount, d.losCount ? 'a' : ''],
    ['Time below minima', fmtT(d.losSec), d.losSec ? 'a' : ''],
    ['Closest pair', d.minSep === null ? '—' : d.minSep.toFixed(1) + ' NM', d.minSep !== null && d.minSep < 5 ? 'a' : ''],
    ['Requests answered', `${d.reqAnswered}/${d.reqs}`, d.reqMissed ? 'w' : ''],
    ['Avg. response', d.avgResponse === null ? '—' : d.avgResponse + ' s', d.avgResponse !== null && d.avgResponse > 60 ? 'w' : ''],
    ['Weather self-deviations', d.selfDev, d.selfDev ? 'w' : ''],
    ['TSA infringements', d.tsaInf, d.tsaInf ? 'a' : ''],
    ['Late assumes', d.lateAssume, d.lateAssume ? 'w' : ''],
    ['Late transfers', d.lateXfer, d.lateXfer ? 'w' : ''],
    ['Wrong exit levels', d.wrongXfl, d.wrongXfl ? 'a' : ''],
    ['Clearances issued', d.cmds, ''],
    ['Injects fired', `${d.injectsFired}/${d.injectsTotal}`, '']
  ];
  $('debStats').innerHTML = items.map(i => `<div class="stat"><div class="k">${esc(i[0])}</div><div class="v" style="color:${i[2] === 'a' ? 'var(--alert)' : i[2] === 'w' ? 'var(--warn)' : 'var(--text)'}">${esc(String(i[1]))}</div></div>`).join('');
  $('debNotes').textContent = `Scenario "${scn.title}", seed ${scn.seed}. Success criteria: ${scn.criteria.join('; ')}.`;
  $('debrief').hidden = false;
}

/* ---------- input ---------- */
function bindInput() {
  const cv = $('scope');
  let drag = null;
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    // pressing on a data block (not a track symbol) drags that label; anywhere else pans the scope
    const label = R.plotAt(mx, my) ? null : R.labelAt(mx, my);
    drag = { x: e.clientX, y: e.clientY, cx: R.V.cx, cy: R.V.cy, moved: false, label, from: label === null ? null : R.labelOffset(label) };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.label !== null) R.moveLabel(drag.label, drag.from[0] + dx, drag.from[1] + dy);
    else { R.V.cx = drag.cx - dx / R.V.sc; R.V.cy = drag.cy - dy / R.V.sc; }
  });
  cv.addEventListener('pointerup', e => {
    if (drag && !drag.moved) {
      const r = cv.getBoundingClientRect();
      const a = R.hitTest(e.clientX - r.left, e.clientY - r.top);
      R.sel = a ? a.id : null; ui.acBoxFor = -1; updatePanel(true);
    }
    drag = null;
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    R.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  $('zoomIn').onclick = () => { R.V.sc = Math.min(12, R.V.sc * 1.25); };
  $('zoomOut').onclick = () => { R.V.sc = Math.max(0.3, R.V.sc / 1.25); };
  $('fitSector').onclick = () => R.fitSector();
  $('fitFir').onclick = () => R.fitFir();

  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (b) {
      const id = +b.dataset.id;
      if (b.dataset.a === 'assume') result(sim.assume(id));
      if (b.dataset.a === 'xfer') result(sim.transfer(id));
      if (b.dataset.a === 'ok') result(sim.answer(id, true));
      if (b.dataset.a === 'no') result(sim.answer(id, false));
      if (b.dataset.a === 'ack') result(sim.ackEmergency(id));
      return;
    }
    const f = e.target.closest('button[data-fire]');
    if (f) { sim.fireNow(+f.dataset.fire); updatePanel(true); return; }
    const pi = e.target.closest('.pi');
    if (pi && pi.dataset.ac) {
      R.sel = +pi.dataset.ac; ui.acBoxFor = -1;
      const a = sim.get(R.sel); if (a) R.centreOn(a);
      updatePanel(true);
    }
  });

  const defs = [['sectors', 'Sectors'], ['points', 'FRA E/X'], ['navaids', 'VOR'], ['airports', 'Aerodromes'], ['labels', 'All labels'], ['vec', 'Vector 2 min']];
  $('layerChips').innerHTML = defs.map(d => `<button class="chip" data-l="${d[0]}" aria-pressed="true">${d[1]}</button>`).join('');
  $('layerChips').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const l = b.dataset.l, L = R.layers;
    if (l === 'points') {
      L.points = L.points === 'ex' ? 'all' : L.points === 'all' ? 'off' : 'ex';
      b.textContent = L.points === 'ex' ? 'FRA E/X' : L.points === 'all' ? 'FRA all' : 'FRA off';
      b.setAttribute('aria-pressed', L.points !== 'off');
    } else if (l === 'vec') { L.vec = L.vec === 1 ? 2 : L.vec === 2 ? 3 : 1; b.textContent = `Vector ${L.vec} min`; }
    else { L[l] = !L[l]; b.setAttribute('aria-pressed', L[l]); }
  };

  document.querySelector('.tabs').onclick = e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };
  $('playBtn').onclick = () => { if (sim.ended) startSession(); setRunning(!ui.running); };
  $('pausedStart').onclick = () => setRunning(true);
  $('restartBtn').onclick = () => startSession();
  $('speedSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    ui.speed = +b.dataset.s;
    for (const x of $('speedSeg').children) x.setAttribute('aria-pressed', x === b);
  };
  $('buildLocal').onclick = () => applyScenario(buildLocalScenario(C, readCfg()));
  $('buildAI').onclick = () => buildWithClaude();
  $('newSeed').onclick = () => { $('seed').value = 1000 + Math.floor(Math.random() * 9000); };
  $('sector').onchange = () => applyScenario(buildLocalScenario(C, readCfg()));
  $('difficulty').onchange = () => applyScenario(buildLocalScenario(C, readCfg()));
  $('debRestart').onclick = () => { $('debrief').hidden = true; startSession(); };
  $('debNew').onclick = () => { $('debrief').hidden = true; $('seed').value = 1000 + Math.floor(Math.random() * 9000); applyScenario(buildLocalScenario(C, readCfg())); };
  $('debClose').onclick = () => { $('debrief').hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
  });
}

/* ---------- country ---------- */
function setCountry(code) {
  C = countryData(code); sim.C = C;
  $('country').value = code;
  $('firTag').textContent = `${C.meta.fir} · ${C.meta.unit}`;
  const opts = [...C.sectorList.map(s => [s.id, `${s.name} (${s.rad})`]), ['FIR', 'Whole FIR']];
  $('sector').innerHTML = opts.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('');
  $('sector').value = C.meta.defaultSector || C.sectorList[0].id;
  renderDataTab();
}

/* ---------- boot ---------- */
function boot() {
  $('country').innerHTML = COUNTRIES.map(c => `<option value="${c.code}" ${c.planned ? 'disabled' : ''}>${esc(c.name)}${c.planned ? ' — planned' : ''}</option>`).join('');
  $('country').onchange = () => { setCountry($('country').value); applyScenario(buildLocalScenario(C, readCfg())); };
  setCountry(C.meta.code);
  bindInput();
  applyScenario(buildLocalScenario(C, readCfg()));
  new ResizeObserver(() => R.resize()).observe($('scope'));
  initClaude();

  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (ui.running && !sim.ended) {
      acc += dt * ui.speed;
      let n = 0;
      while (acc >= 1 && n < 40) { sim.step(); acc -= 1; n++; }
    }
    if (sim.ended && !ui.debriefShown) { ui.debriefShown = true; setRunning(false); updatePanel(true); showDebrief(); }
    R.draw();
    updatePanel(false);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
boot();
