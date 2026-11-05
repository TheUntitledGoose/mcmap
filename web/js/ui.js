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
  // Rows go into `slot`, which a section item swaps for its own <details>. Nothing is inside a
  // section until one is opened, so the top of the panel stays short.
  let slot = body;
  const fmtDefault = (v, step) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2));

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

    const row = el('label', `panel-row panel-${it.kind ?? 'range'}`);
    const lab = el('span', 'panel-label', it.label);
    if (it.hint) lab.title = it.hint;
    const out = el('b', 'panel-val');
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
      input.min = it.min ?? 0;
      input.max = it.max ?? 1;
      input.step = it.step ?? 0.01;
      const commit = () => it.set(+input.value);
      if (it.live !== false) input.addEventListener('input', commit);
      input.addEventListener('change', commit);      // release, for the controls that re-mesh
    }
    if (it.kind === 'select') row.append(lab, input);
    else row.append(lab, input, out);
    slot.append(row);
    rows.set(it.key, {
      it, input, out,
      fmt: it.fmt ?? ((v) => fmtDefault(v, it.step ?? 1)),
      // A range with no explicit `kind` is still a range - checking `it.kind === 'range'` here was
      // how the zoom slider kept its stale ceiling.
      max: (it.kind ?? 'range') === 'range' ? (it.maxFn ?? (() => it.max ?? 1)) : null,
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
    for (const { it, input, out, fmt, max } of rows.values()) {      const v = it.get();
      if (it.kind === 'check') input.checked = !!v;
      else if (it.kind === 'select') { if (input.value !== String(v)) input.value = v; }
      else {
        // A slider whose reach depends on other settings (the zoom slider tops out where the far
        // view runs out) gets its ceiling here, so it cannot be dragged into empty sky.
        if (max) input.max = max();
        if (document.activeElement !== input) input.value = v;
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
  collapse.addEventListener('click', () => setOpen(root.classList.contains('collapsed')));

  document.body.append(root);
  return {
    refresh,
    busy: () => busy,
    toggle: (on) => setOpen(on === undefined ? root.classList.contains('collapsed') : !!on),
    set: (key, v) => {
      const r = rows.get(key);
      if (r) { r.it.set(v); refresh(); }
    },
  };
}
