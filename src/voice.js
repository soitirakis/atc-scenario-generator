// Pilot readbacks and requests spoken with the browser's speech synthesis (Web Speech API), offline:
// only voices installed on this computer (localService) are used. Each transmission in the
// simulator's radio log (Sim.tx) is said during its own slot, and cut at the slot's end, so speech
// follows the radio timing. The words come from src/phraseology.js.
import { transmissionText, voiceProfile, fitRate } from './phraseology.js';

export class Voice {
  constructor(synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
    this.synth = synth || null; this.U = Utterance || null;
    this.muted = false; this.volume = 0.8; this.voices = [];
    this.spoken = new Set(); this.current = null; this.lastT = -1; this.onchange = null;
    if (this.synth) {
      this.loadVoices();
      if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', () => this.loadVoices());
    }
  }
  loadVoices() {
    this.voices = (this.synth.getVoices() || []).filter(v => v.localService && /^en(-|_|$)/i.test(v.lang));
    if (this.onchange) this.onchange();
  }
  get available() { return !!(this.synth && this.U) && this.voices.length > 0; }
  /** One line for the voice button's title. */
  status() {
    if (!this.synth || !this.U) return 'This browser has no speech synthesis: pilots are not heard.';
    if (!this.voices.length) return 'No English voice is installed on this computer: pilots are not heard. Add one in the system speech settings.';
    return `Pilot voices: ${this.voices.length} local English voice${this.voices.length > 1 ? 's' : ''}, nothing is sent online.`;
  }
  setMuted(m) { this.muted = !!m; if (this.muted) this.stop(); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, +v)); }
  stop() { if (this.current) { this.current = null; this.synth.cancel(); } }

  /**
   * Call every frame. view is the Sim or the trainee's SimView ({ t, tx }); running and speed are
   * the session's. A transmission is said once, only inside its slot: not when muted or paused,
   * not after the slot has passed, and a request does not talk over a transmission being said.
   */
  update(view, { running, speed = 1 }) {
    if (!this.synth || !view) return;
    const t = view.t;
    if (t < this.lastT) { this.spoken.clear(); this.stop(); } // a new session or a restart
    this.lastT = t;
    if (this.current && (t >= this.current.until || !running)) this.stop();
    for (const tx of view.tx || []) {
      if (this.spoken.has(tx.id) || t < tx.t) continue;
      this.spoken.add(tx.id); // due now: said now or never, so nothing is said late
      if (this.muted || !running || !this.available || t >= tx.until || this.current) continue;
      const text = transmissionText(tx);
      if (!text) continue;
      const p = voiceProfile(tx.cs, this.voices.length), u = new this.U(text);
      u.voice = this.voices[p.voice]; u.lang = u.voice.lang; u.pitch = p.pitch; u.volume = this.volume;
      u.rate = fitRate(text, (tx.until - t) / Math.max(0.25, speed), p.rate).rate;
      const id = tx.id;
      u.onend = () => { if (this.current && this.current.id === id) this.current = null; };
      this.current = { id, until: tx.until, text };
      this.synth.speak(u);
    }
  }
}
