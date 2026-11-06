// Compact one-line-per-sample view of build/q_lodflip2.js output.
let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const m = /eval #1 \(\d+ chars\) => ([\s\S]*?)(?:\npage state|\nshot|\n$|$)/.exec(s);
  if (!m) { console.log('no eval output'); console.log(s.slice(0, 400)); return; }
  let rows;
  try { rows = JSON.parse(m[1]); } catch (e) { console.log('parse fail', e.message); console.log(m[1].slice(0, 300)); return; }
  let prev = null;
  for (const r of rows) {
    if (!r.tag) { console.log('tail ' + JSON.stringify(r.flipTail)); continue; }
    const d = prev === null ? '' : ` +${r.flips - prev}`;
    prev = r.flips;
    console.log(`${r.tag.padEnd(8)} flips ${String(r.flips).padStart(4)}${d.padEnd(7)} held ${String(r.held).padStart(4)} drawn ${String(r.drawn).padStart(4)} ask ${JSON.stringify(r.ask)} rel ${r.rel} costIdx ${r.costIdx} verts ${r.verts} L${r.loaded}/D${r.dropped} gaps ${r.gaps}`);
  }
});
