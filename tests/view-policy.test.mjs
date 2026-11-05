// Far-view policy: how far the wheel may pull back, what frustum that needs, how much heightmap
// skin the frame wants, and where the fog closes. These four used to be four unrelated constants
// and the smallest one silently decided where the world ended, which is exactly the "it cuts off
// when I zoom out" bug. The numbers live here so a test can catch the next time they disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CH, fitDistance, maxZoomFor, cornerTan, zoomCeiling, frustumFor, groundReach, skinRadius, fogFor,
  closestApproach, cellForPixels, budgetCell, detailRadius, detailReach, faceFactor, pickEvictions,
} from '../shared/view.mjs';

const PXR_G = 800 / (55 * Math.PI / 180);   // shared: pxPerRad for an 800 px tall window

const wantAt = (dist, fov = 62) =>
  Math.max(dist * Math.tan(Math.min((fov * Math.PI) / 360, 1.35)), Math.max(320, dist * 1.35));

test('fit distance grows with the span and shrinks with the field of view', () => {
  assert.ok(fitDistance(1600, 60) > 800 && fitDistance(1600, 60) < 1600);
  // Doubling the span doubles the pull-back needed to frame it.
  const a = fitDistance(2000, 55), b = fitDistance(4000, 55);
  assert.ok(Math.abs(b / a - 2) < 1e-9, `2x span should be 2x distance, got ${b / a}`);
  // A wider lens frames the same span from closer.
  assert.ok(fitDistance(2000, 90) < fitDistance(2000, 40));
});

test('the wheel ceiling never falls below its floor', () => {
  assert.equal(maxZoomFor(100, 55, 900), 900, 'a tiny skin still lets you pull back to the floor');
  assert.ok(maxZoomFor(4000, 55, 900) > 900);
});

test('frustum: the near plane rides with the distance, the far plane covers the skin', () => {
  const close = frustumFor(40, 640);
  assert.equal(close.near, 0.4, 'eye level keeps a tight near plane, or walking into a block clips');
  assert.ok(close.far >= 40 + 640);

  const far = frustumFor(2500, 96 * CH);
  assert.ok(far.near > 20, `near ${far.near} must leave the ground once the camera is 2.5 km out`);
  assert.ok(far.far >= 2500 + 96 * CH, 'far plane must reach past the skin, or it clips mid-air');
  // Depth precision is the whole point: near/far must stay in a range a 24 bit buffer can handle.
  assert.ok(far.far / far.near < 200, `near/far ratio ${(far.far / far.near) | 0} invites z-fighting`);

  // The near plane must never swallow the orbit target, and it must be continuous: a threshold that
  // jumps is a pop.
  let prev = 0;
  for (let d = 2; d <= 40000; d *= 1.05) {
    const f = frustumFor(d, 0);
    assert.ok(f.near < d, `at dist ${d} the near plane ${f.near} is past the target`);
    assert.ok(f.near - prev < d * 0.01 + 0.5, `near plane jumps ${prev} -> ${f.near} at dist ${d}`);
    prev = f.near;
  }
});

test('frustum: a whole-dimension far plane costs depth precision, not a clipped horizon', () => {
  // The whole-extent overview layer is drawn at every zoom, so it has to be inside the frustum at
  // eye level too. A far plane sized for the per-chunk skin (1600 blocks) cut it off in mid-distance
  // and the cut line moved with the pitch: "the far lods clip when I tilt the camera".
  const ov = frustumFor(40, 26112);
  assert.ok(ov.far >= 26112, `far plane ${ov.far} would cut the far layer off`);
  assert.ok(ov.near > 0.4, 'a 0.4 near against a 26 km far quantises depth to whole blocks out there');
  assert.ok(ov.near < 40, 'and it must still not swallow the orbit target');
  const ratio = ov.far / ov.near;
  assert.ok(ratio < 60000, `near/far ratio ${ratio | 0} is past what a 24 bit buffer resolves`);
  // A dimension-spanning far plane must not cost precision at the close end either: the lift is
  // bounded by the pull-back, so a camera inside terrain keeps a near plane it can see past.
  for (const d of [2, 8, 40, 200]) {
    const f = frustumFor(d, 26112);
    assert.ok(f.near <= Math.max(1, d * 0.25), `at dist ${d} the near plane ${f.near} cuts the room`);
  }
});

