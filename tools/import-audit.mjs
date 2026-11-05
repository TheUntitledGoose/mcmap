// Which import in the shell names something the module on the other end does not export?
// A mismatch there stops the whole module graph from instantiating, and the page sits at
// "starting…" with no visible error.
const fs = require('fs');
const path = require('path');

const start = 'web/js/main.js';
const seen = new Set();

function specToAbs(fromFile, spec) {
  if (spec.startsWith('/')) return path.join('web', spec);
  if (spec.startsWith('./') || spec.startsWith('../')) return path.normalize(path.join(path.dirname(fromFile), spec));
  return null;                                     // bare specifier (three) - skip
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      names.add((t.split(/\s+as\s+/).pop() || t).trim());
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

const queue = [start];
const problems = [];
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f) || !fs.existsSync(f)) continue;
  seen.add(f);
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = specToAbs(f, m[2]);
    if (!target || !fs.existsSync(target)) continue;
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      const exp = exportsOf(target);
      for (const part of braces[1].split(',')) {
        const t = part.trim(); if (!t) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (!exp.has(name)) problems.push(`${f}: '${name}' not exported by ${target}`);
      }
    }
    queue.push(target);
  }
}
console.log(`modules walked: ${seen.size}`);
console.log(problems.length ? problems.join('\n') : 'no named-import/export mismatches');
