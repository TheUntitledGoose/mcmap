// M4: chunk meshing off the render thread.
//
// A chunk mesh costs tens of milliseconds (measured ~23 ms median, 3-4x that over a village), which
// is a visible hitch when it lands inside a frame. This worker imports the very same DOM-free
// modules the Node tests cover - web/js/mesher.js, web/js/assets.js, web/js/lookup.js - so it cannot
// quietly grow its own copy of the world rules. All that crosses the boundary is plain data in and
// typed arrays out.
import { Assets } from './assets.js';
import { meshChunk, NEIGH_COVERED } from './mesher.js';
import { sectionIndex, stateIndexAt, lightLevelAt, skyLevelAt } from './lookup.js';

let assets = null;

// A decoded payload chunk carries closures (stateAt/surfaceAt), which structured clone cannot send,
// so the page sends the plain fields and the worker rebuilds what it needs.
const entries = (chunks) => {
  const map = new Map();
  for (const ch of chunks) map.set(`${ch.cx},${ch.cz}`, { ch, secOf: sectionIndex(ch) });
  return map;
};

self.onmessage = ({ data: m }) => {
  if (m.init) {
    assets = new Assets(m.atlas, m.geo);
    self.postMessage({ ready: true, states: assets.states.length, textures: assets.json.textures.length });
    return;
  }

  const map = entries(m.chunks);
  const chunk = map.get(`${m.cx},${m.cz}`)?.ch;
  if (!chunk) { self.postMessage({ key: m.key, passes: [], stats: null }); return; }

  // Chunks whose voxels nobody holds but whose ground the far layers already paint. The page decides
  // that - only the page knows what the heightmap skin covers - and sends the list, because a face
  // pointing into an unloaded neighbour otherwise grows a wall of dirt that the skin hides anyway.
  const covered = new Set((m.covered ?? []).map(([a, b]) => `${a},${b}`));
  const getCh = (a, b) => map.get(`${a},${b}`);
  const at = (cx, cz, lx, ly, lz) => {
    const v = stateIndexAt(getCh, cx, cz, lx, ly, lz, assets.states.length);
    if (v === -1) {
      const nx = cx + (lx >> 4), nz = cz + (lz >> 4);
      if ((nx !== cx || nz !== cz) && !map.has(`${nx},${nz}`) && covered.has(`${nx},${nz}`)) return NEIGH_COVERED;
    }
    return v;
  };
  // Light arrives as data (codes + nibble arrays on the sections) because a function cannot be sent.
  // The accessor is rebuilt here so the worker resolves neighbour cells exactly like the page does.
  const opts = { ...m.opts };
  if (opts.lightOn) {
    opts.light = (cx, cz, lx, ly, lz) => lightLevelAt(getCh, cx, cz, lx, ly, lz, opts.skyScale ?? 1);
    // Skylight on its own, for the buried-face test: block light cannot tell a lava cavern from a
    // sunlit passage.
    opts.sky = (cx, cz, lx, ly, lz) => skyLevelAt(getCh, cx, cz, lx, ly, lz);
  } else delete opts.sky;
  const t0 = performance.now();
  const { streams, stats } = meshChunk(assets, chunk, at, opts);
  const ms = performance.now() - t0;

  const passes = [], transfer = [];
  for (let pass = 0; pass < streams.length; pass++) {
    const s = streams[pass];                 // meshChunk has already trimmed the streams
    if (!s.count) continue;
    passes.push({ pass, position: s.position, uv: s.uv, color: s.color, count: s.count });
    transfer.push(s.position.buffer, s.uv.buffer, s.color.buffer);
  }
  self.postMessage({ key: m.key, cx: m.cx, cz: m.cz, seq: m.seq, passes, stats, ms }, transfer);
};
