// Pull the eval result rows out of a browser-probe transcript and print one line per phase.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  const s = t.indexOf('=> [');
  // Bracket-walk to the matching ]: the rows contain nested objects, so searching for a closing ]
  // or for "screenshot:" lands inside the middle of the JSON.
  let i = s + 3, depth = 0, end = -1;
  for (; i < t.length; i++) {
    if (t[i] === '[') depth++;
    else if (t[i] === ']') { depth--; if (!depth) { end = i + 1; break; } }
  }
  const body = end > 0 ? t.slice(s + 3, end) : '';
  let rows;
  try { rows = JSON.parse(body); } catch (err) { console.log(f, 'parse failed', err.message); continue; }
  console.log('== ' + f);
  for (const r of rows) {
    console.log([
      r.label.padEnd(16),
      'key=' + (r.keyOn !== undefined ? r.keyOn : (r.meshed !== undefined ? '-' : '?')),
      'builds=' + String(r.builds ?? '-').padStart(4),
      'same=' + String(r.same ?? '-').padStart(4),
      'defer=' + String(r.defer ?? '-').padStart(4),
      'newChunks=' + String(r.newChunks ?? '-').padStart(4),
      'cuts=' + String(r.patchCuts ?? '-').padStart(4),
      'dirtyPatch=' + String(r.dirtyPatchEnd ?? '-').padStart(4),
      'why=' + JSON.stringify(r.why ?? {}),
      'meshedByWhy=' + JSON.stringify(r.byWhy ?? {}),
    ].join(' '));
  }
}
