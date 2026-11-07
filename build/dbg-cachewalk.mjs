// What does #sweepCache actually cost? Same walk it does - readdirSync + statSync over every payload
// file - timed, with progress, because "the server stopped answering for minutes" needs a number
// attached to it. Reads only; deletes nothing.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'build/cache';
const t0 = Date.now();
const files = [];
let total = 0, dirs = 0, missing = 0, last = t0, largest = [];
const walk = (d) => {
  dirs++;
  let ent;
  try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { missing++; return; }
  for (const e of ent) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      try { const st = fs.statSync(p); files.push([p, st.mtimeMs, st.size]); total += st.size; }
      catch { missing++; }
    }
  }
  const now = Date.now();
  if (now - last > 10000) {
    last = now;
    console.log(`  ${((now - t0) / 1000).toFixed(0)}s: ${files.length} files, ${(total / 1e9).toFixed(2)} GB, ${dirs} dirs`);
  }
};
walk(root);
const ms = Date.now() - t0;
// The biggest leaves: which directory holds the bulk of it? (The sweep walks everything regardless.)
const per = new Map();
for (const [p, , sz] of files) {
  const k = p.slice(0, 40);
  per.set(k, (per.get(k) || 0) + sz);
}
largest = [...per].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(JSON.stringify({
  root, ms, sec: +(ms / 1000).toFixed(1), files: files.length, dirs,
  gb: +(total / 1e9).toFixed(2), unreadable: missing,
  avgBytes: files.length ? Math.round(total / files.length) : 0,
  emptyish: files.filter(([, , s]) => s < 64).length,
  largest: largest.map(([k, v]) => [k.replace(/\\/g, '/'), +(v / 1e9).toFixed(2)]),
}, null, 1));
