// compact rows from build/q_dragab.js output
let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const m = s.match(/eval #1 \(\d+ chars\) => ([\s\S]*?)\npage state/);
  if (!m) { console.error('no eval line'); process.exit(1); }
  const rows = JSON.parse(JSON.parse(m[1].trim()));
  for (const r of rows) {
    console.log(
      (r.note + '            ').slice(0, 14),
      'fps', String(r.fps).padStart(4), 'gpu', String(r.gpu).padStart(5),
      'submit', String(r.submit).padStart(5), 'js', String(r.js).padStart(5),
      'shell', String(r.shell).padStart(5), 'mesh', String(r.mesh).padStart(5),
      '| M verts', String(r.verts).padStart(5), 'drawn', String(r.drawn).padStart(5),
      '| far[d,c,ms]', JSON.stringify(r.far).padStart(16),
      '| pool', JSON.stringify(r.pool).padStart(24), '| lod', JSON.stringify(r.lod),
      '| parkMB', r.park);
  }
});
