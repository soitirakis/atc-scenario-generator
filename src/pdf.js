// PDF debrief from a session record (src/records.js), built offline with jsPDF (MIT), which Vite
// bundles into the single-file build. DOM-free: the unit tests build the PDF in Node.
import { jsPDF } from 'jspdf';
import { statRows, summary } from './records.js';
import { fmtT } from './geo.js';

export const TRAINING_MARK = 'Training aid, not an official assessment';

// A4 portrait, millimetres
const W = 210, H = 297, M = 15, CW = W - 2 * M, BOTTOM = H - 16;
const INK = [20, 28, 36], MUTED = [96, 108, 118], LINE = [190, 198, 204], ALERT = [190, 40, 30], WARN = [170, 110, 0], OK = [30, 120, 60];
// characters the PDF standard fonts (WinAnsi) have beyond Latin-1
const WINANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/**
 * Text for the PDF standard fonts. They cover Latin-1 and WinAnsi only, so other letters lose
 * their accents (ș → s, ă → a, ő → o); anything left over becomes "?".
 */
export function pdfText(s) {
  return [...String(s ?? '')].map(ch => {
    if (ch.charCodeAt(0) <= 0xff || WINANSI.has(ch)) return ch;
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return [...base].every(c => c.charCodeAt(0) <= 0xff) ? base : '?';
  }).join('');
}

const fmtSaved = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * The debrief PDF of a record.
 * @param rec  a valid session record (schemaVersion 2)
 * @param o    { countryName, compress (default true) }
 * @returns the jsPDF document (save with doc.output('blob') or doc.output('arraybuffer'))
 */
