// parse-probe — read a browser-probe log and print the probe-grid payload as a table, so extracting
// the eval output from a probe log stops being a quoting exercise.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('eval #'));
// the last eval is the probe payload; earlier ones are the setup evals
const line = lines[lines.length - 1];
if (!line) {
  console.log('no eval result in', file);
  console.log(readFileSync(file, 'utf8').split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
const j = JSON.parse(JSON.parse(line.slice(line.indexOf('=> ') + 3)));

if (Array.isArray(j)) {
  // a __probeDump: per-pixel layer truth
  for (const e of j) {
    console.log(`at ${JSON.stringify(e.at)} fb ${JSON.stringify(e.fb.slice(0, 3))}`);
    for (const s of e.stack) {
      console.log(`   ${String(s.k).slice(0, 36).padEnd(36)} op ${s.op} face ${s.face}`
        + ` mesh ${JSON.stringify(s.mesh)} exp ${JSON.stringify(s.exp)} tex ${s.tex}`);
    }
  }
} else {
  console.log(`sample ${j.sample} sky ${j.sky}`);
  for (const r of j.rows) {
    console.log(`${r.state.slice(0, 38).padEnd(38)} ${r.drawn} px ${String(r.px).padStart(5)}`
      + ` inner ${String(r.inner).padStart(4)} obs ${JSON.stringify(r.imean ?? r.mean)}`
      + ` exp ${JSON.stringify(r.exp)} dmax ${r.dmax} layers ${r.layers}`
      + ` tex ${(r.tex || '-').split('/').pop()} tint ${r.tint}`);
  }
}
