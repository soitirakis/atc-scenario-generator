// Pilot transmissions as spoken ICAO phraseology, for the browser's speech synthesis. DOM-free:
// text in, text out. Numbers follow ICAO Annex 10 Vol II 5.2.1.4 (digits one by one, "niner",
// whole hundreds and thousands as "one thousand five hundred"); callsigns use the telephony
// designators in data/telephony.json.
import TEL from '../data/telephony.json';

export const TELEPHONY = TEL.operators;
const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
export const ALPHABET = { A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' };

/** Every digit on its own: "090" -> "zero niner zero". */
export const digits = s => [...String(s)].filter(c => /\d/.test(c)).map(d => DIGIT[+d]).join(' ');
/** Letters in the ICAO spelling alphabet, digits one by one: "LROP" -> "Lima Romeo Oscar Papa". */
export const spell = s => [...String(s).toUpperCase()].map(c => ALPHABET[c] || (/\d/.test(c) ? DIGIT[+c] : '')).filter(Boolean).join(' ');
/** A number: whole hundreds and thousands in words ("two thousand", "one thousand five hundred", "one one thousand"), anything else digit by digit. */
export function spokenNumber(n) {
  n = Math.round(Math.abs(+n));
  if (n < 100 || n % 100) return digits(n);
  const th = Math.floor(n / 1000), h = (n % 1000) / 100;
  return [th ? `${digits(th)} thousand` : '', h ? `${DIGIT[h]} hundred` : ''].filter(Boolean).join(' ');
}
/** "flight level three five zero"; whole hundreds as "flight level one hundred" (Annex 10). */
export function spokenLevel(fl) {
  fl = Math.round(+fl);
  return fl % 100 === 0 && fl > 0 ? `flight level ${DIGIT[fl / 100]} hundred` : `flight level ${digits(String(fl).padStart(3, '0'))}`;
}
/** Three digits, north as 360: "heading zero niner zero". */
export const spokenHeading = h => `heading ${digits(String(Math.round(+h) % 360 || 360).padStart(3, '0'))}`;
/** A point: a five-letter name is said as a word, anything else (a VOR, an aerodrome) is spelled. */
export const spokenPoint = p => (/^[A-Z]{5}$/.test(p) ? p[0] + p.slice(1).toLowerCase() : spell(p));

/**
 * A callsign: the operator's telephony designator, then the flight number digit by digit and
 * letters in the spelling alphabet ("WZZ1118" -> "Wizz Air one one one eight"). An unknown
 * three-letter designator is spelled; a longer word (military, "VIPER41") is said as it is.
 */
export function spokenCallsign(cs) {
  const s = String(cs).toUpperCase(), m = /^([A-Z]{3})(\d[0-9A-Z]*)$/.exec(s), w = /^([A-Z]{4,})(\d[0-9A-Z]*)$/.exec(s);
  if (m) return `${TELEPHONY[m[1]] ? TELEPHONY[m[1]].say : spell(m[1])} ${spell(m[2])}`;
  if (w) return `${w[1][0]}${w[1].slice(1).toLowerCase()} ${spell(w[2])}`;
  return spell(s);
}

/**
 * One clearance as the pilot reads it back, from the simulator's text for it (Sim._cmd's `what`):
 * "descend FL340", "turn heading 090", "direct NERDI", "speed 250 kt", "maintain M.78",
 * "climb at 2000 ft/min or greater", "resume normal speed", "deviation approved", "roger".
 */
export function spokenClearance(what) {
  const t = String(what).trim();
  let m;
  if ((m = /^(climb|descend|maintain) FL(\d{2,3})$/.exec(t))) return `${m[1]} ${spokenLevel(+m[2])}`;
  if ((m = /^turn heading (\d{1,3})$/.exec(t))) return `turn ${spokenHeading(+m[1])}`;
  if ((m = /^direct ([A-Z0-9]{2,5})$/.exec(t))) return `direct ${spokenPoint(m[1])}`;
  if ((m = /^speed (\d{2,3}) kt$/.exec(t))) return `speed ${digits(m[1])} knots`;
  if ((m = /^maintain M\.(\d{2})$/.exec(t))) return `maintain Mach decimal ${digits(m[1])}`;
  if ((m = /^(climb|descend) at (\d{3,4}) ft\/min or (greater|less)$/.exec(t))) return `${m[1]} at ${spokenNumber(+m[2])} feet per minute or ${m[3]}`;
  // anything else: levels and numbers spoken, words as they are
  return t.replace(/FL(\d{2,3})/g, (_, f) => spokenLevel(+f)).replace(/\d+/g, d => digits(d));
}

/** The pilot's readback: each clearance of the transmission, then the callsign. Wrong readbacks are spoken as the pilot says them. */
export const readbackText = (what, cs) => `${String(what).split(', ').map(spokenClearance).join(', ')}, ${spokenCallsign(cs)}`;

/** A pilot's request, callsign first: climb or descent (with a level when there is one), a weather deviation, a direct. */
export function requestText(req, cs) {
  const c = spokenCallsign(cs);
  if (req.kind === 'climb') return `${c}, request climb ${spokenLevel(req.value)}`;
  if (req.kind === 'descend') return /FL\d/.test(req.text || '') ? `${c}, request descent ${spokenLevel(req.value)}` : `${c}, request descent`;
  if (req.kind === 'wx') return `${c}, request ${digits(Math.abs(req.value))} degrees ${req.value < 0 ? 'left' : 'right'} for weather`;
  if (req.kind === 'direct') return `${c}, request direct ${spokenPoint(String(req.value))}`;
  return null;
}

/** What a transmission from the simulator's radio log (Sim.tx) sounds like, or null if a pilot would not say it. */
export const transmissionText = tx => (tx.kind === 'readback' ? readbackText(tx.what, tx.cs) : tx.kind === 'request' ? requestText(tx.req, tx.cs) : null);

const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
/** A voice for a callsign, the same every time: which of n voices, pitch 0.85-1.15 and rate 0.95-1.10. */
export function voiceProfile(cs, n) {
  const h = hash(String(cs).toUpperCase());
  return { voice: n > 0 ? h % n : -1, pitch: 0.85 + ((h >>> 8) % 31) / 100, rate: 0.95 + ((h >>> 16) % 16) / 100 };
}

/** Characters per second at speech rate 1 (an estimate; voices vary), and the fastest rate used. */
export const SPEECH = { charsPerS: 14, maxRate: 2 };
/**
 * Rate to say a text within the transmission's window: at least the voice's own rate, faster if
 * the text would not fit. fits is false when even SPEECH.maxRate is too slow; speech is then cut at the window's end.
 */
export function fitRate(text, seconds, base = 1) {
  const need = text.length / SPEECH.charsPerS / Math.max(0.01, seconds);
  return { rate: Math.min(SPEECH.maxRate, Math.max(base, need)), fits: need <= SPEECH.maxRate };
}
