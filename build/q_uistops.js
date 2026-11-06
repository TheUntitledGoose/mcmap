// does the close-detail row still mean what it says, now that the thumb is an index?
// also: a plain linear row must be untouched by the same code path.
(() => {
const w = window.__world;
const rowOf = (label) => {
  for (const r of document.querySelectorAll('.panel-row')) {
    const l = r.querySelector('.panel-label');
    if (l && l.textContent === label) return r;
  }
  return null;
};
const read = (label) => {
  const r = rowOf(label);
  if (!r) return { missing: label };
  const i = r.querySelector('input'), o = r.querySelector('.panel-val');
  return { min: i.min, max: i.max, step: i.step, thumb: i.value, text: o.textContent };
};
const drag = (label, thumb) => {
  const i = rowOf(label).querySelector('input');
  i.value = String(thumb);
  i.dispatchEvent(new Event('change'));
  w.tick(2);
};
const S = () => ({ radius: w.settings.radius, cellpx: w.settings.cellPx, lodquality: w.settings.lodQuality });
const out = {};
out.detailRow = read('close detail');
out.detail0 = S();
w.set('radius', 64); w.tick(2);
out.viaSet64 = { ...S(), row: read('close detail') };
w.set('radius', 12); w.tick(2);
out.viaSet12 = { ...S(), row: read('close detail') };
w.set('radius', 13); w.tick(2);                       // a value that is not on the stop list
out.viaSet13nearest = { ...S(), row: read('close detail') };
drag('close detail', rowOf('close detail').querySelector('input').max);
out.dragToEnd = S();
drag('close detail', 0);
out.dragToStart = S();
drag('close detail', 10);
out.dragThumb10 = S();
drag('close detail', 14);
out.dragThumb14 = S();
// linear rows: step and reach must survive the stops patch
out.farRow = read('far detail');
drag('far detail', 4);
out.farDrag4 = { cellpx: w.settings.cellPx, lodquality: w.settings.lodQuality };
out.qualityRow = read('far world quality');
drag('far world quality', 6);
out.qualityDrag = { lodquality: w.settings.lodQuality };
out.settingsRow = read('close detail');
out.stored = (localStorage.getItem('darkrpg.viewer.settings.v1') || '').length;
return JSON.stringify(out);
})();
