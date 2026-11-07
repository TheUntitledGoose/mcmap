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
 *             fmt, hint, live, end, options, open }]
 *           `live` (default) applies on every input event; otherwise on release only. `end` runs once on
 *           release, after the normal apply, for the part of a control's work that is too heavy per event.
 *           A `section` item opens a collapsible group: every item after it lives inside, until the
 *           next section. Sections exist so the six settings people actually use are not buried
 *           under twenty that only matter for tuning the renderer.
 *   actions [{ label, run, hint }]
 *   width   { get, set, min, max } - the panel's own width in px, when the page wants it remembered.
 *           Dragging the left edge changes it live and commits on release; the page's value is applied
 *           on every refresh, so a stored or URL-seeded width lands on boot.
 * @returns {{ refresh: () => void, busy: () => boolean, toggle: (on?: boolean) => void, set: (key, v) => void }}
 */
export function mountPanel({ title = 'settings', items = [], actions = [], width = null } = {}) {
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
    // One row can ask for a wider value column than the rest. The time machine prints a date stamp and
    // a row count in the same column, and the ellipsis is not an acceptable answer for a timestamp.
    if (it.valw) row.style.gridTemplateColumns = `var(--panel-labw) 1fr ${it.valw}px`;
    const lab = el('span', 'panel-label', it.label);
    if (it.hint) lab.title = it.hint;
    const out = el('b', 'panel-val');
    // `stops` lets one row cover a small useful range and a long reach: 0..64 chunks in 19 named
    // steps, where a linear 0..64 bar would put every sensible value in its first tenth.
    const stops = Array.isArray(it.stops) ? it.stops : null;
    // `typeable` turns the value column into a number field. A stops slider is chosen for a thumb, so it
    // cannot say "3 changes per second"; a row that owns its own reach should still let you type what you
    // mean. The typed value is what the page stores and the thumb merely lands on the nearest stop - the
    // same rule a URL value already follows - and a focused field is never rewritten from under the typist.
    let num = null;
    if (it.typeable) {
      num = el('input', 'panel-valnum');
      num.type = 'number';
      num.min = String(it.numMin ?? it.min ?? 0);
      num.max = String(it.numMax ?? it.max ?? 1e6);
      num.step = String(it.numStep ?? 1);
      num.value = it.get();
      if (it.hint) num.title = it.hint;
      num.addEventListener('change', () => it.set(+num.value));
    }
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
      // A row can cost more the moment the thumb is let go than it costs while dragging. `end` is that
      // second half: the playhead row moves decals on every input event and only re-cuts terrain once the
      // gesture ends, which is what lets a live scrub stay cheap.
      if (it.end) input.addEventListener('change', () => it.end(stops ? atStop(stops, +input.value) : +input.value));
    }
    if (it.kind === 'select') row.append(lab, input);
    else row.append(lab, input, num ?? out);
    slot.append(row);
    rows.set(it.key, {
      it, input, out, num, stops,
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

  const refreshRow = ({ it, input, out, fmt, max, stops, num }) => {
    const v = it.get();
    if (it.kind === 'check') {
      input.checked = !!v;
      // A tick can still be worth a sentence: a check row that declares `fmt` says what it is on
      // about ("on - to 739 m"), which is the part a tick cannot show. Rows without one stay bare.
      if (it.fmt) out.textContent = fmt(v);
    } else if (it.kind === 'select') { if (input.value !== String(v)) input.value = v; }
    else {
      // A slider whose reach depends on other settings (the zoom slider tops out where the far
      // view runs out) gets its ceiling here, so it cannot be dragged into empty sky.
      if (max) input.max = max();
      if (document.activeElement !== input) input.value = stops ? stopIndex(stops, v) : v;
      if (num) { if (document.activeElement !== num) num.value = v; }
      else out.textContent = fmt(v, it.step ?? 1);
    }
  };
  const refreshNote = (n) => { const t = noteText(n.it); if (n.node.textContent !== t) n.node.textContent = t; };
  const refresh = () => {
    if (width && !drag) applyW(+width.get());
    for (const n of notes) refreshNote(n);
    for (const r of rows.values()) refreshRow(r);
  };
  // A subset refresh, because the time machine moves its playhead every frame and the full sweep repaints
  // every sentence in the panel (several of which do arithmetic). Rows and notes are named by key; an
  // unnamed note is only reached by the full sweep, which the frame loop still runs once a second.
  const refreshRows = (keys) => {
    for (const k of keys) {
      const r = rows.get(k);
      if (r) refreshRow(r);
      for (const n of notes) if (n.it.key === k) refreshNote(n);
    }
  };
  // A slider being dragged must not be rewritten from the page's state mid-gesture, and a slider
  // the camera moves under the user's thumb (zoom follows the mouse wheel) must be kept honest.
  let busy = false;
  for (const r of rows.values()) {
    for (const node of [r.input, r.num]) {
      if (!node) continue;
      node.addEventListener('pointerdown', () => { busy = true; });
      node.addEventListener('keydown', () => { busy = true; });
      node.addEventListener('keyup', () => { busy = false; });
    }
  }
  window.addEventListener('pointerup', () => { busy = false; });
  window.addEventListener('pointercancel', () => { busy = false; });
  window.addEventListener('blur', () => { busy = false; });

  // The panel's own width. A strip down the left edge drags it; the number belongs to the page, so it
  // is remembered, URL-seedable and probeable like every other setting, and a drag commits on release
  // instead of writing a store entry per pointermove.
  const wmin = width?.min ?? 300, wmax = width?.max ?? 760;
  const clampW = (v) => Math.max(wmin, Math.min(wmax, Math.round(+v || wmin)));
  const applyW = (v) => { root.style.setProperty('--panelw', `${clampW(v)}px`); };
  let drag = null;
  if (width) {
    const grip = el('div', 'panel-grip');
    grip.title = 'drag to resize the panel (or use the panel width row)';
    root.append(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // Capture so a fast drag that leaves the strip keeps working. A synthetic pointer (a probe) has
      // no active pointer to capture, and the browser says so - which must not cost the drag.
      try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      grip.classList.add('dragging');
      drag = { x: e.clientX, w: clampW(width.get()), moved: false };
      applyW(drag.w);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // The panel is anchored to the right edge of the window, so pulling left is what widens it.
      const w = clampW(drag.w + (drag.x - e.clientX));
      if (w !== drag.w) { drag.w = w; drag.moved = true; }
      applyW(w);
    });
    const end = () => {
      if (!drag) return;
      grip.classList.remove('dragging');
      if (drag.moved) width.set(drag.w);
      drag = null;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

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
    refreshRows,
    keys: () => [...rows.keys()],
    widthPx: () => Math.round(root.getBoundingClientRect().width),
    busy: () => busy,
    toggle: (on) => setOpen(on === undefined ? root.classList.contains('collapsed') : !!on),
    set: (key, v) => {
      const r = rows.get(key);
      if (r) { r.it.set(v); refresh(); }
    },
  };
}
