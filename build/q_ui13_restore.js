// Leave a non-default setting on, then reload with no URL parameters: the page should come back
// pointed the same way. (A fresh browser profile starts with empty storage, which is why this has to
// set something up first in the same run.)
{
  const btn = (n) => [...document.querySelectorAll('.panel-actions button')]
    .find((b) => b.textContent.trim() === n);
  btn('caves').click();
  await new Promise((r) => setTimeout(r, 800));
  const s = __world.state;
  return { clicked: 'caves', cavesOn: s.cavesOn, darkFloor: s.darkFloor, skyScale: s.skyScale,
    storedLen: (localStorage.getItem('darkrpg.viewer.settings.v1') ?? '').length };
}