test('ground reach is infinite at the horizon and grows with the pull-back', () => {
  const horizon = Math.PI / 180 * 31 - 1e-6;             // top edge level with the horizon
  assert.equal(groundReach(horizon, 500, 62), Infinity);
  assert.equal(groundReach(-0.2, 500, 62), Infinity, 'looking up has no ground to reach');
  assert.equal(groundReach(0, 500, 62), Infinity);

  let prev = 0;
  for (const d of [50, 200, 800, 3200]) {
    const r = groundReach(0.9, d, 62);
    assert.ok(Number.isFinite(r) && r > prev, `reach ${r} must grow with distance (was ${prev})`);
    prev = r;
  }
  // Straight down: the frame reaches a little further than the pull-back, not to the horizon.
  const down = groundReach(1.5, 1000, 62);
  assert.ok(down > 500 && down < 3000, `looking straight down reached ${down} blocks`);
});

test('skin radius tracks the frame, and never exceeds what the browser may hold', () => {
  assert.equal(skinRadius(40, 0, { min: 40, cap: 96 }), 40, 'floor keeps eye level showing mountains');
  assert.equal(skinRadius(20000, 1e9, { min: 40, cap: 96 }), 96, 'cap is a hard ceiling');
  assert.ok(skinRadius(800, 900) > skinRadius(200, 300));
  // Never smaller than the pull-back itself: the camera sits dist blocks from the target.
  for (const d of [2, 60, 900, 5000, 40000]) {
    const r = skinRadius(d, 0, { min: 1, cap: 1e6 });
    assert.ok(r * CH >= d * 1.1, `at dist ${d} a skin of ${r * CH} blocks does not reach the target`);
  }
  // An infinite "want" (looking at the horizon) has to fall back to the cap, not to NaN.
  assert.equal(skinRadius(60, Infinity, { min: 40, cap: 64 }), 64);
  // A ceiling below the floor still must not ask for more than the ceiling: the cap always wins.
  assert.equal(skinRadius(4000, 1e6, { min: 40, cap: 24 }), 24);
});

test('the frame reaches much wider than its vertical fov suggests', () => {
  const half = Math.tan((55 * Math.PI) / 360);
  assert.ok(cornerTan(55, 16 / 9) > half * 1.9, `16:9 corner factor ${(cornerTan(55, 16 / 9) / half).toFixed(2)} looks too small`);
  assert.ok(Math.abs(cornerTan(55, 1) / half - Math.SQRT2) < 1e-9,
    'a square window should reach sqrt(2) past its vertical half angle');
  assert.ok(cornerTan(55, 2.4) > cornerTan(55, 1.3), 'an ultrawide window wants a wider skin');
});

test('the zoom ceiling keeps the eye inside the skin and the corners covered', () => {
  for (const cap of [24, 96, 160]) {
    const d = zoomCeiling(cap, 55, 16 / 9);
    assert.ok(d < CH * cap, `dist ${d | 0} would park the camera outside a ${cap} chunk skin`);
    const want = d * cornerTan(55, 16 / 9);
    assert.ok(want <= CH * cap, `the frame corners reach ${want | 0} blocks past a ${cap} chunk skin`);
    const r = skinRadius(d, want, { min: 40, cap });
    assert.ok(r >= cap * 0.9, `skin only ${r} of ${cap} chunks at the ceiling`);
    // A cap this small saturates long before the ceiling, which is fine - it just means the wheel
    // stops while the skin is already full. Only a big cap can show the skin still growing.
    if (cap >= 96) {
      const q = skinRadius(d / 2, (d / 2) * cornerTan(55, 16 / 9), { min: 40, cap });
      assert.ok(q < cap, `skin already pinned at ${q} chunks halfway to the ceiling`);
    }
    assert.ok(frustumFor(d, CH * cap).far >= d + CH * cap, 'the far plane must still reach the rim');
  }
  assert.ok(zoomCeiling(96, 55, 2.4) < zoomCeiling(96, 55, 1.5),
    'a wider window sees more, so the same skin has to stop the wheel sooner');
});

