// Why does a name label sit unpositioned at the corner? Count every gtag and where its parent box is.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(0);
const boxes = [...document.querySelectorAll('#gtags')];
const all = [...document.querySelectorAll('.gtag')];
const w = window.__world;
return {
  boxes: boxes.length,
  boxParent: boxes.map((b) => `${b.parentElement?.tagName}#${b.parentElement?.id || ''} kids=${b.children.length}`),
  boxesInDoc: boxes.filter((b) => document.body.contains(b)).length,
  allTags: all.length,
  tagsInABox: all.filter((e) => e.closest('#gtags')).length,
  stray: all.filter((e) => !e.closest('#gtags')).map((e) => `${e.parentElement?.tagName}.${e.parentElement?.id || ''}`),
  placed: all.filter((e) => (e.style.transform || '') !== '').length,
  g: { shown: w.ghosts().tagsShown, small: w.ghosts().tagsSmall, tagMs: w.ghosts().tagMs, standing: w.ghosts().standing },
};
