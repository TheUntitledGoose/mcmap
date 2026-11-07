// The settings panel. Plain DOM on purpose: no GUI library, no build step, and the markup is small
// enough to read next to the code that uses it.
//
// Every control is bound to a getter/setter pair owned by the page, so the panel is a view over the
// page's own settings object rather than a second copy of them - which is what keeps a URL-seeded
// setting and a slider from drifting apart.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * @param {object} opts
 *   title   header text
 *   items   [{ key, label, kind: 'range'|'check'|'select'|'section', get, set, min, max, maxFn, step,
   *             stops,
 *             fmt, hint, live, options, open }]
 *           `live` (default) applies on every input event; otherwise on release only.
 *           A `section` item opens a collapsible group: every item after it lives inside, until the
 *           next section. Sections exist so the six settings people actually use are not buried
 *           under twenty that only matter for tuning the renderer.
 *   actions [{ label, run, hint }]
 * @returns {{ refresh: () => void, busy: () => boolean, toggle: (on?: boolean) => void, set: (key, v) => void }}
 */
export function mountPanel({ title = 'settings', items = [], actions = [] } = {}) {
  const root = el('div', 'panel');
  const head = el('div', 'panel-head');
  head.append(el('span', 'panel-title', title));
  const collapse = el('button', 'panel-btn', '—');
  collapse.title = 'hide panel (p)';
  head.append(collapse);
  root.append(head);

  const body = el('div', 'panel-body');
  root.append(body);
  const rows = new Map();
  const notes = [];
  // Rows go into `slot`, which a section item swaps for its own <details>. Nothing is inside a
  // section until one is opened, so the top of the panel stays short.
  let slot = body;
  const fmtDefault = (v, step) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2));
  const noteText = (it) => (typeof it.text === 'function' ? it.text() : it.text);
  // A `stops` row is an index over named values. Both directions of that mapping live here so
  // a preset or a probe can still speak in real values, and a value that is not on the list
  // (URL-seeded) lands on the nearest stop instead of being snapped away.
  const atStop = (stops, i) => stops[Math.max(0, Math.min(stops.length - 1, Math.round(i)))];
  const stopIndex = (stops, v) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < stops.length; i++) { const d = Math.abs(stops[i] - v); if (d < bd) { bd = d; best = i; } }
    return best;
  };

  for (const it of items) {
    if (it.kind === 'section') {
      const d = el('details', 'panel-section');
      const s = el('summary', 'panel-section-head', it.label);
      if (it.hint) s.title = it.hint;
      d.append(s);
      body.append(d);
      slot = d;
      if (it.open) d.open = true;
      continue;
    }

    if (it.kind === 'note') {
      // One line of prose, for the things the page does with a gesture rather than a control. The text
      // may be a function, because what the mouse wheel *means* changes with the view mode.
      const n = el('div', 'panel-note', noteText(it));
      if (it.hint) n.title = it.hint;
      notes.push({ node: n, it });
      slot.append(n);
      continue;
    }

    const row = el('label', `panel-row panel-${it.kind ?? 'range'}`);
    const lab = el('span', 'panel-label', it.label);
    if (it.hint) lab.title = it.hint;
    const out = el('b', 'panel-val');
    // `stops` lets one row cover a small useful range and a long reach: 0..64 chunks in 19 named
    // steps, where a linear 0..64 bar would put every sensible value in its first tenth.
    const stops = Array.isArray(it.stops) ? it.stops : null;
    let input;
    if (it.kind === 'check') {
      input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => it.set(input.checked));
    } else if (it.kind === 'select') {
      input = el('select');
      for (const o of it.options ?? []) {
        const opt = el('option', null, typeof o === 'string' ? o : o.label);
        opt.value = typeof o === 'string' ? o : o.value;
        input.append(opt);
      }
      input.addEventListener('change', () => it.set(input.value));
    } else {
      input = el('input');
      input.type = 'range';
      input.min = stops ? 0 : (it.min ?? 0);
      input.max = String(stops ? stops.length - 1 : (it.max ?? 1));
      input.step = stops ? 1 : (it.step ?? 0.01);
      const commit = () => it.set(stops ? atStop(stops, +input.value) : +input.value);
      if (it.live !== false) input.addEventListener('input', commit);
      input.addEventListener('change', commit);      // release, for the controls that re-mesh
    }
    if (it.kind === 'select') row.append(lab, input);
    else row.append(lab, input, out);
    slot.append(row);
    rows.set(it.key, {
      it, input, out, stops,
      fmt: it.fmt ?? ((v) => fmtDefault(v, it.step ?? 1)),
      // A range with no explicit `kind` is still a range - checking `it.kind === 'range'` here was
      // how the zoom slider kept its stale ceiling.
      // a stops row owns its own reach, so the ceiling re-computation must not overwrite it
      max: (it.kind ?? 'range') === 'range' ? (it.maxFn ?? (stops ? null : (() => it.max ?? 1))) : null,
    });
  }

  if (actions.length) {
    const bar = el('div', 'panel-actions');
    for (const a of actions) {
      const b = el('button', 'panel-btn', a.label);
      if (a.hint) b.title = a.hint;
      b.addEventListener('click', () => a.run());
      bar.append(b);
    }
    body.append(bar);
  }

  const refresh = () => {
    for (const n of notes) { const t = noteText(n.it); if (n.node.textContent !== t) n.node.textContent = t; }
    for (const { it, input, out, fmt, max, stops } of rows.values()) {      const v = it.get();
      if (it.kind === 'check') {
        input.checked = !!v;
        // A tick can still be worth a sentence: a check row that declares `fmt` says what it is on
        // about ("on - to 739 m"), which is the part a tick cannot show. Rows without one stay bare.
        if (it.fmt) out.textContent = fmt(v);
      }
      else if (it.kind === 'select') { if (input.value !== String(v)) input.value = v; }
      else {
        // A slider whose reach depends on other settings (the zoom slider tops out where the far
        // view runs out) gets its ceiling here, so it cannot be dragged into empty sky.
        if (max) input.max = max();
        if (document.activeElement !== input) input.value = stops ? stopIndex(stops, v) : v;
        out.textContent = fmt(v, it.step ?? 1);
      }
    }
  };
  // A slider being dragged must not be rewritten from the page's state mid-gesture, and a slider
  // the camera moves under the user's thumb (zoom follows the mouse wheel) must be kept honest.
  let busy = false;
  for (const { input } of rows.values()) {
    input.addEventListener('pointerdown', () => { busy = true; });
    input.addEventListener('keydown', () => { busy = true; });
    input.addEventListener('keyup', () => { busy = false; });
  }
  window.addEventListener('pointerup', () => { busy = false; });
  window.addEventListener('pointercancel', () => { busy = false; });
  window.addEventListener('blur', () => { busy = false; });

  refresh();

  const setOpen = (on) => {
    root.classList.toggle('collapsed', !on);
    collapse.textContent = on ? '—' : '+';
  };
  // The whole header toggles, not just the small button in its corner.
  head.addEventListener('click', () => setOpen(root.classList.contains('collapsed')));

  document.body.append(root);
  return {
    refresh,
    keys: () => [...rows.keys()],
    busy: () => busy,
    toggle: (on) => setOpen(on === undefined ? root.classList.contains('collapsed') : !!on),
    set: (key, v) => {
      const r = rows.get(key);
      if (r) { r.it.set(v); refresh(); }
    },
  };
}
