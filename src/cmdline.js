// Command line in controller shorthand. DOM-free: parses text into Sim clearance calls.
//
//   ROT123 370          climb/descend FL370 (also FL370)
//   WZZ45 H120          turn heading 120 (also H 120)
//   THY1 D NERDI        direct NERDI (also DNERDI, DCT NERDI)
//   DLH3 M78            Mach .78 (also M.78, M0.78)
//   DLH3 S250           speed 250 kt IAS
//   AFR12 R2000+        rate 2000 ft/min or greater (R1500- for or less)
//   ROT123 370 H120     several items in one transmission

export const SHORTHAND = [
  ['370', 'level FL370'], ['H120', 'heading 120'], ['D NERDI', 'direct NERDI'],
  ['M78', 'Mach .78'], ['S250', 'speed 250 kt'], ['R2000+', 'rate 2000 ft/min or greater']
];
export const LIMITS = { minFL: 50, maxFL: 450, minIas: 200, maxIas: 350, minMach: 0.6, maxMach: 0.9, minRate: 500, maxRate: 6000 };

/** Callsigns starting with what was typed, case-insensitive, sorted. */
export function completeCallsign(prefix, callsigns) {
  const p = String(prefix || '').trim().toUpperCase();
  return p ? callsigns.filter(cs => cs.toUpperCase().startsWith(p)).sort() : [];
}

/**
 * Parse one command line. The callsign must be typed in full (completion is the UI's job), so a
 * similar callsign is never picked by guess.
 * @param text      e.g. "ROT123 370 H120"
 * @param callsigns callsigns on the display
 * @returns { ok: true, cs, actions: [{ cmd, args }] } (cmd is a Sim method) or { ok: false, error }
 */
export function parseCommand(text, callsigns) {
  const tokens = String(text || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return fail('Type a callsign and a clearance, e.g. ROT123 370');
  const cs = tokens.shift();
  if (!callsigns.some(c => c.toUpperCase() === cs)) {
    const near = completeCallsign(cs, callsigns);
    return fail(near.length ? `No aircraft ${cs}. Did you mean ${near.slice(0, 4).join(', ')}?` : `No aircraft ${cs} on the display`);
  }
  if (!tokens.length) return fail(`${cs}: no clearance given`);
  const actions = [], seen = new Set();
  const add = (kind, cmd, args) => {
    if (seen.has(kind)) return `${cs}: two ${kind} clearances in one line`;
    seen.add(kind); actions.push({ cmd, args }); return null;
  };
  let m;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let err = null;
    if ((m = /^(?:FL)?(\d{2,3})$/.exec(t))) {
      const fl = +m[1];
      err = fl >= LIMITS.minFL && fl <= LIMITS.maxFL ? add('level', 'clearLevel', [fl]) : `Level ${m[1]} is outside FL${pad(LIMITS.minFL)}-FL${LIMITS.maxFL}`;
    } else if ((m = /^H(\d{1,3})?$/.exec(t))) {
      const v = m[1] ?? (/^\d{1,3}$/.test(tokens[i + 1] || '') ? tokens[++i] : null);
      if (v === null) err = 'H needs a heading, e.g. H120';
      else err = +v >= 1 && +v <= 360 ? add('heading', 'turn', [+v]) : `Heading ${v} is outside 001-360`;
    } else if (t === 'D' || t === 'DCT' || (m = /^D(?:CT)?([A-Z]{2,5})$/.exec(t))) {
      const pt = m ? m[1] : tokens[++i];
      if (!pt) err = 'D needs a point, e.g. D NERDI';
      else if (!/^[A-Z]{2,5}$/.test(pt)) err = `"${pt}" is not a point name`;
      else err = add('route', 'direct', [pt]);
    } else if ((m = /^M(?:0?\.)?(\d{2})$/.exec(t))) {
      const v = +m[1] / 100;
      err = v >= LIMITS.minMach && v <= LIMITS.maxMach ? add('speed', 'mach', [v]) : `Mach .${m[1]} is outside .${LIMITS.minMach * 100}-.${LIMITS.maxMach * 100}`;
    } else if ((m = /^S(\d{3})$/.exec(t))) {
      const v = +m[1];
      err = v >= LIMITS.minIas && v <= LIMITS.maxIas ? add('speed', 'speed', [v]) : `Speed ${v} kt is outside ${LIMITS.minIas}-${LIMITS.maxIas}`;
    } else if ((m = /^R(\d{3,4})([+-])$/.exec(t))) {
      const v = +m[1];
      err = v >= LIMITS.minRate && v <= LIMITS.maxRate ? add('rate', 'clearRate', [v, m[2] === '+' ? 'min' : 'max']) : `Rate ${v} ft/min is outside ${LIMITS.minRate}-${LIMITS.maxRate}`;
    } else err = `Not understood: "${t}". Use ${SHORTHAND.map(s => s[0]).join(', ')}`;
    if (err) return fail(err);
  }
  return { ok: true, cs, actions };
}

const fail = error => ({ ok: false, error });
const pad = n => String(n).padStart(3, '0');
