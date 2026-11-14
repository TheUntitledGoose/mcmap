// Every request the page makes has to name the save it means.
//
// A server can hold several saves (`--worlds <dir>`), and its rule is that a request naming a save is
// answered by that save or refused. The page's half of that rule is plumbing: the slug is read once off
// the address bar, kept in one module, and put on every URL - chunk payloads, shells, baked tiles, the
// ledger, the atlas, the skins. If one of those sites is missed, the tab shows a panel from one save over
// terrain from another and has nothing on screen to admit it, which is the exact wrong answer the
// server-side refusal was built to prevent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setWorldSlug, worldSlug, withWorld, worldHref, worldOptions } from '../web/js/world-param.js';
import { ChunkStore } from '../web/js/store.js';
import { ShellStore } from '../web/js/shell-store.js';
import { LodStore } from '../web/js/lod-store.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

test('a URL either names the save this tab means or says nothing', () => {
  setWorldSlug('');
  assert.equal(worldSlug(), '');
  assert.equal(withWorld('/voxels?dim=d&cx0=0'), '/voxels?dim=d&cx0=0',
    'no slug: the server default, and the URL stays as it was');
  setWorldSlug('darkrpg');
  assert.equal(withWorld('/meta'), '/meta?world=darkrpg');
  assert.equal(withWorld('/voxels?dim=d&cx0=0'), '/voxels?dim=d&cx0=0&world=darkrpg');
  // Defensive: the slug arrives from a directory name and the address bar. Even a nonsense one cannot
  // splice itself into another parameter or climb a path.
  setWorldSlug('../../etc?x');
  assert.equal(withWorld('/lod?cell=16'), '/lod?cell=16&world=..%2F..%2Fetc%3Fx');
  setWorldSlug('');
});

test('switching save is a navigation that keeps the framing and drops the dimension', () => {
  const href = worldHref('creative', '?world=darkrpg&dim=graveyard%3Apast&x=10&z=-4&lodhide=0');
  const q = new URLSearchParams(href.split('?')[1]);
  assert.equal(q.get('world'), 'creative');
  assert.equal(q.get('x'), '10', 'zoom and framing carry over');
  assert.equal(q.get('lodhide'), '0');
  assert.ok(!q.has('dim'), 'a dimension is a claim about a save, and the next save may not have it');
  assert.ok(href.startsWith('/'), 'it is an address on this server, not a hand-built concatenation');
  assert.equal(worldHref('a', ''), '/?world=a');
  assert.equal(worldHref('', '?dim=x&z=1'), '/?z=1', 'naming nothing asks for the server default');
});

test('the World choice lists what is on offer, and counts what cannot render', () => {
  const w = worldOptions([
    { slug: 'darkrpg', label: 'DarkRPG' },
    { slug: 'creative', label: 'creative' },
    { slug: 'broken', label: 'broken', problem: 'no build/assets/atlas.json' },
  ]);
  assert.deepEqual(w.options.map((o) => o.value), ['darkrpg', 'creative'],
    'a save that cannot render is not offered; it is counted, with its reason');
  assert.deepEqual(w.broken, [{ slug: 'broken', why: 'no build/assets/atlas.json' }]);
  // Two saves can legitimately share a LevelName. Then the slug is the only thing that tells them apart,
  // and a dropdown of two identical rows is how someone ends up looking at the wrong one.
  const same = worldOptions([{ slug: 'one', label: 'world' }, { slug: 'two', label: 'world' }]);
  assert.deepEqual(same.options.map((o) => o.label), ['one', 'two']);
});

