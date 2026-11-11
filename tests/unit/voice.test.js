import { describe, it, expect } from 'vitest';
import { Voice } from '../../src/voice.js';

/** A recording speech engine: what is spoken, and how often it is cut. */
function fake(voices = [{ name: 'A', lang: 'en-GB', localService: true }, { name: 'B', lang: 'en-US', localService: true }, { name: 'Net', lang: 'en-US', localService: false }, { name: 'FR', lang: 'fr-FR', localService: true }]) {
  const synth = { spoken: [], cancels: 0, getVoices: () => voices, speak(u) { this.spoken.push(u); }, cancel() { this.cancels++; } };
  class U { constructor(text) { this.text = text; } }
  return { synth, voice: new Voice(synth, U) };
}
const rb = (id, t, cs = 'ROT344', what = 'descend FL340') => ({ id, kind: 'readback', cs, t, until: t + 2, what });
const rq = (id, t, cs = 'DLH3') => ({ id, kind: 'request', cs, t, until: t + 2, req: { kind: 'climb', value: 390, text: 'requests climb FL390' } });
const run = { running: true, speed: 1 };

describe('pilot voice', () => {
  it('uses local English voices only', () => {
    const { voice } = fake();
    expect(voice.voices.map(v => v.name)).toEqual(['A', 'B']);
    expect(voice.status()).toMatch(/2 local English voices/);
    expect(fake([{ name: 'Net', lang: 'en-US', localService: false }]).voice.status()).toMatch(/No English voice is installed/);
    expect(new Voice(null, null).status()).toMatch(/no speech synthesis/);
  });
  it('says a transmission once, in its slot, not before', () => {
    const { synth, voice } = fake(), tx = [rb(1, 10)];
    voice.update({ t: 9, tx }, run);
    expect(synth.spoken).toHaveLength(0);
    voice.update({ t: 10, tx }, run); voice.update({ t: 10, tx }, run); voice.update({ t: 11, tx }, run);
    expect(synth.spoken.map(u => u.text)).toEqual(['descend flight level three four zero, Tarom three four four']);
    expect(['A', 'B']).toContain(synth.spoken[0].voice.name);
  });
  it('cuts the speech at the end of the slot, or when the session pauses', () => {
    const { synth, voice } = fake(), tx = [rb(1, 10)];
    voice.update({ t: 10, tx }, run);
    voice.update({ t: 12, tx }, run);
    expect(synth.cancels).toBe(1);
    const b = fake();
    b.voice.update({ t: 10, tx }, run); b.voice.update({ t: 10, tx }, { running: false });
    expect(b.synth.cancels).toBe(1);
  });
  it('nothing late: a slot already over, or one that came while muted or paused, is not said afterwards', () => {
    const { synth, voice } = fake();
    voice.update({ t: 13, tx: [rb(1, 10)] }, run);
    voice.setMuted(true); voice.update({ t: 20, tx: [rb(2, 20)] }, run); voice.setMuted(false); voice.update({ t: 21, tx: [rb(2, 20)] }, run);
    voice.update({ t: 30, tx: [rb(3, 30)] }, { running: false }); voice.update({ t: 30, tx: [rb(3, 30)] }, run);
    expect(synth.spoken).toHaveLength(0);
  });
  it('a request does not talk over a transmission being said', () => {
    const { synth, voice } = fake();
    voice.update({ t: 10, tx: [rb(1, 10), rq(2, 10)] }, run);
    expect(synth.spoken.map(u => u.text)).toEqual(['descend flight level three four zero, Tarom three four four']);
    voice.update({ t: 12, tx: [rq(3, 12)] }, run); // the readback's slot is over
    expect(synth.spoken.at(-1).text).toBe('Lufthansa three, request climb flight level three niner zero');
  });
  it('speaks faster to fit the slot, more so at a higher simulation speed; volume and voice per callsign', () => {
    const a = fake(), b = fake();
    a.voice.setVolume(0.4);
    // a short readback fits the 2 s slot at 1x; at 4x the slot is half a second
    a.voice.update({ t: 10, tx: [rb(1, 10, 'ROT344', 'roger')] }, run);
    b.voice.update({ t: 10, tx: [rb(1, 10, 'ROT344', 'roger')] }, { running: true, speed: 4 });
    expect(a.synth.spoken[0].rate).toBeLessThan(1.2);
    expect(b.synth.spoken[0].rate).toBeGreaterThan(a.synth.spoken[0].rate);
    expect(b.synth.spoken[0].rate).toBeLessThanOrEqual(2);
    expect(a.synth.spoken[0].volume).toBe(0.4);
    expect([a.synth.spoken[0].voice, a.synth.spoken[0].pitch]).toEqual([b.synth.spoken[0].voice, b.synth.spoken[0].pitch]);
  });
  it('a restart starts again: the clock going back clears what was said', () => {
    const { synth, voice } = fake();
    voice.update({ t: 10, tx: [rb(1, 10)] }, run);
    voice.update({ t: 3, tx: [rb(1, 3)] }, run);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.cancels).toBe(1);
  });
  it('mute stops what is being said; volume is kept between 0 and 1', () => {
    const { synth, voice } = fake();
    voice.update({ t: 10, tx: [rb(1, 10)] }, run);
    voice.setMuted(true);
    expect(synth.cancels).toBe(1);
    voice.setVolume(3); expect(voice.volume).toBe(1);
    voice.setVolume(-1); expect(voice.volume).toBe(0);
  });
  it('voices that load late (voiceschanged) are picked up, and the controls are told', () => {
    let listener = null, list = [];
    const synth = { getVoices: () => list, speak() {}, cancel() {}, addEventListener: (e, f) => { if (e === 'voiceschanged') listener = f; } };
    const voice = new Voice(synth, class { constructor(t) { this.text = t; } });
    let told = 0; voice.onchange = () => told++;
    expect(voice.available).toBe(false);
    list = [{ name: 'A', lang: 'en', localService: true }];
    listener();
    expect([voice.available, told]).toEqual([true, 1]);
    const empty = new Voice({ getVoices: () => null, speak() {}, cancel() {} }, class {});
    expect(empty.voices).toEqual([]);
  });
  it('when an utterance ends, the next transmission can be said in the same slot', () => {
    const { synth, voice } = fake();
    voice.update({ t: 10, tx: [rb(1, 10)] }, run);
    synth.spoken[0].onend();
    voice.update({ t: 10, tx: [rb(1, 10), rq(2, 10)] }, run);
    expect(synth.spoken).toHaveLength(2);
    synth.spoken[0].onend(); // a late end event from an earlier utterance changes nothing
    expect(voice.current.id).toBe(2);
  });
  it('without a view or a speech engine, nothing happens', () => {
    const { synth, voice } = fake();
    voice.update(null, run);
    new Voice(null, null).update({ t: 1, tx: [rb(1, 1)] }, run);
    expect(synth.spoken).toHaveLength(0);
  });
});
