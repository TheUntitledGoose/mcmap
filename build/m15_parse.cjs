// Parse a browser-probe log that ends with a `console:` block, and print one key of the JSON the probe
// printed. The harness wraps the page's console output as `log: {...}`, and appends an `errors (...)`
// section (usually just favicon 404s) after it, so the JSON is found by brace matching, not to end of file.
const fs = require('fs');
const t = fs.readFileSync(process.argv[2], 'utf8');
const want = (process.argv[3] || 'atPeak').split(',');
const at = t.indexOf('log: {');
if (at < 0) { console.log('no JSON printed'); process.exit(1); }
let depth = 0, end = -1;
for (let i = at + 5; i < t.length; i++) {
  if (t[i] === '{') depth++;
  else if (t[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
}
const j = JSON.parse(t.slice(at + 5, end));
const out = {};
for (const k of want) out[k] = j[k];
console.log(JSON.stringify(out, null, 1));