export function buildDebriefPdf(rec, o = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: o.compress !== false });
  doc.setProperties({ title: pdfText(`Session debrief: ${rec.scenario.title}`), subject: TRAINING_MARK, creator: 'ATC Scenario Generator' });
  let y = M;
  const font = (size, style = 'normal', color = INK) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); };
  const lh = size => size * 0.3528 * 1.3; // line height in mm for a font size in pt
  const newPage = () => { doc.addPage(); y = M; };
  const room = h => { if (y + h > BOTTOM) newPage(); };
  const lines = (text, width) => doc.splitTextToSize(pdfText(text), width);
  /** Wrapped paragraph at x, breaking across pages line by line. */
  const para = (text, size = 10, style = 'normal', color = INK, x = M, width = CW) => {
    font(size, style, color);
    for (const l of lines(text, width)) { room(lh(size)); doc.text(l, x, y + lh(size) * 0.75); y += lh(size); }
  };
  const heading = text => {
    room(14);
    y += 3;
    font(12, 'bold');
    doc.text(pdfText(text), M, y + 4.5);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(M, y + 6.5, W - M, y + 6.5);
    y += 9;
  };

  // header
  font(18, 'bold'); doc.text('Session debrief', M, y + 6);
  font(10, 'bold', ALERT); doc.text(TRAINING_MARK, W - M, y + 6, { align: 'right' });
  y += 11;
  para(rec.scenario.title, 13, 'bold');
  y += 1.5;
  const sector = `${rec.sectorName} (${rec.sector})${rec.sectorBand ? `, ${rec.sectorBand}` : ''}`;
  const facts = [
    ['Country', o.countryName ? `${o.countryName} (${rec.country})` : rec.country], ['Sector', sector],
    ['Date', fmtSaved(rec.savedAt)], ['Seed', String(rec.seed)],
    ['Session', `${rec.scenario.duration} min, ${rec.scenario.difficulty} traffic${rec.completed ? '' : `, ended early at ${fmtT(rec.elapsedS)}`}`], ['Result', summary(rec).text],
    ['Trainee', rec.trainee || '—'], ['Instructor', rec.instructor || '—']
  ];
  for (let i = 0; i < facts.length; i += 2) {
    const row = facts.slice(i, i + 2), h = Math.max(...row.map(([, v]) => lines(v, CW / 2 - 26).length)) * lh(9.5);
    room(h + 1);
    row.forEach(([k, v], c) => {
      const x = M + c * (CW / 2);
      font(8, 'bold', MUTED); doc.text(k.toUpperCase(), x, y + 3.2);
      font(9.5); doc.text(lines(v, CW / 2 - 26), x + 24, y + 3.2);
    });
    y += h + 1;
  }

  heading('Objective');
  para(rec.scenario.objective);
  if (rec.scenario.criteria.length) {
    y += 2; para('Success criteria', 10, 'bold');
    for (const c of rec.scenario.criteria) para(`•  ${c}`, 10, 'normal', INK, M + 2, CW - 2);
  }

  // injects: one row each, wrapped cells, the header repeated on a new page
  heading(`Injects: ${summary(rec).met}/${summary(rec).graded} objectives met`);
  const cols = [['Time', 13], ['Inject', 34], ['Objective', 48], ['Result', 18], ['Measured', 20], ['Reason', 47]];
  const tableHead = () => {
    font(8, 'bold', MUTED);
    let x = M; for (const [t, w] of cols) { doc.text(t.toUpperCase(), x, y + 3); x += w; }
    doc.setDrawColor(...LINE); doc.line(M, y + 4.5, W - M, y + 4.5); y += 6;
  };
  if (!rec.injects.length) para('No injects in this scenario.', 10, 'italic', MUTED);
  else {
    tableHead();
    for (const i of rec.injects) {
      const r = i.result, state = r ? r.state : i.status === 'fired' ? 'not graded' : 'not fired';
      const cells = [i.firedAt === null ? `${String(i.min).padStart(2, '0')}:00` : fmtT(i.firedAt), `${i.label}${i.target ? ` · ${i.target}` : ''}`, i.objective, state, r && r.t !== null ? `${r.t} s` : '—', r ? r.reason : ''];
      const wrapped = cells.map((c, k) => lines(c, cols[k][1] - 2));
      const h = Math.max(...wrapped.map(w => w.length)) * lh(8.5) + 2;
      if (y + h > BOTTOM) { newPage(); tableHead(); }
      let x = M;
      wrapped.forEach((w, k) => {
        const color = k === 3 ? (state === 'met' ? OK : state === 'not met' ? ALERT : MUTED) : INK;
        font(8.5, k === 3 ? 'bold' : 'normal', color);
        doc.text(w, x, y + 3); x += cols[k][1];
      });
      y += h;
      doc.setDrawColor(...LINE); doc.line(M, y - 1, W - M, y - 1);
    }
  }

  heading('Debrief statistics');
  const stats = statRows({ ...rec.stats });
  for (let i = 0; i < stats.length; i += 3) {
    room(10);
    stats.slice(i, i + 3).forEach(([k, v, level], c) => {
      const x = M + c * (CW / 3);
      font(7.5, 'bold', MUTED); doc.text(pdfText(k).toUpperCase(), x, y + 3);
      font(11, 'bold', level === 'a' ? ALERT : level === 'w' ? WARN : INK); doc.text(pdfText(String(v)), x, y + 8);
    });
    y += 11;
  }

  heading('Event timeline');
  if (!rec.timeline.length) para('No events.', 10, 'italic', MUTED);
  for (const e of rec.timeline) {
    const color = e.cls === 'a' ? ALERT : e.cls === 'w' ? WARN : e.cls === 'ok' ? OK : INK;
    const w = lines(e.text, CW - 16);
    room(w.length * lh(8.5));
    font(8.5, 'bold', MUTED); doc.text(fmtT(e.t), M, y + 3);
    font(8.5, 'normal', color); doc.text(w, M + 16, y + 3);
    y += w.length * lh(8.5);
  }

  heading('Radar snapshots');
  if (!rec.snapshots.length) para('No snapshots: none were taken in this session.', 10, 'italic', MUTED);
  for (const s of rec.snapshots) {
    const iw = CW, ih = Math.min(120, (iw * s.h) / s.w), w = (ih * s.w) / s.h;
    room(ih + 9);
    font(9, 'bold'); doc.text(pdfText(`${fmtT(s.t)}  ${s.label}`), M, y + 3.5);
    doc.addImage(s.image, 'JPEG', M, y + 5, w, ih);
    y += ih + 9;
  }

  heading('Instructor remarks');
  para(rec.remarks.trim() || 'No remarks.', 10, rec.remarks.trim() ? 'normal' : 'italic', rec.remarks.trim() ? INK : MUTED);

  // signatures, kept together
  room(34);
  y += 8;
  [['Trainee', rec.trainee], ['Instructor', rec.instructor]].forEach(([role, name], c) => {
    const x = M + c * (CW / 2 + 5), w = CW / 2 - 5;
    doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.line(x, y + 12, x + w, y + 12);
    font(9, 'bold'); doc.text(pdfText(`${role}${name ? `: ${name}` : ''}`), x, y + 17);
    font(8.5, 'normal', MUTED); doc.text('Signature and date', x, y + 21.5);
  });

  // every page: the training mark and the page number
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, H - 12, W - M, H - 12);
    font(7.5, 'bold', ALERT); doc.text(TRAINING_MARK, M, H - 8);
    font(7.5, 'normal', MUTED); doc.text(`ATC Scenario Generator · page ${p} of ${n}`, W - M, H - 8, { align: 'right' });
  }
  return doc;
}
