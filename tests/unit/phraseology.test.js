import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import TEL from '../../data/telephony.json';
import { COUNTRIES } from '../../data/countries.js';
import { TELEPHONY, digits, spell, spokenNumber, spokenLevel, spokenHeading, spokenPoint, spokenCallsign, spokenClearance, readbackText, requestText, transmissionText, voiceProfile, fitRate, SPEECH } from '../../src/phraseology.js';

describe('numbers', () => {
  it('digits one by one, with niner', () => {
    expect(digits(1189)).toBe('one one eight niner');
    expect(digits('090')).toBe('zero niner zero');
    expect(digits('0123456789')).toBe('zero one two three four five six seven eight niner');
  });
  it('whole hundreds and thousands in words, as Annex 10 does; others digit by digit', () => {
    expect([spokenNumber(2000), spokenNumber(1500), spokenNumber(11000), spokenNumber(300), spokenNumber(250), spokenNumber(1250)])
      .toEqual(['two thousand', 'one thousand five hundred', 'one one thousand', 'three hundred', 'two five zero', 'one two five zero']);
  });
  it('the spelling alphabet', () => {
    expect(spell('LROP')).toBe('Lima Romeo Oscar Papa');
    expect(spell('XY9')).toBe('X-ray Yankee niner');
  });
});

describe('levels and headings', () => {
  it('flight level digit by digit; whole hundreds as "one hundred"', () => {
    expect(spokenLevel(350)).toBe('flight level three five zero');
    expect(spokenLevel(290)).toBe('flight level two niner zero');
    expect(spokenLevel(95)).toBe('flight level zero niner five');
    expect(spokenLevel(100)).toBe('flight level one hundred');
    expect(spokenLevel(200)).toBe('flight level two hundred');
  });
  it('headings as three digits, north as 360', () => {
    expect([spokenHeading(90), spokenHeading(5), spokenHeading(270), spokenHeading(0), spokenHeading(360)])
      .toEqual(['heading zero niner zero', 'heading zero zero five', 'heading two seven zero', 'heading three six zero', 'heading three six zero']);
  });
  it('points: five-letter names said as words, other ids spelled', () => {
    expect([spokenPoint('NERDI'), spokenPoint('BUD'), spokenPoint('LROP')]).toEqual(['Nerdi', 'Bravo Uniform Delta', 'Lima Romeo Oscar Papa']);
  });
});

describe('callsigns', () => {
  it('telephony designator, then the flight number digit by digit', () => {
    expect(spokenCallsign('WZZ1118')).toBe('Wizz Air one one one eight');
    expect(spokenCallsign('ROT344')).toBe('Tarom three four four');
    expect(spokenCallsign('THY2605')).toBe('Turkish two six zero five');
    expect(spokenCallsign('DLH9')).toBe('Lufthansa niner');
    expect(spokenCallsign('BAW12A')).toBe('Speedbird one two Alfa');
    expect(spokenCallsign('KLM1789')).toBe('K L M one seven eight niner');
  });
  it('an unknown designator is spelled; a military word is said as it is', () => {
    expect(spokenCallsign('XYZ123')).toBe('X-ray Yankee Zulu one two three');
    expect(spokenCallsign('VIPER41')).toBe('Viper four one');
    expect(spokenCallsign('N123')).toBe('November one two three');
  });
  it('every operator in every traffic.json has a telephony designator, from the cited source', () => {
    const ops = new Set(COUNTRIES.filter(c => c.data).flatMap(c => c.data.traffic.operators.map(o => o.icao)));
    expect(ops.size).toBeGreaterThan(10);
    for (const op of ops) expect(TELEPHONY[op], op).toMatchObject({ telephony: expect.stringMatching(/^[A-Z ]+$/), say: expect.any(String) });
    expect(TEL._source.doc).toMatch(/JO 7340\.2P/);
    expect([TELEPHONY.WZZ.telephony, TELEPHONY.ROT.telephony, TELEPHONY.THY.telephony, TELEPHONY.DLH.telephony, TELEPHONY.LOT.telephony, TELEPHONY.FDB.telephony]).toEqual(['WIZZAIR', 'TAROM', 'TURKISH', 'LUFTHANSA', 'LOT', 'SKY DUBAI']);
    expect(RO.traffic.operators.length).toBe(Object.keys(TELEPHONY).length);
  });
});

