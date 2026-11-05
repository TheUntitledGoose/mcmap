/**
 * M10 check: does pulling back and returning re-mesh the world, or reuse it?
 *
 * The user's complaint was "zooming out and back in deletes my detailed chunks and tanks
 * performance". Two counters answer that: `meshRuns` counts mesher runs (the ~51 ms work) and
 * `reused` counts chunks re-installed from parked vertex bytes. A round trip that adds almost no
 * mesher runs is the fix; one that adds ~one per chunk is the old behaviour.
 *
 *   node build/q-meshcache.js                  # default: 256 MB of parked bytes
 *   node build/q-meshcache.js --off            # ?meshcache=0, the pre-fix behaviour
 *   node build/q-meshcache.js --cache 64       # a cap small enough to force eviction
 *   node build/q-meshcache.js --far 26000      # the whole-world pull-back leg
 */
const off = process.argv.includes('--off');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const cache = arg('--cache', null);          // MB cap, to watch the byte budget bite
const far = +arg('--far', 2400);            // how far the zoom-out leg goes
const tag = off ? 'off' : (cache ? `cap${cache}` : 'on');

const { spawnSync } = await import('node:child_process');
const r = spawnSync('node', ['tools/browser-probe.mjs',
  '--gpu', '--width', '960', '--height', '600',
  '--url', 'http://127.0.0.1:8765/?debug=1&goto=2976,110,2007&dist=400&radius=8' +
    (off ? '&meshcache=0' : (cache ? `&meshcache=${cache}` : '')),
  '--wait', '7000', '--after', '9000', '--post', '300',
  '--out', `build/shot_cache_${tag}.png`,
  '--eval', `(() => { const el = document.querySelector('#panel') || document.querySelector('.panel'); if (el) el.style.display = 'none'; return 1; })()`,
  // One page-side round trip so the timings are the page's own, not the harness's.
  '--eval', `(async () => {
    const snap = () => { const s = __world.state; return {
      detail: s.detailMeshes, meshRuns: s.meshed, reused: s.meshReused, parkedMB: s.meshCacheMB,
      parked: s.meshCachedChunks, dropped: s.meshCacheDropped, fps: Math.round(s.fps),
      verts: s.verts, dirty: s.dirty, chunks: s.chunks }; };
    const at = (d) => new Promise((r) => setTimeout(r, d));
    const out = [];
    __world.orbit(null, null, 400); await at(4000);
    out.push(['detail', snap()]);
    __world.orbit(null, null, ${far}); await at(5000);
    out.push(['out ' + ${far}, snap()]);
    const t0 = performance.now();
    __world.orbit(null, null, 400);
    let last = 0;
    for (const m of [250, 750, 1750, 3750, 7750]) {
      await at(m - last); last = m;
      out.push(['+' + Math.round(performance.now() - t0) + 'ms', snap()]);
    }
    return JSON.stringify(out);
  })()`],
  { encoding: 'utf8', timeout: 180000 });
process.stdout.write((r.stdout || '') + (r.stderr || ''));
