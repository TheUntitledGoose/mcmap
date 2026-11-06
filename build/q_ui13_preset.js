// Does a preset do what its name says, and does the panel remember it?
// Statements, not an IIFE: browser-probe wraps any probe containing `await`, and a wrapped probe has
// to `return` - an inner async IIFE hands its value to the wrapper's void body and reads back `undefined`.
{
  const btn = (n) => [...document.querySelectorAll('.panel-actions button')]
    .find((b) => b.textContent.trim() === n);
  const pick = () => {
    const s = __world.state;
    return { cavesOn: s.cavesOn, darkcut: s.darkcut, darkFloor: s.darkFloor, skyScale: s.skyScale,
      dist: s.dist, ring: s.detailCeiling, surfaceOn: s.surfaceOn, underFar: s.underFar };
  };
  const before = pick();
  btn('caves').click();
  await new Promise((r) => setTimeout(r, 1000));
  __world.tick(8);
  const after = pick();
  const stored = localStorage.getItem('darkrpg.viewer.settings.v1') ?? '';
  btn('undo').click();
  await new Promise((r) => setTimeout(r, 600));
  return { before, after, undone: pick(), storedLen: stored.length,
    storedHasCaves: /"caves":true/.test(stored) };
}
