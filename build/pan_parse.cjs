// Parse a q_panfps probe dump into one line per phase, so A/B runs are comparable at a glance.
const t = process.argv[2] ? require('fs').readFileSync(process.argv[2], 'utf8') : require('fs').readFileSync(0, 'utf8');
const line = t.split('\n').find((l) => l.startsWith('eval #'));
if (!line) { console.error('no eval result in', process.argv[2]); process.exit(1); }
let s = JSON.parse(line.split('=> ')[1]);
if (typeof s === 'string') s = JSON.parse(s);
const f = (v, n) => String(v).padStart(n);
for (const r of s) {
  console.log(String(r.note).padEnd(12), 'fps', f(r.fps, 5),
    'shell', f(r.prof.shell, 6), 'mesh', f(r.prof.mesh, 6), 'ov', f(r.prof.ov, 5),
    'total', f(r.prof.total, 6), '| cutMs', f(r.cutMs, 6), 'cuts', f(r.cuts, 4),
    'dirty', f(r.dirty, 4), 'patches', f(r.patches, 4),
    '| shellMs', f(r.shellMs, 6), 'meshMs', f(r.meshMs, 6),
    '| jobs,posted,dropped,outside', JSON.stringify(r.patch));
}
console.log('peak', JSON.stringify(s[1].peak));
console.log((t.match(/"workerReady": \d+/g) || []).join(' '), (t.match(/"workers": \d+/g) || []).join(' '),
  (t.match(/"fps": [\d.]+/g) || []).slice(0, 3).join(' '), '| page errors:',
  (t.match(/errors \(\d+/g) || []).join(' '));
