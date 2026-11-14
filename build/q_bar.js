// The loading bar, measured rather than looked at. Three things have to hold:
//   - at rest the bar is GONE: an element in the frame that animates is a pixel-diffing probe's worst enemy,
//     and a bar that claims work after the work is done is a lie;
//   - during real work it appears, says what it waits on with numbers, and its shape matches the counters
//     (a fraction only when every wait has a total);
//   - it goes away when the page settles, and the two idle grabs it produces agree pixel for pixel.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const el = document.getElementById('pbar');
const fill = document.getElementById('pbar-fill');
const txt = document.getElementById('pbar-txt');
const vis = () => !!el && getComputedStyle(el).display !== 'none';
const snap = () => { const s = w.progress(); const q = w.state;
  return { shape: s.shape, pct: s.pct === null ? null : +s.pct.toFixed(3), pending: s.pending,
    parts: s.parts.map((p) => `${p.key}:${p.done}/${p.total === null ? "?" : p.total}`), text: s.text,
    // the counters the sentence is built from, so "still waiting" can be told from "still working";
    // dirtyPatches is the far ground the page has not re-cut, chunks/inflight are the ones it has not fetched.
    real: { dirtyPatches: q.dirtyPatches ?? null, dirty: q.dirty ?? null, queued: q.queued ?? null, chunks: q.chunks ?? null } }; };
const out = { barUrl: new URLSearchParams(location.search).get('bar') ?? '(default on)' };
let everVisible = false;

out.exists = !!el;
out.wired = {
  fill: !!fill, text: !!txt,
  loadingClass: document.body.classList.contains('loading'),
};
const box = el ? el.getBoundingClientRect() : null;
out.rect = box ? [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)] : null;
out.inFrame = box ? box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight : false;

// 1. at rest
await settle(2500);
everVisible = everVisible || vis();
out.atRest = { visible: vis(), ...snap() };

// 2. a real pan: everything around a new place has to be fetched, cut and re-cut
w.fit();
let saw = null, tries = 0;
while (tries++ < 40 && !saw) {
  await settle(150);
  const s = w.progress();
  everVisible = everVisible || vis();
  if (s.shape !== 'settled' && vis()) {
    saw = { shape: s.shape, pct: s.pct === null ? null : +s.pct.toFixed(3), text: s.text,
      keys: s.parts.map((p) => `${p.key}:${p.done}/${p.total === null ? '?' : p.total}`),
      fillWidth: getComputedStyle(fill).width, stripe: el.classList.contains('stripe') };
  }
}
out.during = saw ?? { err: 'the bar never appeared during a whole-world pan' };

// 3. the frame must be still while the bar is supposed to be gone: two grabs, then wait it out
const grab = () => { const g = w.grab(); return g.buf; };
const diff = (A, B) => { let n = 0; for (let i = 0; i < Math.min(A.length, B.length); i += 4) { if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 6) n++; } return n; };
let quiet = -1;
for (let i = 0; i < 40; i++) {
  await settle(500);
  if (!vis()) { const A = grab(); await raf(); await raf(); quiet = diff(A, grab()); break; }
}
out.afterSettle = { visible: vis(), ...snap(), frameDiff: quiet };
// With ?bar=0 the element must NEVER be in the picture, even across a whole-world pan that puts 455
// far patches on the list: an animated stripe is a moving pixel and contaminates every framebuffer A/B.
out.everVisible = everVisible;
out.honest = out.barUrl === '0' ? (everVisible ? 'BAR OFF ASKED, BAR STILL PAINTED' : 'off means off')
  : (everVisible ? 'shown while work was owed' : 'never shown: nothing was owed, or the counters are blind');
console.log('BAR ' + JSON.stringify(out));