test('the fog hides the edge of the skin without drowning the view', () => {
  for (const d of [2, 20, 120, 900, 2500, 6000, 15000]) {
    for (const cap of [24, 96, 320]) {
      const skin = skinRadius(d, wantAt(d), { min: 40, cap });
      const f = fogFor(d, skin);
      // Fog distances are measured from the eye. `rim` is how far the edge of the skin is from the
      // eye, so far <= rim is what stops the edge of the map drawing as a cliff...
      const rim = Math.hypot(d, CH * skin * 0.95);
      assert.ok(f.far <= rim + 1e-6, `dist ${d} cap ${cap}: fog far ${f.far} is past the skin rim ${rim}`);
      // ...while far >= dist is what stops the orbit target itself, which is dist away, from being
      // nothing but haze.
      assert.ok(f.far >= d, `dist ${d} cap ${cap}: fog closes at ${f.far}, before the target`);
      assert.ok(f.near < f.far && f.near > 0 && Number.isFinite(f.far));
    }
  }
  // Eye level stays readable: a short pull-back must not bury the horizon in haze.
  const eye = fogFor(40, 40);
  assert.ok(eye.far >= 300, `eye-level fog closes at ${eye.far}, the world would be a wall of haze`);
  // ?fog=2 pushes the fog out, until the edge of the skin is what stops it.
  assert.ok(fogFor(300, 96, { scale: 2 }).far > fogFor(300, 96).far);
  assert.equal(fogFor(300, 24, { scale: 4 }).far, fogFor(300, 24, { scale: 9 }).far,
    'thicker fog cannot buy visibility the skin does not have');
});

test('the zoom ceiling is the point where the skin saturates, not a magic number', () => {
  for (const cap of [96, 256]) {
    const maxZoom = fitDistance(2 * CH * cap, 62);
    // At the ceiling the skin must be exactly full: pulling back further cannot show more world.
    assert.equal(skinRadius(maxZoom, wantAt(maxZoom), { min: 40, cap }), cap);
    // A quarter of the way there it must still be growing.
    const quarter = skinRadius(maxZoom / 4, wantAt(maxZoom / 4), { min: 40, cap });
    assert.ok(quarter < cap, `skin is already pinned at ${quarter} chunks a quarter out`);
    // And the far plane still covers the far edge of the frame at the ceiling.
    assert.ok(frustumFor(maxZoom, cap * CH).far >= maxZoom + cap * CH);
  }
});

// The far grid used to switch on chunk distance from the orbit target, which put the ground an
// arm's length from the lens in the far tier: flat plates with huge straight drop-offs, and the
// switch points did not move when you pulled back. Both decisions now come from screen geometry.
const PXR = 800 / (55 * Math.PI / 180);   // device pixels per radian in an 800 px tall window

test("the far grid is sized by pixels, so a cell never covers more than the budget", () => {
  assert.equal(cellForPixels(100, PXR, 1.5, 16), 1, "point blank must be one block columns");
  assert.ok(cellForPixels(4000, PXR, 1.5, 16) > 1, "the horizon must stay cheap");
  assert.equal(cellForPixels(40000, PXR, 1.5, 16), 16, "the ceiling must be honoured");
  assert.equal(cellForPixels(40000, PXR, 1.5, 4), 4, "a lower ceiling still binds");
  // Monotone in distance, always a power of two (the mesher decimates a 16x16 column grid).
  let prev = 0;
  for (let d = 8; d <= 60000; d = Math.round(d * 1.4)) {
    const c = cellForPixels(d, PXR, 1.5, 16);
    assert.ok(c >= prev, `cell ${c} shrank at ${d} blocks`);
    assert.ok((c & (c - 1)) === 0, `cell ${c} at ${d} blocks is not a power of two`);
    assert.ok(c * PXR / d <= 1.5 + 1e-9 || c === 1, `cell ${c} covers ${(c * PXR / d).toFixed(1)} px at ${d}`);
    prev = c;
  }
});

test("tier distance is the closest an orbit can bring the eye, so dragging cannot retier", () => {
  assert.equal(closestApproach(50, 50), 0, "the eye passes right over it");
  assert.equal(closestApproach(10, 50), 40, "behind the target it never gets nearer than that");
  assert.equal(closestApproach(90, 50), 40, "past the target, the same");
  // Pull right out and nothing in the held skin can be pulled closer, so it all stays coarse.
  const far = 1625;                                   // a 26 km whole-dimension pull-back
  for (let d = 0; d <= 96; d += 12) {
    assert.equal(cellForPixels(closestApproach(d, far) * CH, PXR, 1.5, 16), 16,
      `chunk ring ${d} went fine at a ${far} chunk orbit`);
  }
});

test("at eye level the ground under the camera is detail, not the far tier", () => {
  const near = 40;                                    // a 640 block orbit, standing on the ground
  assert.equal(cellForPixels(closestApproach(0, near) * CH, PXR, 1.5, 16), 1,
    "the ground at the orbit target was being drawn as coarse plates");
  assert.ok(cellForPixels(closestApproach(100, near) * CH, PXR, 1.5, 16) <= 2,
    "a kilometre out should still be near 2 block cells");
});

