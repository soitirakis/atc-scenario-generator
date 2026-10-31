// Best achievable label layout for a frame, used by the label overlap test.
// Searches the same four positions the renderer uses (NE, SE, SW, NW) for the layout with the
// lowest worst-pair overlap. Seeded restarts plus local search: deterministic, and close to optimal
// for the 20 or so labels of an advanced session.
import { LW, LH, SLOTS } from '../../src/render.js';

const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

/** Worst pairwise overlap, as a fraction of a label's area, for boxes [x, y, w, h]. */
export function worstOverlap(boxes) {
  let w = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) w = Math.max(w, overlap(boxes[i], boxes[j]) / (LW * LH));
  return w;
}

/** plots: [[x, y]] of the labelled tracks. Returns the lowest worst overlap found. */
export function bestWorstOverlap(plots, { restarts = 120, steps = 600, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const box = (k, slot) => [plots[k][0] + SLOTS[slot][0], plots[k][1] + SLOTS[slot][1], LW, LH];
  const worst = sl => worstOverlap(sl.map((slot, k) => box(k, slot)));
  let best = 1;
  for (let r = 0; r < restarts && best > 0; r++) {
    const sl = plots.map(() => Math.floor(rnd() * 4));
    let w = worst(sl);
    for (let n = 0; n < steps && w > 0; n++) {
      const k = Math.floor(rnd() * plots.length), slot = Math.floor(rnd() * 4), old = sl[k];
      sl[k] = slot;
      const nw = worst(sl);
      if (nw <= w) w = nw; else sl[k] = old;
    }
    best = Math.min(best, w);
  }
  return best;
}
