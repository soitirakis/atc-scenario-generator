// UI wiring: header controls, panel tabs, priorities, aircraft commands,
// injects, log, debrief. All simulation state lives in the Sim instance.
//
// Roles (?role=…): solo (default, one window), instructor (owns the Sim, adds the
// inject timeline, pseudo-pilot and live grading) and trainee (no Sim: shows the
// instructor's snapshots and sends clearances back over src/link.js).
import { COUNTRIES } from '../data/countries.js';
import { loadCountry, sectorLabel } from './country.js';
import { fmtFL, fmtT, dist } from './geo.js';
import { Sim, TYPES, DIFF } from './sim.js';
import { buildLocalScenario, buildClaudePrompt, parseClaudeScenario, exportScenario, validateScenarioFile } from './scenario.js';
import { LIBRARY } from '../data/scenarios/index.js';
import { parseCommand, completeCallsign } from './cmdline.js';
import { Renderer } from './render.js';
import { Link, SimView, makeSnapshot, CHANNEL_NAME } from './link.js';
import { tasToMach, machToCas } from './atmos.js';
import { buildRecord, readImport, summary, debriefOf, bundle, recordFileName, pdfFileName, upgradeRecord, statRows, SNAPSHOT_MAX } from './records.js';
import { buildDebriefPdf } from './pdf.js';
import { openRecords } from './store.js';
import PERF from '../data/performance.json';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLE = (r => (r === 'instructor' || r === 'trainee' ? r : 'solo'))(new URLSearchParams(location.search).get('role'));
document.body.dataset.role = ROLE;

const loaded = {};
const countryData = code => (loaded[code] ||= loadCountry(COUNTRIES.find(c => c.code === code).data));
let C = countryData(COUNTRIES.find(c => !c.planned).code);
const link = ROLE === 'solo' ? null : new Link(new BroadcastChannel(CHANNEL_NAME), ROLE);
const sim = ROLE === 'trainee' ? new SimView(link, countryData) : new Sim(C);
const R = new Renderer($('scope'), sim);
const ui = { lastRecord: null, viewRecord: null, snaps: [], tlSeen: 0, running: false, speed: 1, debriefShown: false, acBoxFor: null, acBoxSig: '', lastPanel: 0, toastT: 0, session: 0, lastPub: 0, editInj: null, ppFor: null, ppSig: '' };
// session records (src/records.js) in IndexedDB (src/store.js); the trainee window has no Sim, so it keeps none
let records = null;
const recordsReady = ROLE === 'trainee' ? Promise.resolve(null) : openRecords().then(s => { records = s; return s; });
window.__sim = sim; // handy for e2e tests and console debugging
window.__radar = R;
window.__link = link;

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
  ui.session++; ui.editInj = null; ui.lastRecord = null; ui.snaps = []; ui.tlSeen = 0;
  ui.debriefShown = false; R.sel = null; ui.acBoxFor = -1; R.resetLabels();
  setRunning(false);
  $('pausedTag').hidden = false;
  $('pausedTitle').textContent = 'Scenario ready';
  $('pausedSub').textContent = `${sim.ac.length} aircraft loaded in ${sim.sector.name}. Read the injects, then start.`;
  R.fitSector();
  updatePanel(true);
  publish();
}
function setRunning(r) {
  ui.running = r;
  // the instructor freezes the session for both windows
  $('playBtn').textContent = ROLE === 'instructor' ? (r ? 'Freeze' : sim.t > 0 ? 'Unfreeze' : 'Start') : r ? 'Pause' : (sim.t > 0 ? 'Resume' : 'Start');
  $('playBtn').classList.toggle('primary', !r);
  if (r) $('pausedTag').hidden = true;
  publish();
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(ui.toastT); ui.toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
/** Commands return { ok, msg }; in the trainee window they return a promise of it. */
function result(r) {
  Promise.resolve(r).then(x => { if (x && !x.ok && x.msg) toast(x.msg); updatePanel(true); publish(); });
}

/* ---------- two windows ---------- */
/** Instructor: send the trainee window what a controller may see. */
function publish() {
  if (ROLE !== 'instructor' || !sim.scenario) return;
  ui.lastPub = performance.now();
  link.publish(makeSnapshot(sim, { session: ui.session, running: ui.running, speed: ui.speed }));
}
const roleUrl = role => `${location.pathname}?role=${role}`;
function openTrainee() { window.open(roleUrl('trainee'), 'atc-trainee'); }
function initLink() {
  if (ROLE === 'instructor') {
    link.serve((name, args) => {
      const r = sim[name](...args);
      queueMicrotask(() => { updatePanel(true); publish(); }); // after the reply has gone out
      return r;
    });
    link.onHello = () => publish();
    $('openTrainee').onclick = openTrainee;
  }
  if (ROLE === 'trainee') {
    link.onSnapshot = snap => {
      const fresh = snap.session !== ui.session;
      sim.apply(snap);
      if (fresh) { // a new session in the instructor window
        ui.session = snap.session; ui.debriefShown = false; ui.acBoxFor = -1;
        setCountry(snap.country);
        $('sector').value = snap.sector; $('difficulty').value = snap.brief.difficulty;
        R.sel = null; R.resetLabels(); R.fitSector();
        renderScenarioCard();
      }
      ui.running = snap.running;
    };
    link.hello();
    setInterval(() => link.hello(), 2000);
    for (const id of ['country', 'sector', 'difficulty']) $(id).disabled = true;
  }
  $('roleTag').hidden = false;
  updateLinkState();
  setInterval(updateLinkState, 1000);
}
function updateLinkState() {
  const ok = ROLE === 'instructor' ? link.traineeSeen() : link.instructorSeen();
  $('roleTag').textContent = `${ROLE.toUpperCase()} · ${ok ? 'linked' : ROLE === 'instructor' ? 'no trainee window' : 'no instructor window'}`;
  $('roleTag').classList.toggle('off', !ok);
  if (ROLE === 'instructor') $('linkState').textContent = ok ? 'connected' : 'not connected';
  if (ROLE === 'trainee') traineeOverlay(ok);
}
/** Trainee: the overlay says why the clock is not running. */
function traineeOverlay(linked) {
  let title = null, sub = '';
  if (!sim.snap) { title = 'Waiting for the instructor'; sub = 'Open the instructor window on this computer. This window follows its session.'; }
  else if (!linked) { title = 'Instructor window not responding'; sub = 'The picture is frozen at the last update.'; }
  else if (!sim.snap.running && !sim.ended) {
    title = sim.t > 0 ? 'Frozen by the instructor' : 'Session ready';
    sub = sim.t > 0 ? 'Traffic is held. Wait for the instructor.' : `${sim.ac.length} aircraft in ${sim.sector.name}. The instructor will start the session.`;
  }
  $('pausedTag').hidden = title === null;
  if (title) { $('pausedTitle').textContent = title; $('pausedSub').textContent = sub; }
}

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
  if (ROLE !== 'trainee') $('stNext').textContent = next ? fmtT(next.min * 60 - sim.t) : '—';

  const pr = sim.priorities();
  $('prio').innerHTML = pr.length ? pr.slice(0, 10).map(it => `<div class="pi p${it.p}" data-ac="${it.ac ? it.ac.id : ''}"><span class="lvl">P${it.p}</span><div class="t"><b>${esc(it.h)}</b><span>${esc(it.s)}</span></div><div class="acts">${actButtons(it)}</div></div>`).join('') : '<div class="empty">No open items. Keep scanning the sector.</div>';

  const busy = sim.freqBusy();
  $('freqState').textContent = busy ? `frequency busy · ${sim.freq.cs}` : 'frequency free';
  $('freqState').classList.toggle('busy', busy);
  const md = sim.nets.mtcd;
  $('mtcdCount').textContent = md.length ? `${md.length} predicted, 20 min` : '20 min look-ahead';
  $('mtcd').innerHTML = md.length ? md.slice(0, 8).map(c => `<div class="mt" data-ac="${c.a}"><b>${fmtT(c.t)}</b><span>${esc(c.acs)} / ${esc(c.bcs)}</span><span>min ${c.minNM.toFixed(1)} NM at ${fmtT(c.tMin)}${c.dvFt ? `, ${c.dvFt} ft` : ''}</span></div>`).join('') : '<div class="empty">No conflicts predicted in the next 20 minutes.</div>';
  renderAcBox();
  if (ROLE === 'solo') {
    $('injCount').textContent = `${scn.injects.filter(i => i.status === 'fired').length}/${scn.injects.length} fired`;
    $('injList').innerHTML = scn.injects.map((i, k) => `<div class="inj-row ${i.status}"><span class="tm">${String(i.min).padStart(2, '0')}:00</span><div class="tx"><b>${esc(TYPES[i.type])}${i.target ? ' · ' + esc(i.target) : ''}</b>${esc(i.text)}${gradeLine(i)}</div>${i.status === 'pending' ? `<button class="btn sm" data-fire="${k}">Fire now</button>` : `<span class="tag on">fired ${fmtT(i.firedAt)}</span>`}</div>`).join('');
  }
  if (ROLE === 'instructor') renderInstructor();
  $('log').innerHTML = sim.logs.slice(0, 40).map(l => `<div class="${l.cls}"><b>${fmtT(l.t)}</b> ${esc(l.text)}</div>`).join('') || '<div>Nothing yet.</div>';
}

