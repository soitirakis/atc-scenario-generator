import { describe, it, expect } from 'vitest';
import { parseCommand, completeCallsign } from '../../src/cmdline.js';

const CS = ['ROT123', 'WZZ45', 'WZZ4127', 'WZZ4172', 'THY1', 'DLH3', 'AFR12'];
const ok = (text, actions, cs) => {
  const r = parseCommand(text, CS);
  expect(r, text).toMatchObject({ ok: true, actions });
  if (cs) expect(r.cs).toBe(cs);
};
const bad = (text, error) => {
  const r = parseCommand(text, CS);
  expect(r.ok, text).toBe(false);
  expect(r.error, text).toMatch(error);
};

describe('command line: controller shorthand', () => {
  it('level: three digits, or FL and three digits', () => {
    ok('ROT123 370', [{ cmd: 'clearLevel', args: [370] }], 'ROT123');
    ok('ROT123 FL370', [{ cmd: 'clearLevel', args: [370] }]);
    ok('ROT123 090', [{ cmd: 'clearLevel', args: [90] }]);
  });
  it('heading: H and up to three digits, with or without a space', () => {
    ok('WZZ45 H120', [{ cmd: 'turn', args: [120] }]);
    ok('WZZ45 H 120', [{ cmd: 'turn', args: [120] }]);
    ok('WZZ45 H5', [{ cmd: 'turn', args: [5] }]);
    ok('WZZ45 H360', [{ cmd: 'turn', args: [360] }]);
  });
  it('direct: D and a point, with or without a space, or DCT', () => {
    ok('THY1 D NERDI', [{ cmd: 'direct', args: ['NERDI'] }]);
    ok('THY1 DNERDI', [{ cmd: 'direct', args: ['NERDI'] }]);
    ok('THY1 DCT BRV', [{ cmd: 'direct', args: ['BRV'] }]);
  });
  it('speed: Mach as M78, M.78 or M0.78; IAS as S250', () => {
    for (const t of ['M78', 'M.78', 'M0.78']) ok(`DLH3 ${t}`, [{ cmd: 'mach', args: [0.78] }]);
    ok('DLH3 S250', [{ cmd: 'speed', args: [250] }]);
  });
  it('rate: R and ft/min, + for "or greater", - for "or less"', () => {
    ok('AFR12 R2000+', [{ cmd: 'clearRate', args: [2000, 'min'] }]);
    ok('AFR12 R1500-', [{ cmd: 'clearRate', args: [1500, 'max'] }]);
  });
  it('several items in one transmission, in the order given', () => {
    ok('ROT123 370 H120 M78', [{ cmd: 'clearLevel', args: [370] }, { cmd: 'turn', args: [120] }, { cmd: 'mach', args: [0.78] }]);
  });
  it('is case-insensitive and ignores extra spaces', () => {
    ok('  rot123   370  h120 ', [{ cmd: 'clearLevel', args: [370] }, { cmd: 'turn', args: [120] }], 'ROT123');
    ok('thy1 d nerdi', [{ cmd: 'direct', args: ['NERDI'] }]);
  });
});

describe('command line: malformed input', () => {
  it('empty input', () => {
    bad('', /Type a callsign and a clearance/);
    bad('   ', /Type a callsign and a clearance/);
    bad(null, /Type a callsign and a clearance/);
  });
  it('a callsign alone', () => bad('ROT123', /ROT123: no clearance given/));
  it('an unknown callsign; a partial one is not guessed, it lists the candidates', () => {
    bad('ABC999 370', /No aircraft ABC999 on the display/);
    bad('WZZ41 370', /No aircraft WZZ41\. Did you mean WZZ4127, WZZ4172\?/);
    bad('ROT12 370', /Did you mean ROT123/);
  });
  it('a level outside FL050-FL450', () => {
    bad('ROT123 470', /Level 470 is outside FL050-FL450/);
    bad('ROT123 040', /Level 040 is outside/);
  });
  it('a heading of 0 or above 360, or a missing heading', () => {
    bad('WZZ45 H0', /Heading 0 is outside 001-360/);
    bad('WZZ45 H361', /Heading 361 is outside/);
    bad('WZZ45 H', /H needs a heading/);
  });
  it('D without a point, or with a number', () => {
    bad('THY1 D', /D needs a point/);
    bad('THY1 D 123', /"123" is not a point name/);
    bad('THY1 D370', /Not understood: "D370"/);
  });
  it('speeds and rates out of range', () => {
    bad('DLH3 M95', /Mach \.95 is outside/);
    bad('DLH3 S400', /Speed 400 kt is outside 200-350/);
    bad('AFR12 R9000+', /Rate 9000 ft\/min is outside/);
    bad('AFR12 R2000', /Not understood: "R2000"/); // needs + or -
  });
  it('two clearances of the same kind in one line', () => {
    bad('ROT123 370 380', /two level clearances/);
    bad('DLH3 M78 S250', /two speed clearances/);
  });
  it('anything else names the item and lists what is understood', () => {
    bad('ROT123 CLIMB', /Not understood: "CLIMB"\. Use 370, H120, D NERDI, M78, S250, R2000\+/);
    bad('ROT123 37', /Level 37 is outside/);
    bad('ROT123 3700', /Not understood: "3700"/);
  });
});

describe('callsign completion', () => {
  it('lists callsigns starting with what was typed', () => {
    expect(completeCallsign('wzz4', CS)).toEqual(['WZZ4127', 'WZZ4172', 'WZZ45']);
    expect(completeCallsign('WZZ41', CS)).toEqual(['WZZ4127', 'WZZ4172']);
    expect(completeCallsign('WZZ412', CS)).toEqual(['WZZ4127']);
    expect(completeCallsign('X', CS)).toEqual([]);
    expect(completeCallsign('', CS)).toEqual([]);
  });
});
