// Does the page actually know which save it is looking at - and does every request say so?
//
// Three claims, over a live two-world server:
//   1. the page reports the save it was linked to, and the saves on offer;
//   2. every same-origin request it made names that save (a request that named nothing would have been
//      answered by the server's default, which is how a tab ends up drawing one save under another);
//   3. asking for a save that is not here is answered in the corner of the screen, not silently.
//
// Statements, not an IIFE: browser-probe wraps any eval containing `await` in an async function, and a
// wrapper only sees a value if the body `return`s.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
for (let i = 0; i < 40; i++) await raf();          // let the first chunks land
const out = { framing: location.search };
out.world = w.world();
out.worldsHere = w.worldsHere();
out.worlds = (w.worlds() ?? []).map((x) => ({ slug: x.slug, label: x.label, tag: x.worldTag, why: x.problem || '' }));
out.note = w.worldNote();
out.bootError = w.state.bootError ?? null;
out.chunks = w.state.chunks;
out.dims = w.dims();
out.dim = w.dim();

const same = performance.getEntriesByType('resource').filter((e) => {
  try { return new URL(e.name).origin === location.origin; } catch { return false; }
});
const named = same.filter((e) => new URL(e.name).searchParams.has('world'));
out.requests = same.length;
out.namedRequests = named.length;
out.unnamed = same.filter((e) => !new URL(e.name).searchParams.has('world'))
  .map((e) => new URL(e.name).pathname);
out.slugsAsked = [...new Set(named.map((e) => new URL(e.name).searchParams.get('world')))];
out.pathsAsked = [...new Set(named.map((e) => new URL(e.name).pathname))].sort();

// The card's picture is a per-world pack too: `half` ships one, `darkrpg` does not and must fall back.
try {
  const r = await fetch('/embed.png' + (w.world() ? `?world=${w.world()}` : ''));
  out.embed = { code: r.status, bytes: (await r.arrayBuffer()).byteLength };
} catch (e) { out.embed = { err: String(e) }; }
const msg = document.getElementById('msg');
out.hudMsg = msg ? msg.textContent : null;
console.log('M18W ' + JSON.stringify(out));
return out;