test('the three streaming layers put the save on the tile URL they build', async () => {
  setWorldSlug('darkrpg');
  const urls = [];
  globalThis.fetch = (url) => {
    urls.push(String(url));
    return Promise.resolve({ ok: false, status: 404, arrayBuffer: async () => null });
  };
  const cs = new ChunkStore('minecraft:overworld', { ring: 1, tile: 2 });
  cs.request(0, 0, 1);
  const ss = new ShellStore('minecraft:the_nether', { tile: 4 });
  ss.request(0, 0, 4);
  for (let i = 0; i < 40 && (cs.inflight || cs.queue.length || ss.inflight || ss.queue.length); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const lod = new LodStore('minecraft:overworld', {
    policy: { groundFar: 1, waterOpacity: 0.72, aoFar: 0.949, lightOn: 1,
      darkFloor: 0.32, darkGamma: 0.72, skyScale: 1 },
    fetchFn: async () => ({ ok: false }),
  });
  urls.push(lod.url(16, 2, -3));
  await new Promise((r) => setTimeout(r, 20));
  setWorldSlug('');

  assert.ok(urls.length >= 3, `three layers asked for something: ${urls.length}`);
  for (const u of urls) {
    const q = new URL(u, 'http://x').searchParams;
    assert.equal(q.get('world'), 'darkrpg', `${u} names the save`);
    assert.ok(q.get('dim'), `${u} still says which dimension`);
  }
  assert.match(lod.url(16, 0, 0), /^\//, 'with no slug the URL is left alone');
});

test('no page request is allowed to omit the save, except the one that asks for the default', () => {
  // This is the guard that keeps the claim true as the page grows: every fetch site in the page's own
  // modules must go through withWorld(), so a new feature cannot quietly ask for "whatever".
  const files = ['../web/js/main.js', '../web/js/store.js', '../web/js/shell-store.js'];
  let seen = 0, named = 0;
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((ln, i) => {
      if (!/fetch\(/.test(ln) && !ln.includes('.src =')) return;
      const t = ln.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      seen++;
      if (t.includes('withWorld(')) { named++; return; }
      // A tile request built two lines up is still a named request: `const url = withWorld(...)` then
      // `fetch(url)`. The variable has to come from that call, so the window is checked, not guessed.
      const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      const arg = (t.match(/fetch\(\s*([A-Za-z_$][\w$]*)\s*\)/) ?? [])[1];
      if (arg && window.includes(`const ${arg} = withWorld(`)) { named++; return; }
      // Exactly one deliberate exception, marked where it stands: after a refusal the page asks once
      // for whatever this server defaults to, so the panel can show what does exist.
      const prev = (lines[i - 1] ?? '').trim();
      assert.ok(prev.includes('whatever this box defaults to'),
        `${f}:${i + 1} fetches without naming the save:\n      ${t}`);
    });
  }
  assert.ok(named >= 14, `enough call sites are watched to be a guard: ${named} of ${seen}`);
  assert.equal(seen - named, 1, 'exactly one unnamed request, the fallback');
  // An <img> src is a request too: the skin strip belongs to a save like everything else.
  assert.match(read('../web/js/main.js'), /i\.src = withWorld\('\/skins\/strip\.png'\)/);
});

test('the slug is set before the first byte is asked for', () => {
  const src = read('../web/js/main.js');
  const at = src.indexOf("setWorldSlug(params.get('world'))");
  assert.ok(at > 0, 'the address bar is read at module scope, not inside boot');
  assert.ok(at < src.indexOf('fetch(withWorld(\'/meta\')'), 'and before /meta, so the first reply names the right save');
  assert.match(src, /setWorldSlug\(meta\.slug \?\? ''\)/,
    'and the slug is confirmed from /meta, so a tab that asked for nothing still names one afterwards');
});

test('a link to a save this box does not have says so on screen', () => {
  const src = read('../web/js/main.js');
  assert.match(src, /let WORLD_NOTE = '';/);
  assert.match(src, /WORLD_NOTE = await metaRes\.text\(\)/, 'the refusal is kept, not thrown away');
  assert.match(src, /that link names a save this server does not have/, 'and is said in the corner');
  assert.match(src, /key: 'world', label: 'save', kind: 'select', nostore: true/,
    'and the panel offers the choice, without a stored snapshot ever switching the save under a boot');
  const w = read('../web/js/world-param.js');
  assert.match(w, /Deliberately not a cookie/);
});
