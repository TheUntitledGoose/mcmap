// M13: is the panel what it claims to be, and did the readouts actually go away?
// Run without ?debug=1 - that is the whole point of the change.
(() => {
  const txt = (n) => (n ? n.textContent.trim() : null);
  const openRows = [...document.querySelectorAll('.panel-body > .panel-row .panel-label')].map(txt);
  const ranges = [...document.querySelectorAll('.panel-row')]
    .filter((r) => r.querySelector('input[type=range]')).map((r) => txt(r.querySelector('.panel-label')));
  return {
    url: location.href.replace(/^http:\/\/127.0.0.1:8765/, ''),
    bodyClass: document.body.className,
    hudShown: getComputedStyle(document.getElementById('hud')).display !== 'none',
    helpOpacity: getComputedStyle(document.getElementById('help')).opacity,
    pill: txt(document.getElementById('pill')),
    fpsInPill: txt(document.getElementById('fps')),
    msgInPill: txt(document.getElementById('msg')),
    panelTitle: txt(document.querySelector('.panel-title')),
    panelCollapsed: document.querySelector('.panel')?.classList.contains('collapsed') ?? null,
    panelWidth: document.querySelector('.panel')?.getBoundingClientRect().width,
    openRows,
    sections: [...document.querySelectorAll('.panel-section')].map((d) => ({
      label: txt(d.querySelector('summary')), open: d.open,
      rows: d.querySelectorAll('.panel-row').length,
    })),
    buttons: [...document.querySelectorAll('.panel-actions button')].map(txt),
    zoomSlider: ranges.includes('zoom'),
    ranges: ranges.length,
    keys: window.__world?.panelKeys?.().length ?? null,
    presets: window.__world?.presets?.() ?? null,
    stored: (localStorage.getItem('darkrpg.viewer.settings.v1') ?? '').length,
  };
})()
