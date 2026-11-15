let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const m = s.match(/ZP \{.*\}/);
  if (!m) { console.log('no ZP'); return; }
  const j = JSON.parse(m[0].slice(3));
  console.log(' view', j.view.replace(/&goto=[^&]*/, ''));
  console.log(' meshByWhy', JSON.stringify(j.meshByWhy), 'why', JSON.stringify(j.why));
  const nums = (t) => t.split(/\s+/).filter((x) => x.indexOf('/') >= 0)[0].split('/').map(Number);
  for (const r of j.rows) {
    const e = nums(r);
    const l = nums(r.split('  late ')[1]);
    const c = (i) => (e[i] === l[i] ? String(e[i]) : e[i] + '->' + l[i]);
    console.log('  ' + r.split(' ')[0].padEnd(6),
      'dr', c(1).padEnd(8), 'pr', c(2).padEnd(8), 'chunks', c(3).padEnd(11),
      'fps', c(4).padEnd(11), 'dirty', c(7).padEnd(10), 'builds', c(8).padEnd(11),
      'verts', c(17));
  }
});
