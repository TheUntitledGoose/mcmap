// Is the page alive, and is its frame loop alive? A probe that hangs is not a slow probe until this answers:
// every settle loop in every probe here awaits requestAnimationFrame, so a frame loop that threw once and
// stopped re-scheduling turns into a silent 7-minute timeout with no console output at all.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const out = { framing: location.search };
let frames = 0;
const t0 = performance.now();
while (performance.now() - t0 < 3000) { await raf(); frames++; }
const st = w.state;
out.rafFramesIn3s = frames;
out.bootError = st.bootError ?? null;
out.frameError = st.frameError ?? null;
out.frameErrors = st.frameErrors ?? null;
out.loopFrames = st.loopFrames ?? null;
out.chunks = st.chunks; out.queued = st.queued; out.inflight = st.inflight;
out.dirty = st.dirty; out.dirtyPatches = st.dirtyPatches ?? null;
out.verts = st.verts; out.tris = st.tris; out.fps = st.fps;
out.time = w.time();
out.progress = w.progress();
out.people = w.ghosts();
out.keys = Object.keys(w).length;
// one click pass, to prove the pick path runs at all (a page whose ownerAt throws looks identical to a slow page)
try { out.owner = w.ownerAt(innerWidth / 2, innerHeight / 2); } catch (e) { out.ownerErr = String(e && e.message || e); }
try { out.marker = w.timeMarkerBox(innerWidth / 2, innerHeight / 2); } catch (e) { out.markerErr = String(e && e.message || e); }
console.log('HEALTH ' + JSON.stringify(out));