/** What-if level probe for the selected aircraft; in the trainee window it runs in the instructor's Sim. */
function probe(id, fl) {
  Promise.resolve(sim.probeLevel(id, fl)).then(r => {
    const out = $('probeOut');
    if (!out || !r) return;
    out.hidden = false;
    if (!r.ok) { out.className = 'probe-out err'; out.textContent = r.msg; return; }
    const lines = [...r.conflicts.map(c => `${c.cs}: loss in ${fmtT(c.t)}, min ${c.minNM.toFixed(1)} NM${c.dvFt ? ` / ${c.dvFt} ft` : ''} at ${fmtT(c.tMin)}`), ...r.areas.map(z => `enters ${z.id} in ${fmtT(z.tt)}`)];
    out.className = 'probe-out' + (lines.length ? ' warn' : ' ok');
    out.innerHTML = `<b>FL${fmtFL(r.fl)}</b> ${lines.length ? lines.map(esc).join('<br>') : 'no conflict or military area in the next 20 minutes'}`;
  });
}

function actButtons(it) {
  const id = it.ac && it.ac.id, b = (a, label, cls = '') => `<button class="btn sm ${cls}" data-a="${a}" data-id="${id}">${label}</button>`;
  if (it.act === 'notify') return b('notify', 'Notify MIL', 'warn');
  if (it.act === 'req') return it.ac.req && it.ac.req.kind === 'mil' ? b('ok', 'Acknowledge') : it.ac.req && it.ac.req.kind === 'coord' ? b('ok', 'Accept') + b('no', 'Refuse') : b('ok', 'Approve') + b('no', 'Unable');
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
  const sig = `${a.id}|${a.req ? a.req.text : ''}|${a.rcf}|${a.emg}${a.emgAck}|${a.ctl}${a.noXfer}|${a.xfl}|${a.oat ? Math.round(a.fl) + a.oat.phase + Math.round(a.gs / 10) : ''}`;
  if (ui.acBoxFor === a.id && sig === ui.acBoxSig) { if (!a.oat) updateKv(a); return; }
  ui.acBoxFor = a.id; ui.acBoxSig = sig;
  const lvls = []; for (let f = 100; f <= 410; f += 10) lvls.push(f);
  const pts = [...a.route.slice(a.ri).map(w => w.id), ...C.pointList.filter(p => dist(p.xy, [a.x, a.y]) < 150).map(p => p.id)];
  if (a.oat) { // military: shown for awareness, no clearances
    $('acBox').innerHTML = `<div class="ac-card"><div class="ac-head"><b>${esc(a.cs)}</b><span>${esc(a.type)}${a.oat.n > 1 ? ' x' + a.oat.n : ''} · OAT · ${a.oat.kind === 'qra' ? 'QRA ' + a.oat.phase : 'formation'}</span></div>
      <div class="note">Operational air traffic under military control. Not on your frequency: no clearances. ${a.oat.nonRvsm ? 'Non-RVSM: keep 2000 ft from FL290 up, 1000 ft below, or 5 NM.' : ''}</div>
      <div class="kv"><div><span>FL</span>${fmtFL(a.fl)}</div><div><span>Target FL</span>${fmtFL(a.sfl)}</div><div><span>GS</span>${Math.round(a.gs)}</div><div><span>TRK</span>${String(Math.round(a.trk) || 360).padStart(3, '0')}</div></div>
      ${a.req ? `<div class="row-btns"><span class="note" style="flex:1;min-width:0">${esc(a.req.text)}</span><button class="btn sm primary" data-a="ok" data-id="${a.id}">Acknowledge</button></div>` : ''}</div>`;
    return;
  }
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
      <label for="cSpd">IAS kt</label><input type="number" id="cSpd" step="5" value="${Math.round(machToCas(tasToMach(a.tas, a.fl * 100), a.fl * 100) / 5) * 5}"><button class="btn sm" id="bSpd">Set</button>
      <label for="cMach">Mach</label><input type="number" id="cMach" step="0.01" min="0.6" max="0.9" value="${tasToMach(a.tas, a.fl * 100).toFixed(2)}"><button class="btn sm" id="bMach">Set</button>
      <label for="cRate">Rate ft/min</label><span class="rate-in"><input type="number" id="cRate" step="100" min="500" max="6000" value="2000"><select id="cRateKind" aria-label="Rate limit"><option value="min">or greater</option><option value="max">or less</option></select></span><button class="btn sm" id="bRate">Set</button>
    </div>
    <datalist id="dctList">${[...new Set(pts)].map(p => `<option value="${p}">`).join('')}</datalist>
    <div class="row-btns"><button class="btn sm" id="bOwn">Resume own navigation</button><button class="btn sm" id="bNormSpd">Resume normal speed</button><button class="btn sm" id="bProbe" title="What if cleared to the level above: conflicts and military areas in the next 20 minutes">Probe level</button></div>
    <div class="probe-out" id="probeOut" hidden></div>
  </div>`;
  updateKv(a);
  const id = a.id;
  $('bFl').onclick = () => result(sim.clearLevel(id, +$('cFl').value));
  $('bHdg').onclick = () => result(sim.turn(id, +$('cHdg').value));
  $('bDct').onclick = () => result(sim.direct(id, $('cDct').value));
  $('bSpd').onclick = () => result(sim.speed(id, +$('cSpd').value));
  $('bMach').onclick = () => result(sim.mach(id, +$('cMach').value));
  $('bRate').onclick = () => result(sim.clearRate(id, +$('cRate').value, $('cRateKind').value));
  $('bNormSpd').onclick = () => result(sim.resumeSpeed(id));
  $('bOwn').onclick = () => result(sim.resumeNav(id));
  $('bProbe').onclick = () => probe(id, +$('cFl').value);
}
function updateKv(a) {
  const k = $('acKv'); if (!k) return;
  const w = a.route[a.ri];
  k.innerHTML = `<div><span>FL</span>${fmtFL(a.fl)}</div><div><span>CFL</span>${fmtFL(a.cfl)}${Math.round(a.sfl) !== Math.round(a.cfl) ? ' <b style="color:var(--alert)">≠' + fmtFL(a.sfl) + '</b>' : ''}</div><div><span>IAS</span>${Math.round(machToCas(tasToMach(a.tas, a.fl * 100), a.fl * 100))}${a.spd && a.spd.mode === 'ias' ? ' ✓' : ''}</div><div><span>Mach</span>${tasToMach(a.tas, a.fl * 100).toFixed(2).slice(1)}${a.spd && a.spd.mode === 'mach' ? ' ✓' : ''}</div><div><span>TAS</span>${Math.round(a.tas)}</div><div><span>GS</span>${Math.round(a.gs)}</div><div><span>HDG</span>${String(Math.round(a.hdg) || 360).padStart(3, '0')}</div><div><span>TRK</span>${String(Math.round(a.trk) || 360).padStart(3, '0')}</div><div><span>Rate</span>${a.rate ? a.rate.fpm + (a.rate.kind === 'min' ? '+' : '−') : '—'}</div><div><span>Next</span>${w ? w.id : '—'}</div><div><span>Dist</span>${w ? Math.round(dist([a.x, a.y], w.xy)) + ' NM' : '—'}</div><div><span>Mode</span>${a.mode === 'nav' ? 'OWN NAV' : 'HDG'}</div><div><span>SSR</span>${a.sq}</div><div><span>XFL</span>${a.xfl === null ? '—' : fmtFL(a.xfl) + (a.ctl === 'ass' && Math.round(a.cfl) !== a.xfl ? ' <b style="color:var(--warn)">≠CFL</b>' : '')}</div><div><span>Exit</span>${a.ctl === 'ass' && a.tExit !== null ? fmtT(a.tExit) : a.tEntry !== null ? 'in ' + fmtT(a.tEntry) : '—'}</div>`;
}

/* ---------- instructor ---------- */
function renderInstructor() {
  $('gradeStats').innerHTML = gradeItems(sim.debrief()).map(statHtml).join('');
  renderTimeline(false);
  renderPseudoPilot();
}
function renderTimeline(force) {
  const inj = sim.scenario.injects;
  $('tlCount').textContent = `${inj.filter(i => i.status === 'fired').length}/${inj.length} fired`;
  if (ui.editInj !== null && !force) return; // keep what the instructor is typing
  $('tlList').innerHTML = inj.map((i, k) => {
    const mm = String(i.min).padStart(2, '0');
    if (ui.editInj === k) return `<div class="inj-row"><div class="tl-edit">
      <input type="number" id="tlMin" aria-label="Minute" min="1" max="${sim.scenario.duration - 1}" value="${i.min}">
      <select id="tlType" aria-label="Inject type">${Object.entries(TYPES).map(([t, label]) => `<option value="${t}" ${t === i.type ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
      <input class="full" type="text" id="tlText" aria-label="Instructor note" value="${esc(i.text)}">
      <div class="row-btns full"><button class="btn sm primary" data-tl="save" data-i="${k}">Save</button><button class="btn sm" data-tl="cancel" data-i="${k}">Cancel</button></div>
    </div></div>`;
    const acts = i.status === 'fired' ? `<span class="tag on">fired ${fmtT(i.firedAt)}</span>`
      : [['fire', 'Fire'], i.status === 'held' ? ['release', 'Release'] : ['hold', 'Hold'], ['earlier', '−1′'], ['later', '+1′'], ['edit', 'Edit']]
        .map(([a, label]) => `<button class="btn sm" data-tl="${a}" data-i="${k}">${label}</button>`).join('');
    return `<div class="inj-row ${i.status}"><span class="tm">${mm}:00</span><div class="tx"><b>${esc(TYPES[i.type])}${i.target ? ' · ' + esc(i.target) : ''}${i.status === 'held' ? ' · held' : ''}</b>${esc(i.text)}${gradeLine(i)}</div><div class="tl-acts">${acts}</div></div>`;
  }).join('');
}
function timeline(action, k) {
  if (action === 'fire') sim.fireNow(k);
  if (action === 'hold' || action === 'release') result(sim.holdInject(k, action === 'hold'));
  if (action === 'earlier' || action === 'later') result(sim.delayInject(k, action === 'later' ? 1 : -1));
  if (action === 'edit') ui.editInj = k;
  if (action === 'cancel') ui.editInj = null;
  if (action === 'save') {
    const r = sim.editInject(k, { min: +$('tlMin').value, type: $('tlType').value, text: $('tlText').value });
    if (r.ok) ui.editInj = null;
    result(r);
  }
  renderTimeline(true);
  updatePanel(true);
}
function renderPseudoPilot() {
  const a = sim.get(R.sel);
  $('ppFor').textContent = a ? `speaking as ${a.cs}` : 'select an aircraft';
  const sig = a ? `${a.id}|${a.pilotNext}|${a.rcf > 0}|${a.req ? a.req.text : ''}|${a.sq}` : '';
  if (sig === ui.ppSig) return;
  ui.ppSig = sig;
  if (!a) { $('ppBox').innerHTML = '<div class="empty">Select an aircraft on the radar to speak as its pilot.</div>'; return; }
  const next = a.pilotNext || 'normal';
  $('ppBox').innerHTML = `<div class="pp">
    <div class="row-btns"><label for="ppKind">Request</label>
      <select id="ppKind"><option value="climb">Climb to FL</option><option value="descend">Descend to FL</option><option value="wx">Weather deviation, ° (− left)</option><option value="direct">Direct to point</option></select>
      <input type="text" id="ppVal" aria-label="Request value" value="${Math.min(410, Math.round(a.cfl) + 20)}"><button class="btn sm" data-pp="req">Ask</button></div>
    <div class="row-btns"><label>Next clearance</label>${[['normal', 'Comply'], ['refuse', 'Refuse'], ['query', 'Say again']].map(([m, label]) => `<button class="btn sm" data-pp="next-${m}" aria-pressed="${next === m}"${next === m ? ' style="border-color:var(--accent)"' : ''}>${label}</button>`).join('')}</div>
    <div class="row-btns"><label>Deviate</label><button class="btn sm" data-pp="left">20° left</button><button class="btn sm" data-pp="right">20° right</button></div>
    <div class="row-btns"><label for="ppSq">Squawk</label><input type="text" id="ppSq" maxlength="4" value="${esc(a.sq)}"><button class="btn sm" data-pp="squawk">Set</button></div>
    <div class="row-btns"><label>Radio</label>${a.rcf > 0 ? '<span class="note warn">silent</span><button class="btn sm" data-pp="back">Back on frequency</button>' : '<button class="btn sm" data-pp="silent">Go silent 2 min</button>'}</div>
    ${a.req ? `<div class="note">Open request: ${esc(a.req.text)}</div>` : ''}
  </div>`;
}
function pseudoPilot(action) {
  const a = sim.get(R.sel); if (!a) return;
  const run = {
    req: () => sim.pilotRequest(a.id, $('ppKind').value, $('ppVal').value),
    'next-normal': () => sim.pilotNextReply(a.id, null), 'next-refuse': () => sim.pilotNextReply(a.id, 'refuse'), 'next-query': () => sim.pilotNextReply(a.id, 'query'),
    left: () => sim.pilotDeviate(a.id, -20), right: () => sim.pilotDeviate(a.id, 20),
    squawk: () => sim.pilotSquawk(a.id, $('ppSq').value),
    silent: () => sim.pilotSilent(a.id, 120), back: () => sim.pilotSilent(a.id, 0)
  }[action];
  if (run) result(run());
  ui.ppSig = '';
}

