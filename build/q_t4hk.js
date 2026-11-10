const w = window.__world;
console.log(JSON.stringify({ keys: Object.keys(w.HIST),
  vals: Object.fromEntries(Object.entries(w.HIST).map(([k, v]) => [k, v instanceof Map ? `Map(${v.size})` : (v && v.constructor && v.constructor.name) || typeof v])) }, null, 1));