describe('readbacks', () => {
  it('each clearance the simulator gives, read back in ICAO phraseology with the callsign last', () => {
    const cases = [
      ['descend FL340', 'descend flight level three four zero'],
      ['climb FL100', 'climb flight level one hundred'],
      ['turn heading 090', 'turn heading zero niner zero'],
      ['direct NERDI', 'direct Nerdi'],
      ['direct LROP', 'direct Lima Romeo Oscar Papa'],
      ['speed 250 kt', 'speed two five zero knots'],
      ['maintain M.78', 'maintain Mach decimal seven eight'],
      ['climb at 2000 ft/min or greater', 'climb at two thousand feet per minute or greater'],
      ['descend at 1500 ft/min or less', 'descend at one thousand five hundred feet per minute or less'],
      ['resume normal speed', 'resume normal speed'],
      ['resume own navigation', 'resume own navigation'],
      ['deviation approved', 'deviation approved'],
      ['roger', 'roger']
    ];
    for (const [what, said] of cases) expect(readbackText(what, 'ROT344'), what).toBe(`${said}, Tarom three four four`);
  });
  it('several clearances in one transmission, read back in order', () => {
    expect(readbackText('climb FL370, turn heading 120, maintain M.80', 'WZZ45')).toBe('climb flight level three seven zero, turn heading one two zero, maintain Mach decimal eight zero, Wizz Air four five');
  });
  it('readback errors are spoken as the pilot says them: the wrong level or heading', () => {
    // READBACK_ERROR: cleared FL340, read back FL330; cleared heading 090, read back 120
    expect(readbackText('descend FL330', 'THY2605')).toBe('descend flight level three three zero, Turkish two six zero five');
    expect(readbackText('turn heading 120', 'THY2605')).toBe('turn heading one two zero, Turkish two six zero five');
    // SIMILAR_CALLSIGN: the other flight takes it and reads back with its own callsign
    expect(readbackText('descend FL340', 'ROT434')).toBe('descend flight level three four zero, Tarom four three four');
  });
  it('anything else: levels and numbers still spoken', () => {
    expect(spokenClearance('report passing FL250 at 12')).toBe('report passing flight level two five zero at one two');
  });
});

describe('requests and transmissions', () => {
  it('callsign first, then the request', () => {
    expect(requestText({ kind: 'climb', value: 370, text: 'requests climb FL370' }, 'WZZ1118')).toBe('Wizz Air one one one eight, request climb flight level three seven zero');
    expect(requestText({ kind: 'descend', value: 110, text: 'requests descent' }, 'ROT344')).toBe('Tarom three four four, request descent');
    expect(requestText({ kind: 'descend', value: 290, text: 'requests descend FL290' }, 'ROT344')).toBe('Tarom three four four, request descent flight level two niner zero');
    expect(requestText({ kind: 'wx', value: -25, text: 'x' }, 'DLH3')).toBe('Lufthansa three, request two five degrees left for weather');
    expect(requestText({ kind: 'direct', value: 'NERDI' }, 'DLH3')).toBe('Lufthansa three, request direct Nerdi');
    expect(requestText({ kind: 'coord', value: 330 }, 'DLH3')).toBeNull(); // the next sector, not the pilot
  });
  it('a transmission from the radio log', () => {
    expect(transmissionText({ kind: 'readback', cs: 'ROT344', what: 'descend FL340' })).toBe('descend flight level three four zero, Tarom three four four');
    expect(transmissionText({ kind: 'request', cs: 'DLH3', req: { kind: 'direct', value: 'NERDI' } })).toBe('Lufthansa three, request direct Nerdi');
    expect(transmissionText({ kind: 'other' })).toBeNull();
  });
});

describe('voices', () => {
  it('the same voice, pitch and rate for a callsign every time; different callsigns differ', () => {
    expect(voiceProfile('ROT344', 5)).toEqual(voiceProfile('rot344', 5));
    const ps = ['ROT344', 'WZZ1118', 'THY2605', 'DLH3', 'BAW12', 'AFR1', 'KLM9', 'SWR77'].map(cs => voiceProfile(cs, 4));
    expect(new Set(ps.map(p => p.voice)).size).toBeGreaterThan(1);
    expect(new Set(ps.map(p => p.pitch)).size).toBeGreaterThan(1);
    for (const p of ps) { expect(p.pitch).toBeGreaterThanOrEqual(0.85); expect(p.pitch).toBeLessThanOrEqual(1.15); expect(p.rate).toBeGreaterThanOrEqual(0.95); expect(p.rate).toBeLessThanOrEqual(1.1); expect(p.voice).toBeLessThan(4); }
    expect(voiceProfile('ROT344', 0).voice).toBe(-1);
  });
  it('speaks faster when the text would not fit the transmission, up to the maximum', () => {
    const text = 'x'.repeat(28); // 2 s at rate 1
    expect(fitRate(text, 4, 1)).toEqual({ rate: 1, fits: true });
    expect(fitRate(text, 1, 1)).toEqual({ rate: 2, fits: true });
    expect(fitRate(text, 0.5, 1)).toEqual({ rate: SPEECH.maxRate, fits: false });
    expect(fitRate(text, 4, 1.05).rate).toBe(1.05);
  });
});