/** Wind table (solo and instructor): four rows of level, direction, speed. */
function renderWind() {
  const rows = [...sim.wind];
  while (rows.length < 4) rows.push({ fl: '', dir: '', kt: '' });
  $('windTable').innerHTML = '<span>Level FL</span><span>From °</span><span>Speed kt</span>' + rows.map((w, i) =>
    `<input type="number" data-w="fl" data-i="${i}" aria-label="Wind level ${i + 1}" value="${w.fl}"><input type="number" data-w="dir" data-i="${i}" aria-label="Wind direction ${i + 1}" value="${w.dir}"><input type="number" data-w="kt" data-i="${i}" aria-label="Wind speed ${i + 1}" value="${w.kt}">`).join('');
}
function applyWind(calm) {
  const rows = [];
  if (!calm) for (let i = 0; i < 4; i++) {
    const v = k => document.querySelector(`#windTable input[data-w="${k}"][data-i="${i}"]`).value;
    if (v('fl') !== '' && v('kt') !== '') rows.push({ fl: +v('fl'), dir: +(v('dir') || 0), kt: +v('kt') });
  }
  const r = sim.setWind(rows);
  result(r);
  if (r.ok) { renderWind(); toast(calm ? 'Wind: calm' : 'Wind applied'); }
}

/* ---------- scenario files ---------- */
function ioMessage(lines, error = false) {
  const m = $('scnIoMsg');
  m.hidden = !lines.length;
  m.classList.toggle('err', error);
  m.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
}
/** Validate a scenario file, switch country if needed, and load it (the link sends it to the trainee window). */
function loadScenarioFile(j, source) {
  const r = validateScenarioFile(j, availableCountries());
  if (!r.ok) { ioMessage(['This scenario was not loaded:', ...r.errors], true); return false; }
  if (r.country !== C.meta.code) setCountry(r.country);
  r.scenario.source = source;
  $('seed').value = r.scenario.seed; $('objective').value = r.scenario.objective;
  ioMessage([]);
  applyScenario(r.scenario);
  toast(`Loaded: ${r.scenario.title}`);
  return true;
}
/** Save a JSON file through the browser's download. */
const download = (obj, filename) => downloadBlob(new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' }), filename);
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const availableCountries = () => Object.fromEntries(COUNTRIES.filter(c => !c.planned).map(c => [c.code, countryData(c.code)]));
function exportCurrent() {
  const j = exportScenario(sim.scenario, C.meta.code), name = `scenario-${j.country}-${j.sector}-${j.seed}.json`.toLowerCase();
  download(j, name);
  ioMessage([`Exported ${name}`]);
}
async function importFile(f) {
  let j;
  try { j = JSON.parse(await f.text()); } catch { ioMessage([`This scenario was not loaded:`, `${f.name} is not a JSON file.`], true); return; }
  loadScenarioFile(j, 'file');
}

function renderScenarioCard() {
  const s = sim.scenario;
  if (ROLE !== 'trainee') renderWind();
  if (ROLE === 'trainee') { // the briefing a controller gets: no title, challenges or injects
    $('scnSource').textContent = 'briefing';
    $('scnCard').innerHTML = `<div class="scn">
      <div class="meta"><span class="tag">${esc(sim.sector.name)}</span><span class="tag">${esc(DIFF[s.difficulty].label)}</span><span class="tag">${s.duration} min</span></div>
      <p>${esc(s.objective)}</p></div>`;
    return;
  }
  $('scnSource').textContent = { claude: 'written by Claude', library: 'from the library', file: 'imported from a file', record: 'replayed from a saved session' }[s.source] || 'built locally';
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
  const m = C.meta, A = m.airac || {}, aips = C.aips;
  $('airacTag').textContent = aips.length > 1 ? `${aips.length} eAIPs` : `eAIP ${aips[0].edition}`;
  const layered = C.elementary.filter(s => s.vol).length;
  const rows = [
    ['FIR', `${m.firName} (${m.fir}) · ${m.unit}${C.upperOnly ? ` · upper airspace only, from FL${C.upperOnly.lowerFL}` : ''}`],
    ['Sectors', `${C.elementary.length} elementary${layered ? ` (${layered} with vertical limits)` : ''} + ${C.sectorList.length - C.elementary.length} collapsed${A.sectors ? ' · ' + A.sectors : ''}`],
    ['Navaids', `${C.navaids.length} VOR/DME · ENR 4.1${A.enr41 ? ', ' + A.enr41 : ''}`],
    ['FRA points', `${C.pointList.length} of the ENR 4.4 list, with entry/exit roles${A.enr44 ? ' · ' + A.enr44 : ''}`],
    ['Aerodromes', `${C.airportList.length} reference points`],
    ['Performance', `OpenAP WRAP, ${Object.keys(PERF.types).length} aircraft types (GPL-3.0, commit ${PERF._source.commit.slice(0, 7)}). ISA atmosphere; wind per scenario.`],
    ['Next AIRAC', `${nextAirac(new Date()).toISOString().slice(0, 10)}. Re-check the eAIP for amendments on or after this date.`]
  ];
  // one row per source AIP: a module can be built from several states' AIPs
  rows.unshift(...aips.map(a => [aips.length > 1 ? `AIP ${a.state}` : 'AIP', `eAIP ${a.edition} · ${a.amendment}`]));
  $('dataList').innerHTML = rows.map(d => `<div><span>${esc(d[0])}</span><span>${esc(d[1])}</span></div>`).join('') +
    (aips.length > 1 ? `<div><span>eAIPs</span><span>${aips.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.state)}</a>`).join('<br>')}</span></div>` : '') +
    `<div><span>Links</span><span>${m.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join('<br>')}</span></div>`;
  $('simNote').textContent = m.simNote || '';
  $('roadmap').innerHTML = COUNTRIES.map(c => `<div><span>${esc(c.name)}${c.note ? ` <small>${esc(c.note)}</small>` : ''}</span><span class="tag ${c.planned ? '' : 'on'}">${c.planned ? 'planned' : 'available'}</span></div>`).join('');
  $('schema').textContent = `data/<CODE>/
  meta.json      fir, center, defaultSector, airac, simNote, sources, aips?[{state, url, edition, amendment}], upperOnly?{lowerLimit, lowerUnit}
  sectors.json   sectors[{id, rad, name, vert, lower?, upper?, group?, poly:["DMS", {b:"KEY", upTo?}], include?[], exclude?[]}], collapsed[{id, parts}]
  borders.json   KEY: [[lat, lon], ...]   (border vertices)
  navaids.json   [{id, name, freq, pos:"DMS"}]   ENR 4.1
  points.json    [{id, pos:"DMS", role:E|X|EX|L|I}]   ENR 4.4
  airports.json  [{icao, name, pos:"DMS"}]
  traffic.json   gates, flows, operators, mainAirports[{icao, approach, handoffNM | lowerUnit{name, handoffNM, arrFL, depFL}, arr, dep}], exitLevels{gates, arrivals, app}
  map.json       neighbours, coast`;
}

function switchTab(t) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === t);
  for (const p of ['live', 'scenario', 'history', 'data', 'instr']) $('pane-' + p).hidden = p !== t;
  if (t === 'history') renderHistory();
}

/* ---------- session records and history ---------- */
const fmtDate = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function histMessage(lines, error = false) {
  const m = $('histMsg');
  m.hidden = !lines.length; m.classList.toggle('err', error);
  m.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
}
/**
 * Radar snapshots for the record: at each inject and each loss of separation (timeline marks),
 * the radar as it is drawn, scaled to at most 800 px wide as JPEG. Called after every step.
 */
function captureEvents() {
  if (ROLE === 'trainee' || !sim.timeline) return;
  for (; ui.tlSeen < sim.timeline.length; ui.tlSeen++) {
    const e = sim.timeline[ui.tlSeen], kind = /^Loss of separation /.test(e.text) ? 'los' : / fired(,|$)/.test(e.text) ? 'inject' : null;
    if (!kind || ui.snaps.length >= SNAPSHOT_MAX) continue;
    const src = $('scope');
    if (!src.width || !src.height) continue;
    R.draw();
    const w = Math.min(800, src.width), h = Math.round((src.height * w) / src.width), c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    ui.snaps.push({ t: e.t, kind, label: e.text, image: c.toDataURL('image/jpeg', 0.72), w, h });
  }
}
/** At the end of a session: build its record, keep it for the debrief's Export, and save it. */
async function saveRecord() {
  captureEvents();
  const rec = buildRecord(sim, { country: sim.C.meta.code, trainee: $('traineeName').value, instructor: $('instructorName').value, snapshots: ui.snaps });
  ui.lastRecord = rec;
  try { await (await recordsReady).put(rec); } catch (e) { histMessage([`This session was not saved (${e.message}). Export it from the debrief to keep it.`], true); }
  renderHistory();
}
async function renderHistory() {
  if (ROLE === 'trainee') return;
  const store = await recordsReady, list = (await store.list()).map(upgradeRecord);
  $('histStore').textContent = store.available
    ? 'Saved in this browser only, with no login or server. Export to keep a copy or to move sessions to another computer.'
    : `Session history is not available: ${store.reason} Sessions are kept only until this page closes. Use Export record in the debrief, or Export all, to keep them.`;
  $('histStore').classList.toggle('warn', !store.available);
  $('histCount').textContent = list.length ? `${list.length} session${list.length > 1 ? 's' : ''}` : '';
  $('histList').innerHTML = list.length ? list.map(r => `<div class="hist-row" data-id="${esc(r.id)}">
      <div class="hist-head"><b>${fmtDate(r.savedAt)}</b><span>${esc(r.trainee || 'No trainee name')}${r.instructor ? ' · instructor ' + esc(r.instructor) : ''}</span></div>
      <div>${esc(r.scenario.title)}</div>
      <div class="hist-sum">${esc(r.country)} ${esc(r.sectorName)} · seed ${r.seed} · ${esc(summary(r).text)}</div>
      <div class="row-btns"><button class="btn sm" data-h="open">Open</button><button class="btn sm" data-h="pdf">Download PDF</button><button class="btn sm" data-h="export">Export</button><button class="btn sm" data-h="del">Delete</button></div>
    </div>`).join('') : '<div class="empty">No sessions yet. A session is saved here when it ends.</div>';
}
async function historyClick(e) {
  const b = e.target.closest('button[data-h]'), row = b && b.closest('.hist-row');
  if (!row) return;
  const store = await recordsReady, rec = upgradeRecord(await store.get(row.dataset.id));
  if (!rec) { renderHistory(); return; }
  if (b.dataset.h === 'open') showDebrief(rec);
  if (b.dataset.h === 'pdf') downloadPdf(rec, histMessage);
  if (b.dataset.h === 'export') { download(rec, recordFileName(rec)); histMessage([`Exported ${recordFileName(rec)}`]); }
  if (b.dataset.h === 'del') {
    // two clicks: the first arms the button, the second deletes
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Confirm delete'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete'; } }, 4000); return; }
    await store.remove(rec.id); histMessage([`Deleted the session of ${fmtDate(rec.savedAt)}.`]); renderHistory();
  }
}
async function exportAll() {
  const list = await (await recordsReady).list();
  if (!list.length) { histMessage(['No sessions to export.']); return; }
  const name = `sessions-${new Date().toISOString().slice(0, 10)}.json`;
  download(bundle(list), name);
  histMessage([`Exported ${list.length} session${list.length > 1 ? 's' : ''} to ${name}`]);
}
/** The record's PDF debrief (src/pdf.js), built in the browser and downloaded. */
function downloadPdf(rec, say) {
  try {
    const C2 = availableCountries()[rec.country], name = pdfFileName(rec);
    downloadBlob(buildDebriefPdf(rec, { countryName: C2 && C2.meta.name }).output('blob'), name);
    say([`Downloaded ${name}`]);
  } catch (e) { say([`The PDF could not be built: ${e.message}`], true); }
}
/** Instructor remarks typed in the debrief: kept in the record shown and saved with it. */
let remarksTimer = 0;
function remarksChanged() {
  const rec = ui.viewRecord || ui.lastRecord;
  if (!rec) return;
  rec.remarks = $('debRemarks').value.slice(0, 4000);
  clearTimeout(remarksTimer);
  remarksTimer = setTimeout(async () => { try { await (await recordsReady).put(rec); } catch (e) { toast(`Remarks not saved: ${e.message}`); } }, 400);
}
async function importRecords(f) {
  let j;
  try { j = JSON.parse(await f.text()); } catch { histMessage([`${f.name} is not a JSON file.`], true); return; }
  const { records: ok, errors } = readImport(j, availableCountries()), store = await recordsReady;
  for (const r of ok) await store.put(r);
  histMessage([ok.length ? `Imported ${ok.length} session${ok.length > 1 ? 's' : ''} from ${f.name}.` : `Nothing was imported from ${f.name}:`, ...errors], !ok.length);
  renderHistory();
}

const gradeItems = statRows; // shared with the PDF debrief
/** One line under a fired inject: its objective result (instructor and solo only). */
function gradeLine(i) {
  const r = i.result;
  if (!r) return i.status === 'fired' ? '<span class="grade none" data-grade="none">Not graded: no suitable aircraft</span>' : '';
  const cls = r.state === 'not met' ? 'fail' : r.state;
  return `<span class="grade ${cls}" data-grade="${cls}"><b>${r.state === 'pending' ? 'Pending' : r.state === 'met' ? 'Met' : 'Not met'}${r.t === null ? '' : ' · ' + r.t + ' s'}</b> ${esc(r.reason)}</span>`;
}
function debriefInjects(d) {
  if (!d.injects || !d.injects.length) return '';
  const rows = d.injects.map(i => {
    const r = i.result, st = r ? r.state : i.status === 'fired' ? 'not graded' : 'not fired';
    const cls = st === 'met' ? 'met' : st === 'not met' ? 'fail' : st === 'pending' ? 'pending' : 'none';
    return `<tr><td>${i.firedAt === null ? String(i.min).padStart(2, '0') + ':00' : fmtT(i.firedAt)}</td><td>${esc(i.label)}${i.target ? ' · ' + esc(i.target) : ''}</td><td><span class="grade ${cls}"><b>${esc(st)}</b></span></td><td>${r && r.t !== null ? r.t + ' s' : '—'}</td><td>${esc(r ? r.reason : i.objective)}</td></tr>`;
  }).join('');
  const met = d.injects.filter(i => i.result && i.result.state === 'met').length, graded = d.injects.filter(i => i.result).length;
  return `<h4>Injects: ${met}/${graded} objectives met</h4><div class="deb-scroll"><table class="deb-table"><thead><tr><th>Time</th><th>Inject</th><th>Result</th><th>Measured</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function debriefTimeline(d) {
  if (!d.timeline || !d.timeline.length) return '';
  return `<h4>Timeline</h4><div class="deb-tl">${d.timeline.map(e => `<div class="${e.cls}"><b>${fmtT(e.t)}</b> ${esc(e.text)}</div>`).join('')}</div>`;
}
const statHtml = i => `<div class="stat"><div class="k">${esc(i[0])}</div><div class="v" style="color:${i[2] === 'a' ? 'var(--alert)' : i[2] === 'w' ? 'var(--warn)' : 'var(--text)'}">${esc(String(i[1]))}</div></div>`;
function debriefClearances(list) {
  if (!list || !list.length) return '';
  return `<h4>Clearances (${list.length})</h4><div class="deb-tl">${list.map(c => `<div class="${c.result === 'ok' ? '' : 'w'}"><b>${fmtT(c.t)}</b> ${esc(c.cs)} ${esc(c.text)}${c.result === 'ok' ? '' : ` <span class="clr-r">(${esc(c.result)})</span>`}</div>`).join('')}</div>`;
}
/** The debrief of the session that just ended, or of a saved record (Replay instead of Run again). */
function showDebrief(rec = null) {
  const d = rec ? debriefOf(rec) : sim.debrief(), scn = rec ? rec.scenario : sim.scenario;
  if (!d) return;
  ui.viewRecord = rec;
  $('debTitle').textContent = rec ? `Session debrief · ${fmtDate(rec.savedAt)}` : 'Session debrief';
  $('debStats').innerHTML = gradeItems(d).map(statHtml).join('');
  $('debInjects').innerHTML = debriefInjects(d);
  $('debTimeline').innerHTML = debriefTimeline(d);
  $('debClearances').innerHTML = debriefClearances(rec ? rec.clearances : sim.clearances);
  const who = rec ? [rec.trainee && `trainee ${rec.trainee}`, rec.instructor && `instructor ${rec.instructor}`].filter(Boolean).join(', ') : '';
  $('debNotes').textContent = ROLE === 'trainee' ? `Seed ${scn.seed}. Your instructor has the full scenario and the injects.`
    : `Scenario "${scn.title}"${rec ? `, ${rec.country} ${rec.sectorName}` : ''}, seed ${scn.seed}${who ? `, ${who}` : ''}. Success criteria: ${scn.criteria.join('; ')}.`;
  $('debRestart').hidden = $('debNew').hidden = !!rec;
  $('debReplay').hidden = !rec;
  $('debExport').hidden = $('debPdf').hidden = $('debRemarksBox').hidden = !rec && !ui.lastRecord;
  $('debRemarks').value = (rec || ui.lastRecord || { remarks: '' }).remarks;
  $('debrief').hidden = false;
}

/* ---------- input ---------- */
/* ---------- range-bearing line and SEP ---------- */
function setTool(mode) {
  R.tools.mode = mode; R.tools.first = null;
  $('toolRbl').setAttribute('aria-pressed', mode === 'rbl');
  $('toolSep').setAttribute('aria-pressed', mode === 'sep');
  if (mode) toast(mode === 'rbl' ? 'RBL: click a point or a track, then another' : 'SEP: click two tracks');
}
/** One click with a tool on: a track (if one is under the pointer) or a point on the map. */
function toolClick(ac, xy) {
  const T = R.tools;
  if (T.mode === 'sep' && !ac) { toast('SEP: click a track'); return; }
  const end = ac ? { ac: ac.id, xy: [ac.x, ac.y] } : { xy };
  if (!T.first) { T.first = end; return; }
  if (T.mode === 'rbl') T.rbl.push({ a: T.first, b: end });
  else if (end.ac !== T.first.ac) T.sep.push({ a: T.first.ac, b: end.ac });
  setTool(null);
}

/* ---------- command line ---------- */
const CMD_HELP = 'Tab completes the callsign. 370 level · H120 heading · D NERDI direct · M78 / S250 speed · R2000+ rate';
function cmdHint(text, cls = '') { const h = $('cmdHint'); h.textContent = text; h.className = 'note cmd-hint ' + cls; }
function sendCommand() {
  const text = $('cmdLine').value.trim();
  if (!text) return;
  const p = parseCommand(text, sim.ac.map(a => a.cs)); // checked here for an immediate answer; the Sim parses it again
  if (!p.ok) { cmdHint(p.error, 'err'); return; }
  Promise.resolve(sim.command(text)).then(r => {
    if (r && r.ok) { $('cmdLine').value = ''; cmdHint(CMD_HELP); } else cmdHint((r && r.msg) || 'Not sent', 'err');
    updatePanel(true); publish();
  });
}
function bindCommandLine() {
  const input = $('cmdLine');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendCommand(); return; }
    if (e.key === 'Escape') { input.value = ''; cmdHint(CMD_HELP); return; }
    if (e.key !== 'Tab' || /\s/.test(input.value.trim())) return; // Tab completes the first word only
    const m = completeCallsign(input.value, sim.ac.map(a => a.cs));
    if (!m.length) return;
    e.preventDefault();
    let common = m[0];
    for (const cs of m) while (!cs.startsWith(common)) common = common.slice(0, -1);
    input.value = m.length === 1 ? m[0] + ' ' : common;
    cmdHint(m.length === 1 ? CMD_HELP : m.join('  '));
  });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v || /\s/.test(v)) { if (!v) cmdHint(CMD_HELP); return; }
    const m = completeCallsign(v, sim.ac.map(a => a.cs));
    cmdHint(m.length ? m.slice(0, 8).join('  ') : `No callsign starting ${v.toUpperCase()}`, m.length ? '' : 'err');
  });
  $('cmdSend').onclick = sendCommand;
}

