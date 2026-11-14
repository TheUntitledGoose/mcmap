// What is the page waiting for, right now, as DATA. DOM-free and three-free like the rest of web/js, so a
// Node test can put the policy against a fake clock instead of trusting a screenshot.
//
// The rule this whole file exists for: a bar may only be as confident as the counters behind it. The page
// knows several different kinds of pending work, and some of them have no total:
//
//   chunks      held / wanted in the ring  -> a real total
//   meshes      built / queued             -> a real total
//   patches     far-grid cuts still dirty  -> often NO total (a pan dirties an unknown area)
//   timeline    rows fetched, buffer built -> a total once the pack is known
//   replay      voxels moved back          -> a total per step
//
// So there are two honest shapes: a fraction when every waiting part has a total, and a stripe plus numbers
// when something pending has no total. A bar that creeps to 99% and sits there is worse than no bar: it
// reads as "almost done" forever. `snapshot()` says which shape it is, and `text()` says what is waiting in
// the page's own words, with counts.
//
// Entries EXPIRE. A counter that stopped being reported is a counter that stopped mattering; leaving it in
// would freeze the bar at some old panic. The writer re-notes every pass it still cares, so a stale entry
// is a finished one.

/** How long a part may stay pending without being re-reported before it is dropped. */
export const STALE_MS = 1500;
/** Below this the page has nothing to say: the world is on screen and nothing is queued. */
export const SETTLED_PCT = 1;

/**
 * A bar's worth of pending work.
 *
 * @param {()=>number} clock   a monotonic clock, injectable so a test can move time
 * @param {number} staleMs     how long an unreported part survives
 */
export function createProgress({ clock = () => 0, staleMs = STALE_MS } = {}) {
  const parts = new Map();          // key -> {key, done, total, label, unit, at, indeterminate}

  /**
   * Report one kind of pending work. `total` may be null (or NaN) when the page genuinely does not know
   * how much there is - a pan dirtying an unknown area, a fetch whose size is not yet known. That is not a
   * licence to guess: it makes the whole snapshot a stripe rather than a fraction.
   */
  function note(key, { done = 0, total = null, label = key, unit = '' } = {}) {
    const d = Number(done) || 0;
    // null / undefined / NaN is "the page does not know", and Number(null) is 0 - which would turn an
    // uncounted wait into a COMPLETED one and make the bar lie the other way.
    const t = total === null || total === undefined ? NaN : Number(total);
    const known = Number.isFinite(t) && t >= 0;
    parts.set(key, {
      key, done: d, total: known ? t : null, label, unit, at: clock(),
      indeterminate: !known || t > d,
    });
  }

  /** This kind of work is finished: drop it rather than let it hold the bar at some fraction. */
  function clear(key) { parts.delete(key); }

  /** Forget everything (a dimension switch, a world reload): the old counts describe another world. */
  function reset() { parts.clear(); }

  function live() {
    const now = clock();
    const out = [];
    for (const [k, p] of parts) {
      if (now - p.at > staleMs) { parts.delete(k); continue; }
      if (p.total !== null && p.done >= p.total) { parts.delete(k); continue; }   // finished work is not pending
      out.push(p);
    }
    return out;
  }

  /**
   * The one answer the HUD draws.
   *
   * `shape`: 'settled' (nothing pending), 'bar' (every waiting part has a total, so a fraction is honest),
   * or 'stripe' (something pending has no known total).
   * `pct`: 0..1 for a bar, null for the other two.
   * `text`: up to three parts, each with its own numbers, the biggest wait first.
   */
  function snapshot() {
    const p = live();
    if (!p.length) return { shape: 'settled', pct: 1, text: '', parts: [], pending: 0 };
    // The weakest link decides the fraction: a bar at 90% while half the meshes are unqueued is a lie.
    let frac = 1;
    for (const q of p) {
      if (q.total === null) continue;
      frac = Math.min(frac, q.total > 0 ? q.done / q.total : 1);
    }
    const stripe = p.some((q) => q.total === null);
    // Order by how much is still owed, so the sentence names the wait that dominates the frame. A part with
    // no total is the most uncertain thing on screen, so it leads.
    const rank = (q) => (q.total === null ? Infinity : q.total - q.done);
    const sorted = [...p].sort((a, b) => rank(b) - rank(a));
    return {
      shape: stripe ? 'stripe' : 'bar',
      pct: stripe ? null : frac,
      text: sorted.slice(0, 3).map(phrase).join(' · '),
      parts: sorted.map((q) => ({ key: q.key, done: q.done, total: q.total, label: q.label, unit: q.unit })),
      pending: p.length,
    };
  }

  function phrase(q) {
    const u = q.unit ? ` ${q.unit}` : '';
    if (q.total === null) return `${q.label}${q.done ? `: ${q.done.toLocaleString()}${u}` : ''}`;
    return `${q.label}: ${q.done.toLocaleString()}/${q.total.toLocaleString()}${u}`;
  }

  return { note, clear, reset, snapshot, parts };
}
