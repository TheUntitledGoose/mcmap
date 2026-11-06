// does every preset key still name a control the panel mounts?
(()=>{
const w = window.__world;
const keys = w.panelKeys();
const have = new Set(keys);
const pk = w.presetKeys();
const bad = {};
for (const [name, list] of Object.entries(pk)) {
  const miss = list.filter((k) => !have.has(k));
  if (miss.length) bad[name] = miss;
}
return JSON.stringify({ presets: w.presets(), panelKeys: keys.length, bad, pk });
})();
