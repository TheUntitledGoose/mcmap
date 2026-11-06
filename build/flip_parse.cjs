let t = ''; process.stdin.on('data', d => t += d).on('end', () => {
  const i = t.indexOf('eval #1'); if (i < 0) { console.log('no eval output'); console.log(t.slice(0, 800)); return; }
  const j = t.indexOf('=>', i), k = t.indexOf('page state:', j);
  let raw = t.slice(j + 2, k).trim();
  let s; try { s = JSON.parse(raw); if (typeof s === 'string') s = JSON.parse(s); } catch (e) { console.log('parse fail', e.message); return; }
  console.log('cellPx', s.cellPx, 'maxPx', s.maxPx, 'budget', s.budget, 'lodMaxCell?', s.cap, 'indexed', s.indexed, 'bad', s.bad);
  for (const r of s.rows) console.log(r.t.padEnd(7), 'flips', String(r.flips).padStart(4), 'held', String(r.held).padStart(4),
    'drawn', String(r.drawn).padStart(4), 'loaded', String(r.loaded).padStart(5), 'dropped', String(r.dropped).padStart(5),
    'gaps', r.gaps, 'want', r.want, 'infl', r.infl, 'verts', r.verts, 'fps', r.fps, JSON.stringify(r.rung));
  for (const f of (s.flipLog || [])) console.log('   flip', JSON.stringify(f));
});
