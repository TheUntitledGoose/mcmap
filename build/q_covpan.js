// Region coverage in the browser: does the page stop asking for ground this save never wrote,
// and does the picture stay identical? Swept pan, counted from the browser's own resource
// timeline, so the numbers are requests and bytes rather than a theory about the queue.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
for (let i = 0; i < 100 && !window.__world; i++) await sleep(100);
const w = window.__world;
if (!w) return { err: 'no window.__world after 10 s' };
const wait = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };

out.settings = { dim: w.dim(), covSetting: w.ground().setting, radius: w.state.radius, dist: w.state.dist };
out.ground = w.ground();

// The pan: eight hops along a diagonal of the save's bounding box. The overworld's region grid is
// -11,-21 over 34x51 cells and holds 437 of those 1,734 files, so a straight line across it spends
// most of its length over rectangles that were never written.
// Count only the pan. The resource buffer also holds every module and worker import the page
// fetched at boot, and its default 250-entry cap silently drops the later entries - which is how a
// pan that asked for 60 tiles can look like it asked for none.
performance.setResourceTimingBufferSize(20000);
performance.clearResourceTimings();

// The pan, chosen from the save's own region listing (`node` over DarkRPG/world/region): the first
// three hops sit on ground the save has, hops 4-7 land in the empty run at region row rz 20..23,
// which is 23 cells wide with no file in it. At the default detail radius (payloadR 13, tile 6) a
// 27x27 request box is 25 tiles, and the listing says 21 of them are void from hop 3 on: so these
// 8 hops ask for 200 tiles of which 121 cannot contain a chunk.
const hops = [
  [200, 72, 200], [1029, 72, 1800], [1857, 72, 3400], [2686, 72, 5000],
  [3514, 72, 6600], [4343, 72, 8200], [5171, 72, 9800], [6000, 72, 11400],
];
const fetchCounts = () => {
  const byPath = {};
  for (const e of performance.getEntriesByType('resource')) {
    const p = new URL(e.name).pathname;
    const b = byPath[p] ?? (byPath[p] = { n: 0, bytes: 0 });
    b.n++; b.bytes += e.encodedBodySize || 0;
  }
  const kb = (p) => Math.round((byPath[p]?.bytes ?? 0) / 1024);
  return {
    byPath, fetches: performance.getEntriesByType('resource').length,
    voxels: byPath['/voxels']?.n ?? 0, voxelsKb: kb('/voxels'),
    shells: byPath['/shells']?.n ?? 0, shellsKb: kb('/shells'),
    lod: byPath['/lod']?.n ?? 0, lodKb: kb('/lod'),
  };
};

const seen = [];
for (const [x, y, z] of hops) {
  w.go(x, y, z);
  await wait(900);
  seen.push({ at: [x, z], chunks: w.state.chunks, queued: w.state.queued, missing: w.state.missing, verts: w.state.verts });
}
// Come back to the covered end and settle: the picture there is the correctness half of this A/B.
// A skip that hid real ground would show up as a hole in this frame, not as a smaller fetch count.
w.go(200, 72, 200);
await wait(2500);

out.pan = fetchCounts();

// Then park over void: what the queue used to do there is a permanent trickle of tiles the server
// answers with nothing, and the idle refill runs four times a second forever.
w.go(6000, 72, 11400);
await wait(1500);
performance.clearResourceTimings();
const skipBefore = { v: w.ground().skipped, s: w.ground().shellSkipped };
await wait(2000);
const c = fetchCounts();
out.parkedOverVoid = {
  ...c,
  // What the stores answered locally during the same window: the fetches that remain are tiles the
  // listing says sit on ground this save has (the skin square reaches back toward it), not skips.
  voxelSkipped: w.ground().skipped - skipBefore.v, shellSkipped: w.ground().shellSkipped - skipBefore.s,
};
out.parkedState = { chunks: w.state.chunks, queued: w.state.queued, inflight: w.state.inflight, missing: w.state.missing };

// back to the covered end for the picture
w.go(200, 72, 200);
await wait(2500);

out.groundAfter = w.ground();
out.last = seen[seen.length - 1];
out.verts = w.state.verts;
out.chunks = w.state.chunks;
out.missing = w.state.missing;
out.fps = Math.round(w.state.fps);
out.errors = [w.state.bootError, w.state.frameError].filter(Boolean);
const shot = w.grab();
out.pixels = { w: shot.w, h: shot.h, nonBlack: 0 };
for (let i = 0; i < shot.buf.length; i += 4) {
  if (shot.buf[i] || shot.buf[i + 1] || shot.buf[i + 2]) { out.pixels.nonBlack++; }
}
return out;
