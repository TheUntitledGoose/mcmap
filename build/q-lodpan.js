// Pan cost with the baked far layer against the live far grid. Same camera moves, same probes:
// settle at A, jump to B, then sample how long the frames after the jump cost.
const q = process.argv;
const url = (lod) => `http://127.0.0.1:8765/?debug=1&goto=2976,110,2007&dist=400&radius=8&lod=${lod}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(lod) {
  const out = await import('../tools/browser-probe.mjs').then((m) => m.run ?? null);
  return out;
}
console.log('use tools/browser-probe.mjs');