test("the column budget floors the grid, so pixels cannot bankrupt the page", () => {
  // A 640 block skin at a 400 k column budget: fine close in, cheap at its own edge.
  assert.equal(budgetCell(120, 640, 400000, 1, 16), 1, "the near core must stay one block");
  assert.equal(budgetCell(300, 640, 400000, 1, 16), 2, "300 blocks out should not be one-block columns");
  assert.equal(budgetCell(640, 640, 400000, 1, 16), 4, "the far ring must be coarser still");
  // One global floor spent as much on the horizon as at the near plane; this one does not.
  assert.ok(budgetCell(640, 640, 400000, 1, 16) > budgetCell(120, 640, 400000, 1, 16));
  // A whole-dimension pull-back stays at the ceiling, which is what keeps 26 km readable.
  assert.equal(budgetCell(closestApproach(0, 1625) * CH, 96 * CH, 400000, 1, 16), 16);
  // A tighter budget is coarser everywhere, and nothing escapes the ceiling.
  for (const d of [120, 300, 640, 1500]) {
    assert.ok(budgetCell(d, 640, 100000, 1, 16) >= budgetCell(d, 640, 400000, 1, 16), `d=${d}`);
    assert.ok(budgetCell(d, 640, 400000, 1, 4) <= 4, `d=${d}`);
  }
  // Monotone in distance, always a power of two.
  let prev = 0;
  for (let d = 32; d <= 30000; d = Math.round(d * 1.3)) {
    const c = budgetCell(d, 1536, 400000, 1, 16);
    assert.ok(c >= prev, `cell ${c} got finer at ${d} blocks`);
    assert.ok((c & (c - 1)) === 0, `cell ${c} is not a power of two`);
    prev = c;
  }
});

test('ground seen edge-on pays fewer triangles than ground the eye sits over', () => {
  // Straight down: the ground under the target is face-on, so one block per column stays justified.
  assert.ok(faceFactor(1500, Math.PI / 2, 0) > 0.99, 'looking down: face-on');
  // Near eye level the eye still sits 30 blocks above the ground 1.5 km out (face-on), but ground
  // out towards the horizon runs away: that is where a cell may be many blocks wide.
  assert.ok(faceFactor(1500, 0.02, 1500) > 0.99, '30 blocks overhead is still face-on');
  assert.equal(faceFactor(1500, 0.02, 6000), 0.08, 'the horizon is edge-on, and floored');
  // The case that cost 34 M verts: 1.5 km back at 31 degrees. The ground under the eye is face-on
  // (expensive, and the pixel rule already justifies it), the far side of the frame is not.
  const eyeR = 1500 * Math.cos(0.55);
  assert.ok(faceFactor(1500, 0.55, eyeR) > 0.99, 'directly under the eye: face-on');
  assert.ok(faceFactor(1500, 0.55, eyeR + 1200) < 0.6, 'past the eye: tilting away');
  // Monotone away from the eye's ground position, and never zero: a cell must always be allowed.
  let prev = 2;
  for (let d = eyeR; d <= eyeR + 3000; d += 100) {
    const f = faceFactor(1500, 0.55, d);
    assert.ok(f <= prev + 1e-9, `face factor grew away from the eye at d=${d}`);
    prev = f;
  }
  assert.equal(faceFactor(0, 0, 0), 1, 'a degenerate camera does not divide into nothing');
  assert.ok(faceFactor(0, 0.5, 99999) >= 0.08, 'the factor is floored, not zero');
});

test('the eye-reach behind the detail ring is its own number, and it is bounded', () => {
  assert.equal(detailReach(PXR_G, 1), PXR_G, 'at 1 px, reach = pxPerRad');
  assert.equal(detailReach(PXR_G, 0.5), PXR_G * 2, 'half a pixel reaches twice as far');
  assert.equal(detailReach(PXR_G, 0.1), detailReach(PXR_G, 0.25),
    'the pixel target is floored at 0.25, so no slider setting makes meshing unbounded');
  assert.ok(26000 > detailReach(PXR_G, 1), '26 km is past one-pixel columns');
});

