// Print probe eval results as one line per row, whatever field names the probe used.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  let printed = false;
  for (const m of t.matchAll(/eval #\d+ \(\d+ chars\) =>/g)) {
    let blob = t.slice(m.index + m[0].length);
    const cut = blob.indexOf('\npage state:'); if (cut > 0) blob = blob.slice(0, cut);
    let v; try { v = JSON.parse(blob); } catch { continue; }
    const rows = Array.isArray(v) ? v : [v];
    for (const r of rows) {
      const parts = Object.entries(r)
        .filter(([k, x]) => k !== 'label' && k !== 'detailR' && k !== 'payloadR' && x !== '' && x != null)
        .map(([k, x]) => `${k} ${x}`);
      const dim = r.detailR ? ` d${r.detailR} p${r.payloadR}` : '';
      console.log(` ${r.label ?? '(row)'}${dim} | ${parts.join(' | ')}`);
      printed = true;
    }
  }
  if (!printed) console.error(`no eval result in ${f}`);
}
