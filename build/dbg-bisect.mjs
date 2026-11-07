import fs from 'node:fs';
import zlib from 'node:zlib';
const f = 'build/cache/e5d20ee9/lit/region/0_0.bin';
function t(label, n, fn) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(i); console.log(label.padEnd(30), ((performance.now() - t0) / n).toFixed(3) + ' ms/call'); }
const cpu = () => { let s = 0; for (let i = 0; i < 1e6; i++) s += i * 3; return s; };
t('pure CPU 1e6 mul-add', 20, cpu);
t('readFileSync 8.6 KB', 200, () => fs.readFileSync(f));
const buf = fs.readFileSync(f);
t('inflateSync 8.6KB->124KB', 200, () => zlib.inflateSync(buf.subarray(4)));
t('inflateSync result MB/s', 5, () => zlib.inflateSync(buf.subarray(4)).length);