test('full-resolution detail is a pixel budget too, so far chunks stop paying triangles', () => {
  const PXR = 800 / (55 * Math.PI / 180);       // an 800 px tall window at the default 55 deg fov
  // A one-block column 833 blocks away in that window is exactly one pixel across, and that is the
  // reach. It is a *column* measure: sizing it as a 16 block chunk (the first cut of this function)
  // would let full-res geometry run out to 6.6 km to draw a one-pixel column.
  assert.ok(Math.abs(PXR - 833.4) < 0.5, `sanity: pxPerRad ${PXR}`);
  // Up close the user's ceiling is what applies, whatever the ceiling is.
  for (const cap of [0, 4, 8, 14]) assert.equal(detailRadius(40, PXR, 1, cap), cap);
  // The measured regression this exists for: at a 26 km pull-back the detail ring still held 289
  // chunks and 9 443 760 verts, identical to the numbers at 60 blocks. 79% of the frame's triangles,
  // drawing a target a few pixels wide.
  assert.equal(detailRadius(26000, PXR, 1, 8), 0, '26 km out: no voxel detail, the far grid paints it');
  assert.equal(detailRadius(2000, PXR, 1, 8), 0, '2 km out a block is half a pixel: stop meshing it');
  assert.equal(detailRadius(1500, PXR, 1, 8), 0, '1.5 km out: same');
  // The crossover is where a one-block column stops covering `px` pixels: reach = pxPerRad / px.
  assert.ok(detailRadius(800, PXR, 1, 8) > 0, '800 m out a block still spans a pixel');
  assert.equal(detailRadius(900, PXR, 1, 8), 0, '900 m out it does not');
  // Never negative, never above the ceiling, and it never grows as the eye moves away.
  let prev = 99;
  for (let d = 0; d <= 30000; d += 250) {
    const r = detailRadius(d, PXR, 1, 8);
    assert.ok(r >= 0 && r <= 8, `ring ${r} out of range at d=${d}`);
    assert.ok(r <= prev, `detail ring grew at d=${d}`);
    prev = r;
  }
  // Demanding more pixels per block is stricter; a shorter window reaches less far for the same px.
  assert.ok(detailRadius(1500, PXR, 0.5, 8) > detailRadius(1500, PXR, 1, 8));
  assert.ok(detailRadius(1500, PXR / 2, 1, 8) <= detailRadius(1500, PXR, 1, 8));
  // Wherever detail is still drawn, the far grid at that same chunk sits at one column per block
  // too. The two policies must not disagree at the seam, or a demoted ring would fall straight from
  // full voxel detail to a 4 block grid. (`detailPx <= cellPx` is what keeps this true.)
  for (const d of [40, 300, 800, 1500, 9000, 26000]) {
    const r = detailRadius(d, PXR, 1, 8);
    const cell = cellForPixels(closestApproach(r, d / CH) * CH, PXR, 1.5, 16);
    assert.ok(r === 0 || cell === 1, `d=${d}: ring ${r} chunks but grid cell ${cell}`);
  }
});

test('a mesh byte cache loses its farthest entries first, not its oldest', () => {
  // The detail ring refills from the middle of the view outward, so eviction order decides whether
  // coming back is a buffer upload or a re-mesh. Measured both ways at a 64 MB cap: oldest-first
  // eviction left 172 usable chunks parked at the edge of the screen while the middle of the frame
  // was rebuilt at ~51 ms a chunk, and the visible refill took 1.8 s instead of 0.3 s.
  const B = 1000;
  const entries = [];
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) entries.push([`${dx},${dz}`, B, dx, dz]);
  }
  assert.deepEqual(pickEvictions(entries, entries.length * B, [0, 0]), [], 'under budget nothing goes');
  const drop = pickEvictions(entries, 16 * B, [0, 0]);
  assert.equal(drop.length, 9, 'just enough of the farthest corners to get back under cap');
  for (const k of drop) {
    const [cx, cz] = k.split(',').map(Number);
    assert.ok(Math.abs(cx) + Math.abs(cz) >= 3, `${k} is a corner, not the middle`);
  }
  assert.ok(!drop.includes('0,0') && !drop.includes('1,0'), 'the middle of the view survives');
  // Move the camera and the other side of the world becomes the expendable one.
  const moved = new Set(pickEvictions(entries, 16 * B, [2, 2]));
  assert.ok(moved.has('-2,-2') && !moved.has('2,2'), 'the far side follows the camera');
  // Byte sizes, not counts, decide when it stops dropping.
  const fat = [['0,0', 9000, 0, 0], ['9,9', 100, 9, 9], ['8,8', 100, 8, 8]];
  // 9200 over an 8000 cap: the two thin far chunks are not enough on their own, so the near fat
  // one goes too. Dropping stops the moment the total is back under the cap, never earlier.
  assert.deepEqual(pickEvictions(fat, 8000, [0, 0]), ['9,9', '8,8', '0,0'],
    'drops farthest-first until back under the cap');
  assert.deepEqual(pickEvictions(fat, 9100, [0, 0]), ['9,9'], 'one thin far chunk is enough there');
  assert.deepEqual(pickEvictions(fat, 9200, [0, 0]), [], 'exactly at the cap is not over it');
});
