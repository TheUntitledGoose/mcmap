// Completeness audit: every URL knob and panel key the docs promise should exist in the shell.
const fs = require('fs');
const main = fs.readFileSync('web/js/main.js', 'utf8');
const docs = fs.readFileSync('HANDOFF.md', 'utf8') + fs.readFileSync('PLAN.md', 'utf8');
const knobs = new Set([...docs.matchAll(/\?([a-z][a-z0-9]{2,})\b/g)].map((m) => m[1]));
const uiKeys = new Set([...main.matchAll(/\{\s*key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
const miss = [...knobs].filter((k) => !main.includes(k)).sort();
console.log(`documented knobs: ${knobs.size}, missing from shell: ${miss.length}`);
console.log(miss.join(' '));
console.log(`panel rows in shell: ${uiKeys.size}`);