function bindInput() {
  bindCommandLine();
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
    if (drag && !drag.moved && R.tools.mode) {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      toolClick(R.hitTest(mx, my), R.toNM(mx, my));
      drag = null;
      return;
    }
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
  $('toolRbl').onclick = () => setTool(R.tools.mode === 'rbl' ? null : 'rbl');
  $('toolSep').onclick = () => setTool(R.tools.mode === 'sep' ? null : 'sep');
  $('toolClear').onclick = () => { R.tools.rbl = []; R.tools.sep = []; setTool(null); };
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
      if (b.dataset.a === 'notify') result(sim.notifyMil(id));
      return;
    }
    const tl = e.target.closest('button[data-tl]');
    if (tl) { timeline(tl.dataset.tl, +tl.dataset.i); return; }
    const pp = e.target.closest('button[data-pp]');
    if (pp) { pseudoPilot(pp.dataset.pp); return; }
    const f = e.target.closest('button[data-fire]');
    if (f) { sim.fireNow(+f.dataset.fire); updatePanel(true); return; }
    const pi = e.target.closest('.pi, .mt');
    if (pi && pi.dataset.ac) {
      R.sel = +pi.dataset.ac; ui.acBoxFor = -1;
      const a = sim.get(R.sel); if (a) R.centreOn(a);
      updatePanel(true);
    }
  });

  const defs = [['sectors', 'Sectors'], ['mil', 'Mil areas'], ['points', 'FRA E/X'], ['navaids', 'VOR'], ['airports', 'Aerodromes'], ['labels', 'All labels'], ['vec', 'Vector 2 min']];
  $('layerChips').innerHTML = defs.map(d => `<button class="chip" data-l="${d[0]}" aria-pressed="${R.layers[d[0]] !== false}">${d[1]}</button>`).join('');
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
  $('libSel').innerHTML = LIBRARY.map(l => `<option value="${l.id}">${esc(l.label)}</option>`).join('');
  $('libLoad').onclick = () => loadScenarioFile(LIBRARY.find(l => l.id === $('libSel').value).file, 'library');
  $('scnExport').onclick = exportCurrent;
  $('scnImport').onclick = () => $('scnFile').click();
  $('scnFile').onchange = () => { const f = $('scnFile').files[0]; $('scnFile').value = ''; if (f) importFile(f); };
  $('buildAI').onclick = () => buildWithClaude();
  $('newSeed').onclick = () => { $('seed').value = 1000 + Math.floor(Math.random() * 9000); };
  $('sector').onchange = () => applyScenario(buildLocalScenario(C, readCfg()));
  $('difficulty').onchange = () => applyScenario(buildLocalScenario(C, readCfg()));
  $('debRestart').onclick = () => { $('debrief').hidden = true; startSession(); };
  $('debNew').onclick = () => { $('debrief').hidden = true; $('seed').value = 1000 + Math.floor(Math.random() * 9000); applyScenario(buildLocalScenario(C, readCfg())); };
  $('debClose').onclick = () => { $('debrief').hidden = true; };
  $('debReplay').onclick = () => {
    const rec = ui.viewRecord; if (!rec) return;
    $('debrief').hidden = true;
    $('traineeName').value = rec.trainee; $('instructorName').value = rec.instructor;
    loadScenarioFile(rec.scenario, 'record');
  };
  $('debPdf').onclick = () => { const rec = ui.viewRecord || ui.lastRecord; if (rec) downloadPdf(rec, lines => toast(lines[0])); };
  $('debRemarks').oninput = remarksChanged;
  $('debExport').onclick = () => { const rec = ui.viewRecord || ui.lastRecord; if (rec) { download(rec, recordFileName(rec)); toast(`Exported ${recordFileName(rec)}`); } };
  $('histList').onclick = historyClick;
  $('histExportAll').onclick = exportAll;
  $('histImport').onclick = () => $('histFile').click();
  $('histFile').onchange = () => { const f = $('histFile').files[0]; $('histFile').value = ''; if (f) importRecords(f); };
  $('windApply').onclick = () => applyWind(false);
  $('windCalm').onclick = () => applyWind(true);
  $('openTwo').onclick = () => { openTrainee(); location.href = roleUrl('instructor'); };
  document.addEventListener('keydown', e => {
    if (ROLE === 'trainee' || e.target.matches('input,textarea,select')) return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
  });
}

/* ---------- country ---------- */
function setCountry(code) {
  C = countryData(code);
  if (ROLE !== 'trainee') sim.C = C; // the trainee view takes its country from the snapshots
  $('country').value = code;
  $('firTag').textContent = `${C.meta.fir} · ${C.meta.unit}`;
  const opts = [...C.sectorList.map(s => [s.id, `${sectorLabel(s)} (${s.rad})`]), ['FIR', 'Whole FIR']];
  $('sector').innerHTML = opts.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('');
  $('sector').value = C.meta.defaultSector || C.sectorList[0].id;
  renderDataTab();
}

/* ---------- boot ---------- */
function boot() {
  $('country').innerHTML = COUNTRIES.map(c => `<option value="${c.code}" ${c.planned ? 'disabled' : ''}>${esc(c.name)}${c.planned ? ` — ${esc(c.note || 'planned')}` : ''}</option>`).join('');
  $('country').onchange = () => { setCountry($('country').value); applyScenario(buildLocalScenario(C, readCfg())); };
  setCountry(C.meta.code);
  bindInput();
  if (ROLE !== 'trainee') applyScenario(buildLocalScenario(C, readCfg()));
  if (link) initLink();
  new ResizeObserver(() => R.resize()).observe($('scope'));
  if (ROLE !== 'trainee') initClaude();

  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (ROLE === 'trainee' && !sim.snap) { requestAnimationFrame(frame); return; } // nothing to show yet
    if (ROLE !== 'trainee' && ui.running && !sim.ended) {
      acc += dt * ui.speed;
      let n = 0;
      while (acc >= 1 && n < 40) { sim.step(); captureEvents(); acc -= 1; n++; }
    }
    if (ROLE !== 'trainee') captureEvents(); // injects fired from the instructor panel
    if (sim.ended && !ui.debriefShown) { ui.debriefShown = true; setRunning(false); updatePanel(true); if (ROLE !== 'trainee') saveRecord(); showDebrief(); }
    if (ROLE === 'instructor' && now - ui.lastPub >= 1000) publish();
    R.draw();
    updatePanel(false);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
boot();
