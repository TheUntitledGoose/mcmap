// Renderer bootstrap: three.js scene, camera rig, chunk streaming, per-chunk meshes.
// The asset/payload/mesher layers are DOM-free and unit-tested under tests/; this file is kept
// thin on purpose, so a visual bug is usually a scene-graph bug rather than a data bug.
import * as THREE from '/vendor/three.module.js';
import { Assets } from './assets.js';
import { meshChunk, tintOf, FACE_SHADE, NEIGH_COVERED } from './mesher.js';
import { ChunkStore } from './store.js';
import { ShellStore } from './shell-store.js';
import { LodStore } from './lod-store.js';
import { openOverview } from './payload.js';
import { meshShellPatch, meshOverview } from './shell-mesh.js';
import { mountPanel } from './ui.js';
import { HEIGHT_BIAS } from '../../shared/chunk-format.mjs';
import { layerAlpha, stackOver, over, dmax } from '../../shared/composite.mjs';
import { CH, maxZoomFor, cornerTan, zoomCeiling, frustumFor, groundReach, skinRadius, fogFor,
  closestApproach, cellForPixels, budgetCell, detailRadius, detailReach, faceFactor,
  pickEvictions } from '../../shared/view.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const num = (name, def) => {
  const v = params.get(name);
  return v === null || v === '' || !Number.isFinite(+v) ? def : +v;   // +null is 0, so test first
};

// Slider values arrive as floats; most of these settings are counts or must stay inside a range the
// mesher and the stores can actually cope with.
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v | 0));

// M5 shell pass. A shell is 1 KB of heightmap per chunk instead of ~100 KB of voxels, so the whole
// save can stand up as a silhouette while the detail ring streams in behind it. `patch` is the
// patch side in chunks: one patch = one draw call, which is what keeps a 200-chunk-radius view from
// turning into 10k draw calls.
//
// One object holds every number the renderer can be talked into changing, seeded from the URL, so a
// probe URL and a slider describe the same page. The settings panel is a view over this, never a
// second copy of it.
const S = {
  radius: Math.max(0, num('radius', 5)),         // detail (voxel) ring ceiling, in chunks
  detailPx: num('detailpx', 1),            // a 1-block column must cover this many px to earn triangles
  detailLod: !params.has('nodetaillod'),   // off = the old behaviour: full res whatever the zoom
  payloadLead: num('payloadlead', 6),            // chunks of voxel payload kept warm beyond the mesh ring
  skinFloor: Math.max(4, num('minradius', num('far', 40))),  // skin held even at eye level
  skinCap: Math.max(8, num('maxradius', 96)),   // skin ceiling when zoomed out
  patch: Math.max(1, num('patch', 8)),
  skirt: Math.max(0, num('skirt', 24)),
  cellPx: num('cellpx', 1.5),                    // one far-grid cell may cover this many pixels
  cellBudget: Math.max(20000, num('colbudget', 400000)),   // far-grid columns the page will hold
  // ... and the same limit in the unit the GPU actually pays. Columns alone under-count badly: a
  // coarse column still drags cliff walls with it, and measured, one column at cell 1 costs ~12
  // verts, so a "400 k column" budget was letting through 16 M verts of heightmap terrain.
  vertBudget: Math.max(200000, num('vertbudget', 12000000)),
  cellMax: Math.max(1, Math.min(16, num('cellmax', 16))),
  forceCell: params.get('cell') ? Math.max(1, Math.min(16, +params.get('cell') | 0)) : 0,
  blend: Math.min(1, Math.max(0, num('blend', 1))),
  // A coarse cell whose surface is a plant, a flower or a leaf does not have to stand at WORLD_SURFACE:
  // those are not a floor, and hanging a 20 block dirt cliff under a rose is a lie the eye reads as a
  // plateau. 0 = every cell stands at WORLD_SURFACE (the old silhouette), 1 = stand at the top of the
  // solid ground, 2 = stand at MOTION_BLOCKING (between the two). See server/shell.mjs.
  groundFar: Math.max(0, Math.min(1, num('groundfar', 1))),
  budget: num('budget', 8),
  shellBudget: num('sbudget', 10),
  // Render scale, as a multiple of the capped device pixel ratio. Fewer pixels is the one remedy
  // that helps no matter which stage of the pipeline is slow. URL: ?res=0.75
  res: Math.max(0.4, Math.min(2, num('res', 1))),
  // Auto resolution: only while the GPU timer is available and the view is fully loaded.
  resAuto: params.has('noautores') ? 0 : 1,
  targetFps: Math.max(20, Math.min(120, num('targetfps', 60))),
  // How long a block of far terrain waits after new ground arrives under it before it is drawn again.
  shellQuiesce: Math.max(0, num('quiesce', 250)),
  workers: num('workers', -1),
  mipmax: num('mipmax', 4),
  ao: !params.has('noao'),
  aoMin: num('ao', 0.42),
  // M6: the save ships real SkyLight/BlockLight nibble arrays, plus Starlight's uniform markers, so
  // lighting here is decoded rather than approximated. ?nolight keeps the old flat shading for A/B.
  light: !params.has('nolight'),
  // Brightness of a level-0 cell. Vanilla's is near zero, which is right in a game and useless in a
  // map viewer: a cave turns into a black hole that hides the geometry it was generated to show.
  darkFloor: Math.min(1, Math.max(0, num('darkfloor', 0.32))),
  darkGamma: Math.min(1.6, Math.max(0.3, num('darkgamma', 0.72))),
  // Daylight: 1 = noon, 0 = torch light only. The nether needs no special case here because its
  // payloads carry sky 0 everywhere it has light at all (measured, PLAN 8.2).
  skyScale: Math.min(1, Math.max(0, num('skyscale', 1))),
  // M10: faces whose air side has no light are faces no camera can see, so they are not meshed at
  // all - the BlueMap trick, and the single biggest cut available in the detail pass, because the
  // caves were paying for rock nobody looks at. ?caves=1 brings every face back (the pre-M10 look
  // and the A/B control); ?darkcut=N drops anything dimmer than N as well.
  caves: num('caves', 0) ? 1 : 0,
  darkcut: Math.min(15, Math.max(0, num('darkcut', 0))),
  // The other half of the same switch: a face in a lava-filled cavern *is* lit, by the lava, and
  // still nothing above ground will ever see it. `buried` is how many blocks of rock have to sit
  // between the face's air cell and that column's surface skin before the skylight is asked, and a
  // face in sky-dark air under that much rock is not drawn. 0 = only the dark test. URL: ?buried=
  buried: Math.min(64, Math.max(0, num('buried', 4))),
  // A face pointing at a chunk whose voxels are not held, but whose ground the heightmap skin paints,
  // is behind that skin. Drawing it is the wall of dirt a hole grows when a neighbour never arrived.
  // ?cullcovered=0 puts the walls back to compare.
  // Off by default: it culled nothing in a settled view (the payload ring leads the mesh ring) and
  // its wall-removal is one of the things that opened seams where the far layers meet. ?cullcovered=1
  // turns it back on for a comparison.
  cullCovered: params.has('nocullcovered') ? 0 : (num('cullcovered', 0) ? 1 : 0),
  // Underground, the far layers are not a far view - they are the *surface*. Their coarse plates and
  // skirt walls then hang around and above the camera as floating scraps.
  underFar: params.has('nounderfar') ? 0 : (num('underfar', 1) ? 1 : 0),
  underDepth: Math.max(0, num('underdepth', 4)),
  buriedSky: Math.max(0, Math.min(15, num('buriedsky', 2))),
  underSky: Math.max(0, Math.min(15, num('undersky', 2))),
  water: num('water', 0.72),
  // The far layer has no corners to occlude, so it borrows the close-up pass's mean AO darkening
  // instead of pretending the two are equally lit. 0.931 is measured (tools/dbg-aomean.mjs).
  aoFar: Math.min(1.5, Math.max(0.5, num('aofar', 0.949))),  // tools/dbg-aohist.mjs, sampled 48 chunks
  alphaTest: num('alphatest', 0.35),
  fog: Math.max(0, num('fog', 0)),      // 0 = no fog at all (the default); ?fog=1 brings it back
  // How the far terrain is painted: 0 flat plates of sprite mean colour, 1 choose per patch by how
  // many pixels a quad covers, 2 always draw the sprite. ?shelltex with no value keeps the old
  // meaning of "force the sprite on".
  // Flat plates by default. Real sprites past a pixel or two looked like a printed map seen from an
  // aeroplane - the world's own textures minified under a screen pixel, ringing across fields and
  // forests - which is worse than the flat paint it replaces. Auto (=1) turns a patch's cells on once
  // they are texpx across; ?shelltex with no value always textures. Neither is the default.
  shellTex: params.get('shelltex') === null ? 0
    : params.get('shelltex') === '' ? 2
    : Math.max(0, Math.min(2, +params.get('shelltex') | 0)),
  texPx: num('texpx', 1.2),           // sprite only once a quad is this many pixels across
  shellOn: !params.has('noshell'),
  ovStep: num('ovstep', 2),              // overview: height difference before a cliff wall is drawn
  overview: params.has('ov') ? (+params.get('ov') ? 1 : 0) : !params.has('nooverview'),
  // The baked coarse LOD layer: the whole world below 16 blocks per column, made on the server
  // (server/bake-lod.mjs) instead of meshed on every pan and zoom.
  lod: params.has('nolod') ? 0 : (num('lod', 1) ? 1 : 0),
  // The live shell skin stops at this cell size when tiles are drawing: past it the baked tiles already
  // paint the ground, so meshing it again is the CPU cost the bake exists to remove. 0 = never skip.
  lodCap: Math.max(0, Math.min(16, num('lodcap', 8))),
  lodSpan: Math.max(0, num('lodspan', 0)),   // 0 = the whole dimension, which is the point
  lodMax: Math.max(16, num('lodmax', 640)),        // tiles held (the overworld is 327)
  // Vertex bytes kept when a chunk leaves the detail ring, so zooming back in is an upload, not a
  // re-mesh. 256 MB is ~350 chunks. 0 turns the reuse off (every return re-meshes from voxels).
  meshCacheMb: Math.max(0, num('meshcache', 256)),
  // Baked tiles are clipped out of the square the live grid and the detail ring own (see
  // lodMatFor). ?nolodclip leaves them drawn everywhere, which is how the coarse layer
  // looked before, cliffs and all.
  lodClip: params.has('nolodclip') ? 0 : (num('lodclip', 1) ? 1 : 0),
  invert: params.has('invert'),       // orbit drag direction: mouse-look (default) vs grab-the-world
  worldSpan: 0,        // blocks across the loaded part of this dimension, filled in at boot
  maxZoom: 1200,       // wheel ceiling, recomputed from worldSpan + skinCap
};
const hud = {
  fps: $('fps'), verts: $('verts'), tris: $('tris'), chunks: $('chunks'), queue: $('queue'),
  cpu: $('cpu'),
  mesh: $('mesh'), shell: $('shell'), pos: $('campos'), dim: $('dim'), msg: $('msg'),
};

// The dimension table from /meta, kept at module scope: the panel offers every world, and switching
// one happens live. It used to be `location.search = ?dim=...`, which reloaded the page (throwing
// away every slider value) - and the dropdown that did it sat inside a pointer-events:none HUD, so
// it could not even be clicked. That is why "I can't switch dimensions" was true.
let meta = null;
let dimGen = 0;                                  // bumped on every switch; in-flight meshes carry the old one
const currentDim = () => hud.dim.value || 'minecraft:overworld';
function dimExtent(id = currentDim()) {
  const d = (meta?.dims ?? []).find((x) => x.id === id);
  return d?.chunkExtent ?? null;                 // in CHUNKS, not blocks
}
const dimSpanBlocks = (id) => {
  const e = dimExtent(id);
  return e ? Math.max(e.maxX - e.minX + 1, e.maxZ - e.minZ + 1) * CH : 0;
};

// ---- renderer / scene ------------------------------------------------------
const canvas = $('gl');
// readPixels-based verification (tools/browser-probe.mjs) needs the drawing buffer to survive
// compositing; that costs a copy per frame, so it is only on for debug runs.
const DEBUG = params.has('debug') || params.get('view') === 'flat';
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, preserveDrawingBuffer: DEBUG, powerPreference: 'high-performance',
});
// A 4K or 2x-HiDPI window is 4-8x the pixels of the 1280x800 the mesh budget was tuned against,
// and pixel count, not triangle count, is usually what caps the frame rate. Cap the ratio, then let
// a scale ride on top of it.
const DPR_CAP = Math.min(devicePixelRatio || 1, 2);
let resScale = 1, resAuto = 1, resTuneAt = 0;
const resWanted = () => DPR_CAP * S.res * (S.resAuto ? resAuto : 1);
renderer.setPixelRatio(resWanted());

const SKY = new THREE.Color(0x9cc0d8);
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY.getHex(), 90, 320);
// near/far are recomputed from the zoom every frame (see updateView): a 0.08 near against a far
// plane that has to reach the far side of the save spends the depth buffer on nothing.
const camera = new THREE.PerspectiveCamera(62, 1, 0.4, 1600);

// Unlit look: face shading, tint and (later) light all live in vertex colours. DarkRPG carries no
// lighting arrays at all (Starlight computes it client-side), so baking shade into colour is both
// cheaper and more honest than pretending to have a lightmap.
function makeMaterial(kind, map) {
  const m = new THREE.MeshBasicMaterial({ map, vertexColors: true, fog: true });
  if (kind === 1) { m.alphaTest = S.alphaTest; m.side = THREE.DoubleSide; }
  // A water_still texel averages 0.706 alpha and three multiplies that into the fragment alpha, so
  // this value is only half the story: a probe that treats it as the whole alpha misses a water pixel
  // by ~31/255, and lands within ~8 once the sprite's own alpha is applied too. What to add on top of
  // the sprite's alpha is a taste call, so it is a parameter and not a fact about the world.
  if (kind === 2) {
    m.transparent = true; m.opacity = S.water;
    m.depthWrite = false; m.side = THREE.DoubleSide;
  }
  return m;
}

// One group per pass keeps draw order obvious; renderOrder is set per mesh because three does not
// inherit it from parents.
const groups = [new THREE.Group(), new THREE.Group(), new THREE.Group()];
groups.forEach((g, i) => { g.name = `pass${i}`; scene.add(g); });
// The shell skin lives in its own node inside the opaque group, so the vert counter and the
// "far view" HUD row can see it without walking the detail meshes.
const shellGroup = new THREE.Group();
shellGroup.name = 'shell';
groups[0].add(shellGroup);

// ---- camera rig ------------------------------------------------------------
const rig = { target: new THREE.Vector3(0, 100, 0), yaw: 0.7, pitch: 0.42, dist: +(params.get('dist') ?? 40), keys: new Set() };
// ?goto=x,y,z aims the camera at a place. Boot overwrites the target with world spawn, so this has to
// be applied after that - a shared link that opens somewhere other than the place it names is a bug
// people hit immediately, and `__world.goto()` uses the same rule as the URL.
const applyGoto = () => {
  const g = (params.get('goto') ?? '').split(',').map(Number);
  if (g.length !== 3 || !g.every(Number.isFinite)) return false;
  rig.target.set(g[0], g[1], g[2]);
  return true;
};
let skinR = S.skinFloor;              // chunk radius of heightmap skin the view currently needs
let detailR = S.radius;               // chunk radius actually meshed at full resolution right now
let payloadR = S.radius;              // chunk radius whose voxels are kept (meshed or not)
let lastDetailR = -1, demoted = 0, detailVerts = 0;
let lastTierSig = '', lastTierSigAt = 0;   // what the far grid was last tiered for
// Movement basis, measured against the camera matrix (__world.axes) rather than trusted from trig:
// the eye sits at target + (-sin y, ., -cos y) * dist, so it looks along (sin y, 0, cos y), and its
// screen-right is (-cos y, 0, sin y). fwdOf used to be the negation of the first of those, which made
// W back away and S push forward; rightOf was the other way round, which made A slide right.
const fwdOf = () => new THREE.Vector3(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
const rightOf = () => new THREE.Vector3(-Math.cos(rig.yaw), 0, Math.sin(rig.yaw));

function updateCamera() {
  const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
  const dir = new THREE.Vector3(-Math.sin(rig.yaw) * cp, sp, -Math.cos(rig.yaw) * cp);
  camera.position.copy(rig.target).addScaledVector(dir, rig.dist);
  camera.lookAt(rig.target);
}

// What the view is allowed to reach, recomputed every frame because the answer depends on the zoom.
//
// Three limits used to be independent constants and the smallest one won: the wheel stopped at 900,
// the far plane was nailed to 1600, and the heightmap skin stopped at 40 chunks. Zooming out to 900
// therefore showed terrain floating in sky 640 blocks out, then clipped mid-air. Now the frustum and
// the fog both follow the skin, and the wheel ceiling is the distance at which the screen is exactly
// filled by the widest skin the user allows. shared/view.mjs holds the arithmetic, and its tests.
function updateView() {
  if (rig.dist > S.maxZoom) rig.dist = S.maxZoom;   // the ceiling applies to go()/orbit() too
  // The skin only has to be as wide as the frame can actually see: at least the half-width of the
  // frame at the orbit target, and out to whichever of "where the ground runs out" and "how far the
  // fog lets you see" is nearer. Looking at the horizon makes the ground run out infinitely, so the
  // fog decides; looking down at a map makes the ground decide and saves a lot of requests.
  // Size the skin for the frame's corners, not its middle column: a 16:9 window reaches much
  // farther sideways, and the corners are where a too-narrow skin shows its edge.
  const frameWant = rig.dist * cornerTan(camera.fov, camera.aspect);
  const groundWant = groundReach(rig.pitch, rig.dist, camera.fov);
  // Fog used to be the thing that bounded the skin, and with fog off by default multiplying by it
  // made the wanted radius zero: the skin collapsed to its floor and the 64 block world-layer cells
  // took over a few hundred blocks in front of the camera, which is where their flat plates and
  // straight cliff walls are impossible to miss. No fog means "you may see to the horizon".
  const fogWant = S.fog > 0 ? Math.max(320, rig.dist * 1.35) * S.fog : Infinity;
  const want = Math.max(frameWant, Math.min(groundWant, fogWant));
  const r = skinRadius(rig.dist, want, { min: S.skinFloor, cap: S.skinCap });
  // Grow straight away - a missing ring is a hole in the view. Shrink only once it is clearly
  // wider than needed, so nudging the pitch does not thrash the request ring and re-mesh patches.
  skinR = r >= skinR ? r : (r <= skinR - 8 ? r : skinR);
  updateLodClip();            // the baked tiles stop being drawn where the finer layers own the ground
  // ---- the full-resolution ring, same pixel budget, opposite question -------------------------
  // A detail mesh is built once and then kept, whatever the zoom does afterwards. Measured: 289
  // full-res chunks and 9 443 760 verts, identical at an eye distance of 60 blocks and of 26 km -
  // 79% of the triangles on screen drawing a target that covered a few pixels. The far grid already
  // asks "how coarse may a cell get"; the detail layer has to ask the mirror question, "is a
  // one-block column still worth a triangle at all". Past `detailRadius` the answer is no, so the
  // ring collapses and the heightmap skin (which is already held, and is at cell 1 nearby anyway)
  // paints it. With the skin switched off there is nothing to fall back to, so the user's radius
  // stays literal.
  // ... unless the user switched the whole idea off (`?nodetaillod`), which is also the A/B switch.
  const wantD = (S.shellOn && S.detailLod)
    ? detailRadius(rig.dist, pxPerRad(), S.detailPx, S.radius) : S.radius;
  // Grow at once - detail that arrives late is a visible hole. Shrink only once it is clearly more
  // than needed, so a wheel drag does not thrash 300 chunks between mesh and demote every frame.
  detailR = wantD >= detailR ? wantD : (wantD <= detailR - 2 ? wantD : detailR);
  if (detailR !== lastDetailR) { lastDetailR = detailR; applyDetailBudget(); }
  // The far plane has to contain everything that is drawn, not just the per-chunk skin. The
  // whole-dimension layer reaches to the edge of the save, and a far plane sized for the skin alone
  // cut it off mid-distance: tilting toward the horizon showed a hard line where the world stopped,
  // moving with the pitch. With the overview underneath there is no skin edge left to hide, so the
  // frustum simply spans the dimension.
  const span = Math.max(skinR * CH, (S.overview || lodActive()) ? S.worldSpan : 0);
  const f = frustumFor(rig.dist, span);
  if (f.near !== camera.near || f.far !== camera.far) {
    camera.near = f.near; camera.far = f.far;
    camera.updateProjectionMatrix();
  }
  // The far grid's tier depends on the zoom (how close the eye can get) and on the skin radius
  // (which sets the cost floor), so a wheel gesture has to re-tier. It used to be that only a change
  // of *centre* re-tiered: zoom in and the detail chunks loaded while the coarse skin stayed put on
  // top of them, which is exactly "the big ones still render even if more detailed are also loaded"
  // and, zooming the other way, the reverse. Quantised so a smooth zoom does not re-tier every
  // frame; retierPatches only dirties the patches whose tier really moved.
  const sig = `${Math.round(rig.dist / 8)}|${skinR}|${detailR}|${S.cellPx}|${S.cellBudget}|${S.cellMax}|${S.forceCell}`;
  if (sig !== lastTierSig && performance.now() - lastTierSigAt > 250) {
    lastTierSig = sig; lastTierSigAt = performance.now();
    retierPatches();
  }
  // Fog is off by default now. It used to be the thing that hid the edge of the far view; with the
  // whole-extent overview underneath, an edge is no longer there to hide, and people found the haze
  // annoying. `?fog=1` still puts it back, and the advanced group still has the slider.
  if (S.fog > 0) {
    const fg = fogFor(rig.dist, skinR, { scale: S.fog });
    if (!scene.fog) scene.fog = new THREE.Fog(SKY.getHex(), fg.near, fg.far);
    else { scene.fog.near = fg.near; scene.fog.far = fg.far; }
  } else if (scene.fog) scene.fog = null;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, orbit: e.button === 0 }; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.orbit) {
    // Mouse-look: dragging right turns the view right, dragging down looks down - the direction this
    // rig has always had, and the one to leave alone. The other reading (grab the world and spin it,
    // which is what right-drag pan does) is the `invert` checkbox, because people genuinely want both.
    const k = S.invert ? -1 : 1;
    rig.yaw -= dx * 0.006 * k;
    rig.pitch = Math.max(-1.52, Math.min(1.52, rig.pitch + dy * 0.006 * k));
  } else {
    const s = rig.dist * 0.0018;
    // grab-the-world: dragging down slides the eye forward, dragging right slides it screen-left
    rig.target.addScaledVector(fwdOf(), dy * s).addScaledVector(rightOf(), -dx * s);
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // The ceiling is what the skin can actually paint, so scrolling past it stops the view getting
  // bigger instead of showing the edge of the loaded world.
  rig.dist = Math.max(2, Math.min(S.maxZoom, rig.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

let SPAWN = [0, 110, 0];
let panel = null;
addEventListener('keydown', (e) => {
  // The panel holds inputs; WASD belongs to the camera only while nothing is being typed into.
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  rig.keys.add(e.code);
  if (e.code === 'KeyR') { rig.target.set(SPAWN[0], SPAWN[1], SPAWN[2]); rig.dist = 40; }
  if (e.code === 'KeyP' && panel) panel.toggle();
  if (e.code === 'KeyF') fitWorld();
  if (e.code === 'KeyX') groups.forEach((g) => g.traverse((o) => { if (o.material) o.material.wireframe = !o.material.wireframe; }));
  if (e.code === 'KeyH') document.body.classList.toggle('hidehud');
  if (e.code === 'BracketLeft') rig.target.y -= 4;
  if (e.code === 'BracketRight') rig.target.y += 4;
});
addEventListener('keyup', (e) => rig.keys.delete(e.code));

function stepKeys(dt) {
  const speed = (rig.keys.has('ShiftLeft') ? 120 : 30) * dt;
  if (rig.keys.has('KeyW') || rig.keys.has('ArrowUp')) rig.target.addScaledVector(fwdOf(), speed);
  if (rig.keys.has('KeyS') || rig.keys.has('ArrowDown')) rig.target.addScaledVector(fwdOf(), -speed);
  if (rig.keys.has('KeyA') || rig.keys.has('ArrowLeft')) rig.target.addScaledVector(rightOf(), -speed);
  if (rig.keys.has('KeyD') || rig.keys.has('ArrowRight')) rig.target.addScaledVector(rightOf(), speed);
  if (rig.keys.has('KeyE')) rig.target.y += speed;
  if (rig.keys.has('KeyQ')) rig.target.y -= speed;
}

// ---- data ------------------------------------------------------------------
let assets = null, atlasTex = null, atlasPixels = null, materials = null, shellMat = null,
  shellTexMat = null,
  store = null, shellStore = null, mipCap = null;
const meshes = new Map();   // "cx,cz" -> [{ pass, mesh }]
const stateOf = (id) => (id === 0 || id > assets.states.length ? -1 : id - 1);
let assetSource = null;     // {json, geo} as fetched, for handing to the mesh workers

async function loadAssets() {
  const [json, geo, blob] = await Promise.all([
    fetch('/assets/atlas.json').then((r) => r.json()),
    fetch('/assets/geometry.bin').then((r) => r.arrayBuffer()),
    fetch('/assets/atlas.png').then((r) => r.blob()),
  ]);
  assets = new Assets(json, geo);
  // The mesh workers get the same two blobs, so keep the raw copies around for them.
  assetSource = { json, geo };
  const bmp = await createImageBitmap(blob, { flipY: false });
  // Keep a CPU copy of the atlas. The numeric texture probe compares what landed in the
  // framebuffer against a direct sample of the atlas image; that is the only way to catch a
  // flipped-V upload or an off-by-one cell without squinting at screenshots.
  const octx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
  octx.drawImage(bmp, 0, 0);
  atlasPixels = octx.getImageData(0, 0, bmp.width, bmp.height).data;
  atlasTex = new THREE.Texture(bmp);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  // The atlas is addressed top-down: atlas.json cells store u0,v0 as pixel offsets from the top
  // left, and the mesher maps sprite uv into that space. three's default flipY would upload the
  // image bottom-up (and Chrome additionally ignores UNPACK_FLIP_Y for ImageBitmap sources), so
  // pin both sides of that contract to "no flip" and keep the convention browser-independent.
  atlasTex.flipY = false;
  // Magnify nearest (crisp pixels up close) but minify with a mip chain: a 16px sprite drawn
  // 4px wide aliases into TV static without one. The 1px clamped gutters keep levels 1..3 clean;
  // deeper levels smear neighbouring cells, which is what the shell/LOD pass will replace.
  // ?nomip restores the old nearest-everywhere path so the two can be A/B'd on the framebuffer.
  if (params.has('nomip')) {
    atlasTex.minFilter = THREE.NearestFilter;
    atlasTex.generateMipmaps = false;
  } else {
    atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
    atlasTex.generateMipmaps = true;
    atlasTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  atlasTex.magFilter = THREE.NearestFilter;
  atlasTex.needsUpdate = true;
  materials = [0, 1, 2].map((k) => makeMaterial(k, atlasTex));
  // Two paints for the far layer: a flat plate of the sprite's mean colour, and the atlas itself.
  // Which one a patch uses depends on how many pixels its quads cover (see patchTexMode), so both are
  // always built. FrontSide is safe because the shell reuses the detail mesher's face rings, and at
  // 40 chunks of radius back faces would be pure overdraw.
  makeShellMats();
  mipCap = capAtlasMipLevel(atlasTex, S.mipmax);
}

// The far skin is untextured on purpose: a shell column is a couple of pixels wide, so the mip chain
// turns sprite detail into flickering noise, while the mesher's per-face mean sprite colour (see
// shell-mesh.js faceColors) gives a stable, readable relief. `?shelltex=1` puts the atlas back for
// side-by-side comparison and the panel can flip it live, which is why this is a function rather
// than a line in loadAssets. FrontSide is safe because the shell reuses the detail mesher's face
// rings, and at this radius back faces would be pure overdraw.
function makeShellMats() {
  const flat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, side: THREE.FrontSide });
  const tex = atlasTex && Object.assign(makeMaterial(1, atlasTex), { side: THREE.FrontSide });
  for (const m of [shellMat, shellTexMat]) if (m && m.dispose) m.dispose();
  shellMat = flat; shellTexMat = tex;
}

// Sprite or flat plate. A quad under a pixel wide samples one texel of a sprite and reads as noise, so
// it gets the mean colour the mesher already computed; a quad over a pixel wide reads as ground and
// gets the sprite, which is the same pixels the detail pass draws. Measured across the lake at 300 m:
// a flat plate sampled 98,110,124 where the detail pass drew 57,68,76, and the textured far quad came
// out at 49,56,65 - the sprite is the one that matches, so the seam at the edge of the detail ring
// goes away. Cells coarsen with distance anyway, so the far horizon still lands in flat mode.
function patchTexMode(px, pz, tier) {
  if (!shellTexMat || S.shellTex === 0) return 0;
  if (S.shellTex === 2) return 1;
  const cell = cellOfTier(tier);
  const cx = (px * S.patch + S.patch / 2) * CH, cz = (pz * S.patch + S.patch / 2) * CH;
  const eye = camera.position;
  const d = Math.max(8, Math.hypot(cx - eye.x, cz - eye.z, rig.target.y - eye.y));
  return cell * (pxPerRad() / d) >= S.texPx ? 1 : 0;
}

// Stop the mip chain where a sprite cell is still bigger than one texel. Deeper levels average a
// cell with its neighbours, and with 1834 cells packed together that reads as grey mush over
// distant terrain. three's Texture has no maxLevel, so take the GL handle from the upload that
// initTexture performs and set WebGL2's TEXTURE_MAX_LEVEL on it directly.
function capAtlasMipLevel(tex, maxLevel) {
  const gl = renderer.getContext();
  if (gl.TEXTURE_MAX_LEVEL === undefined || maxLevel < 0) return null;
  const target = gl.TEXTURE_2D;
  const orig = gl.bindTexture.bind(gl);
  const seen = new Set();
  tex.needsUpdate = true;
  gl.bindTexture = (t, h) => { if (t === target && h) seen.add(h); return orig(t, h); };
  try { renderer.initTexture(tex); } finally { gl.bindTexture = orig; }
  if (seen.size !== 1) return null;      // more than one texture touched: refuse to guess
  const [handle] = seen;
  orig(target, handle);
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, maxLevel);
  orig(target, null);
  return maxLevel;
}

// Rebuilt per job rather than captured once: the sliders have to reach the workers too, and the
// options are plain data so they structured-clone cleanly.
// ?noao drops the depth cue entirely, ?ao=0.65 lifts its darkest corner: both exist so the
// shading can be argued about with framebuffer numbers instead of taste.
// `lightOn` travels as a flag, not a function: the accessor has to be attached where the store is
// (main thread) or where the neighbour map is (worker), and a function would not clone anyway.
const meshOpts = () => ({
  ao: S.ao, aoMin: S.aoMin,
  lightOn: S.light ? 1 : 0, darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale,
  // -1 rather than absent: the mesher's "mesh everything" setting, so the caves toggle cannot be
  // misread as a threshold of 0 by a worker that spread the object.
  darkcut: S.caves ? -1 : S.darkcut,
  buried: S.caves ? 0 : S.buried,
  buriedSky: S.buriedSky,
});

/**
 * Neighbour chunks that the far layers paint but whose voxel payload is not held. A detail face
 * toward one of them is behind the heightmap skin, so it is not drawn; a face toward a neighbour that
 * is simply *unknown* (nothing loaded, nothing painted) still is, because a chunk that arrives later
 * has to find its faces there. The worker gets this list because it cannot see the shell store.
 */
function coveredNeighbours(cx, cz) {
  if (!(S.shellOn && S.cullCovered && shellStore)) return null;
  let out = null;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const nx = cx + dx, nz = cz + dz;
    if (!store.has(nx, nz) && shellStore.has(nx, nz)) (out ??= []).push([nx, nz]);
  }
  return out;
}

function buildChunkGeometries(chunk) {
  const at = (cx, cz, lx, ly, lz) => {
    const v = store.stateIndexAt(cx, cz, lx, ly, lz, stateOf);
    if (v === -1 && S.shellOn && S.cullCovered && shellStore) {
      const nx = cx + (lx >> 4), nz = cz + (lz >> 4);
      if ((nx !== cx || nz !== cz) && !store.has(nx, nz) && shellStore.has(nx, nz)) return NEIGH_COVERED;
    }
    return v;
  };
  const o = meshOpts();
  if (o.lightOn) {
    o.light = (cx, cz, lx, ly, lz) => store.lightLevelAt(cx, cz, lx, ly, lz, S.skyScale);
    o.sky = (cx, cz, lx, ly, lz) => store.skyLevelAt(cx, cz, lx, ly, lz);
  }
  const { streams, stats } = meshChunk(assets, chunk, at, o);
  const geos = [];
  for (let pass = 0; pass < 3; pass++) {
    const s = streams[pass];
    if (!s.count) continue;
    const g = new THREE.BufferGeometry();
    // One buffer set per chunk mesh: three can own it outright, no copy, and dispose() frees it.
    g.setAttribute('position', new THREE.BufferAttribute(s.position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(s.uv, 2));
    g.setAttribute('color', new THREE.Uint8BufferAttribute(s.color, 4, true));
    g.computeBoundingSphere();
    geos.push({ pass, geometry: g });
  }
  return { geos, stats };
}

/**
 * Demotion keeps the triangles, not just the voxels.
 *
 * Pulling back disposes a chunk's BufferGeometry, and zooming back in used to re-run the mesher over
 * every chunk in the ring: 51.7 ms each, ~289 chunks at `dist=400`, which is the hitch the user
 * described as "the detailed chunks are deleted and regenerated tanking my performance". The payload
 * ring (`payloadLead`) already stopped the *refetch*; this stops the re-mesh. On demote the vertex
 * arrays - the very buffers three was drawing - are parked here, and bringing a chunk back is a
 * BufferGeometry rebuild plus a GPU upload: a fraction of a millisecond instead of tens.
 *
 * The entries are keyed by everything that changes a detail mesh, because the triangles *are* the
 * light and occlusion at the moment they were made: change AO, the light curve, the caves toggle or
 * the dimension, and every parked mesh is stale, so it is dropped rather than drawn.
 */
const meshBytes = new Map();          // "cx,cz" -> { passes, stats, bytes, sig }, oldest first
let meshBytesTotal = 0, cachedInstalls = 0, meshBytesDropped = 0, lastBytesSweep = 0;

const detailSig = () => `A${S.ao ? 1 : 0}/${S.aoMin}L${S.light ? 1 : 0}/${S.darkFloor}/${S.darkGamma}` +
  `/${S.skyScale}D${S.caves ? -1 : S.darkcut}B${S.caves ? 0 : S.buried}S${S.buriedSky}C${S.shellOn && S.cullCovered ? 1 : 0}` +
  `G${dimGen}`;

function dropBytes(key) {
  const e = meshBytes.get(key);
  if (!e) return;
  meshBytes.delete(key);
  meshBytesTotal -= e.bytes;
}

function clearMeshBytes() { meshBytes.clear(); meshBytesTotal = 0; }

/**
 * Over budget: drop the parked chunks *farthest from where the camera is looking*.
 *
 * Oldest-first eviction looked reasonable (the ring walks outward, so the earliest parks are the
 * least likely to return) and measured badly: at a 64 MB cap the demote pass parks chunks in map
 * order, the nearest ones went first, and a return to the close view spent its first 1.8 seconds
 * re-meshing the middle of the screen while 172 usable chunks sat parked at the edge of the view.
 * The ring always comes back from the middle out, so the middle is what must survive.
 */
function trimMeshBytes() {
  const cap = S.meshCacheMb * 1048576;
  const drop = pickEvictions(
    [...meshBytes].map(([k, e]) => [k, e.bytes, ...k.split(',').map(Number)]), cap, centerChunk());
  for (const k of drop) { meshBytesDropped++; dropBytes(k); }
}

function stashMeshBytes(key, entry) {
  if (S.meshCacheMb <= 0) return;
  const passes = [];
  let bytes = 0;
  for (const { pass, mesh } of entry.list) {
    const a = mesh.geometry.attributes;
    if (!a.position || !a.position.count) continue;
    // slice(): the mesher's streams are power-of-two grown, so holding a view would keep an
    // allocation up to twice the size of the chunk alive for a chunk nobody is looking at.
    passes.push({
      pass,
      position: a.position.array.slice(), uv: a.uv.array.slice(), color: a.color.array.slice(),
    });
    bytes += a.position.array.byteLength + a.uv.array.byteLength + a.color.array.byteLength;
  }
  if (!passes.length) return;
  dropBytes(key);
  meshBytes.set(key, { passes, stats: entry.stats, bytes, sig: detailSig() });
  meshBytesTotal += bytes;
  trimMeshBytes();
}

/** Parked bytes for a chunk the store itself dropped can never be installed again: they are RAM
 * for a voxel payload that no longer exists. The byte cap alone would keep them until something
 * else pushed them out, which is how a long session slowly accumulates a second, unreachable copy
 * of every chunk it ever visited. */
function sweepMeshBytes() {
  if (!store) return;
  for (const k of [...meshBytes.keys()]) {
    if (store.has(...k.split(',').map(Number))) continue;
    meshBytesDropped++;
    dropBytes(k);
  }
  trimMeshBytes();
}

/** Rebuild a chunk from parked bytes. False means nothing usable was parked: mesh it normally. */
function installCached(cx, cz) {
  const key = `${cx},${cz}`, e = meshBytes.get(key);
  if (!e) return false;
  if (e.sig !== detailSig()) { dropBytes(key); return false; }
  dropBytes(key);
  const wasCovered = dropChunkMesh(cx, cz);
  const geos = e.passes.map(({ pass, position, uv, color }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Uint8BufferAttribute(color, 4, true));
    g.computeBoundingSphere();
    return { pass, geometry: g };
  });
  attachChunkMesh(cx, cz, geos, e.stats, wasCovered);
  cachedInstalls++;
  return true;
}

/** Dispose one chunk and report whether it was there. `stash` parks the bytes for cheap re-entry. */
function dropChunkMesh(cx, cz, stash = false) {
  const key = `${cx},${cz}`;
  const old = meshes.get(key);
  if (!old) return false;
  meshes.delete(key);
  if (stash) stashMeshBytes(key, old);
  for (const { pass, mesh } of old.list) { groups[pass].remove(mesh); mesh.geometry.dispose(); }
  return true;
}

// The skin has to stop drawing under anything the detail pass picks up, otherwise two surfaces sit
// at the same height and z-fight. `wasCovered` is the state before this mesh landed.
function attachChunkMesh(cx, cz, geos, stats, wasCovered) {
  if (!geos.length) return;
  // A worker can finish a chunk after the ring has already moved past it. Installing that result would
  // put full-res geometry back exactly where the far grid is supposed to paint it (the demote pass had
  // already run), so the work is thrown away rather than drawn.
  if (S.shellOn && S.detailLod && !inDetailRing(cx, cz, 1)) {
    for (const { geometry } of geos) geometry.dispose();
    return;
  }
  if (!wasCovered) markPatch(cx, cz, 'cover');
  const list = geos.map(({ pass, geometry }) => {
    const mesh = new THREE.Mesh(geometry, materials[pass]);
    mesh.name = `detail${pass}`;
    mesh.renderOrder = pass;
    mesh.frustumCulled = true;
    groups[pass].add(mesh);
    return { pass, mesh };
  });
  meshes.set(`${cx},${cz}`, { list, stats });
}

function rebuild(cx, cz) {
  const wasCovered = dropChunkMesh(cx, cz);
  const chunk = store.get(cx, cz);
  if (!chunk) return;
  const t0 = performance.now();
  const { geos, stats } = buildChunkGeometries(chunk);
  meshStat(performance.now() - t0);
  attachChunkMesh(cx, cz, geos, stats, wasCovered);
}

// ---- mesh workers ------------------------------------------------------------
// Meshing costs tens of milliseconds per chunk, which is a visible hitch inside a 16 ms frame. The
// workers run web/js/mesher.js itself, so the only thing that changes is which thread pays. A chunk
// needs its eight loaded neighbours for face culling and AO, so the job carries the 3x3 of plain
// payload data; the copy is a memcpy, the meshing is not.
const pool = [];
let workerReady = 0, meshSeq = 0, meshWait = 0, workerSeq = 0, workerReadyMsgs = 0, workerError = null, lastWorkerTry = 0;
const jobs = new Map();          // seq -> {cx, cz, key, wasCovered, t0, gen}
// The idle refill walks every coordinate in the chunk ring AND the shell skin - at skin 96 that is
// 37 000 keys and a sort - so running it 60 times a second costs more than the meshing it enables.
let lastRefill = 0, refillCx = 1e9, refillCz = 1e9;
const jobForKey = new Map();     // "cx,cz" -> seq, so a chunk is never meshed twice at once
// Meshing is the one job that is CPU-bound, purely functional and per-chunk, so take every core the
// browser will give us. Four workers filled a 121 chunk view in ~4 s; the floor of one keeps a
// machine with two cores responsive rather than thrashing, and `?workers=0` still forces the
// in-thread path for A/B probes.
const workerCount = () => Math.max(0, Math.min(8, S.workers >= 0
  ? S.workers
  : Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) - 2))));

function plainChunk(c) {
  return {
    cx: c.cx, cz: c.cz, yMin: c.yMin, yCount: c.yCount, palette: c.palette,
    // The surface skin travels too: the buried-face test asks "is that air cell under the ground of
    // this chunk's own column", and the answer is one subtract off this array.
    height: c.height,
    // Light codes ride along with the voxels: two bytes per section, plus the nibble array for the
    // sections where light genuinely varies. That is a quarter of the voxel arrays already copied.
    sections: c.sections.map((s) => ({
      y: s.y, single: s.single, vox: s.vox,
      sky: s.sky, blk: s.blk, skyArr: s.skyArr, blkArr: s.blkArr,
    })),
  };
}

function startWorkers() {
  const n = workerCount();
  if (!n || !assetSource) return;
  for (let i = 0; i < n; i++) {
    // type: 'module' because the worker imports the same ESM modules the page and the tests use.
    const w = new Worker('/js/mesh-worker.js', { type: 'module' });
    w.busy = false;
    w.seq = ++workerSeq;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) { workerReadyMsgs++; if (w.seq === workerSeq) workerReady++; return; }
      w.busy = false;
      const job = jobs.get(m.seq);
      jobs.delete(m.seq);
      jobForKey.delete(m.key);
      // The chunk may have been evicted, replaced, or switched dimension while its mesh was being
      // built; a stale skin over new voxels is worse than one more frame of shell.
      if (!job || job.gen !== dimGen || !store.get(m.cx, m.cz)) return;
      const geos = m.passes.map(({ pass, position, uv, color }) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(position, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setAttribute('color', new THREE.Uint8BufferAttribute(color, 4, true));
        g.computeBoundingSphere();
        return { pass, geometry: g };
      });
      meshStat(m.ms ?? 0);
      meshWait = Math.max(meshWait, performance.now() - job.t0);
      attachChunkMesh(m.cx, m.cz, geos, m.stats, job.wasCovered);
    };
    // A worker that dies takes a chunk of the meshing capacity with it, and "0 workers" in the HUD
    // with everything meshing on the render thread is otherwise invisible: the world just loads slowly
    // and the cause is nowhere. Say what broke, and only count the death if this worker is still the
    // current one (retire/reset paths kill workers on purpose).
    w.onerror = (e) => {
      if (w.seq !== workerSeq) return;
      workerError = `${e.message || 'worker error'} @ ${e.filename || '/js/mesh-worker.js'}:${e.lineno || 0}`;
      console.error('mesh worker died', e);
    };
    // Each worker needs its own copy of the geometry blob: transferring the ArrayBuffer would take
    // it away from the main thread's Assets, which still answers probes.
    w.postMessage({ init: true, atlas: assetSource.json, geo: assetSource.geo.slice(0) });
    pool.push(w);
  }
}

const workersUsable = () => pool.length > 0 && workerReady === pool.length;

// Retiring the pool is the only honest way to make the worker slider mean something: the count is a
// per-page cost (each worker re-parses the atlas), not a per-frame one. Anything in flight goes back
// to the dirty set rather than being silently dropped.
function resetWorkers() {
  workerSeq++;                                // retire every worker message from before this reset
  for (const w of pool) { w.onmessage = null; w.onerror = null; w.terminate(); }
  pool.length = 0; workerReady = 0;
  for (const [seq, job] of [...jobs]) {
    jobs.delete(seq); jobForKey.delete(job.key);
    if (store) store.dirty.add(job.key);
  }
  startWorkers();
}

function meshAsync(cx, cz) {
  const key = `${cx},${cz}`;
  if (jobForKey.has(key)) return true;
  const w = pool.find((x) => !x.busy);
  const chunk = store.get(cx, cz);
  if (!w || !chunk) return false;
  const wasCovered = dropChunkMesh(cx, cz);
  const chunks = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = store.get(cx + dx, cz + dz);
      if (c) chunks.push(plainChunk(c));
    }
  }
  const seq = ++meshSeq;
  jobs.set(seq, { cx, cz, key, wasCovered, t0: performance.now(), gen: dimGen });
  jobForKey.set(key, seq);
  w.busy = true;
  w.postMessage({ key, cx, cz, seq, chunks, opts: meshOpts(), covered: coveredNeighbours(cx, cz) });
  return true;
}

// Drain the dirty set: hand work to free workers when they are up, otherwise pay for it here so the
// page still renders on browsers or probes that forced ?workers=0.
function drainMeshes(now) {
  if (!workersUsable()) {
    for (;;) {
      const keys = store.takeDirty(1);
      if (!keys.length) break;
      const [cx, cz] = keys[0].split(',').map(Number);
      if (!store.has(cx, cz)) continue;        // a neighbour of a chunk that has left the store
      if (!inDetailRing(cx, cz, 1)) continue;  // demoted: markDetailRing re-dirties it on the way back
      // Parked triangles cost a buffer upload; the mesher costs ~51 ms. Ask the cache first.
      if (!installCached(cx, cz)) rebuild(cx, cz);
      if (performance.now() > now + S.budget) break;
    }
    return;
  }
  for (;;) {
    const keys = store.takeDirty(1);
    if (!keys.length) break;
    const [cx, cz] = keys[0].split(',').map(Number);
    // A dirty key whose chunk is gone must be dropped, not put back. It used to go back, and since
    // the loop stops on the first refusal, one stale key throttled the whole mesh queue: 35 of them
    // sat in the set and every frame burned its one allowed take on a chunk that no longer existed.
    if (!store.has(cx, cz)) continue;
    if (!inDetailRing(cx, cz, 1)) continue;    // outside the live ring: nothing to mesh here
    // Same rule with workers: reuse parked bytes instead of queueing a 51 ms job behind everyone else.
    if (installCached(cx, cz)) continue;
    if (meshAsync(cx, cz)) continue;
    store.dirty.add(keys[0]);          // no free worker: the chunk stays queued for the next frame
    break;
  }
}

const centerChunk = () => [Math.floor(rig.target.x / 16), Math.floor(rig.target.z / 16)];

// The heightmap skin has to be centred on the *eye*, not on the orbit target. At a 1.2 km pull-back
// the target is 1.2 km from the camera, and a square of half-width 1.5 km around the target leaves
// the near side of the frame outside it: that showed up as the world being cut off along a straight
// line on one side of the view. Measured from the eye, "wide enough to cover the frame" is the same
// question in every direction, and the edge lands behind the fog in all of them.
const eyeChunk = () => [Math.floor(camera.position.x / CH), Math.floor(camera.position.z / CH)];

// Mesh cost is timed either way: in a worker, or here when ?workers=0. A chunk's cost varies
// several-fold - a village or a cave surface versus an air column - which is why the drain above
// works through the dirty set on a time budget instead of a fixed count per frame.
let meshAvg = 0, meshMax = 0, meshN = 0;
function meshStat(ms) {
  meshN++;
  meshAvg += (ms - meshAvg) / meshN;
  if (ms > meshMax) meshMax = ms;
}
const meshLists = () => Array.from(meshes.values(), (e) => e.list);
let aggTotal = { cubes: 0, quads: 0, faces: 0, culled: 0, air: 0, unknown: 0, skipped: 0, placeholder: 0, darkCulled: 0, buried: 0, covered: 0 };
function recomputeAgg() {
  const t = { cubes: 0, quads: 0, faces: 0, culled: 0, air: 0, unknown: 0, skipped: 0, placeholder: 0, darkCulled: 0, buried: 0, covered: 0 };
  for (const { stats } of meshes.values()) for (const k in t) t[k] += stats[k] ?? 0;
  aggTotal = t;
}
function requestAround() {
  const [cx, cz] = centerChunk();
  if (shellStore && S.shellOn) {
    // Patches the detail ring covers are only re-meshed when the ring itself moves, which keeps the
    // handover from churned remeshing every frame; chunk eviction is picked up here too.
    // Re-tier on pan AND on zoom. Zooming moves every patch's distance without moving the centre
    // chunk, so a pan-only rule left the whole far grid at the tier chosen for the old distance: after
    // a pull-back to 200 m the skin stayed at cell 16 while the detail ring grew underneath it, which
    // is the giant flat plates the camera then had to be panned to notice. Log buckets so one wheel
    // gesture costs a few dozen passes, and the patch signature below keeps the re-cuts rare.
    const db = Math.round(Math.log(Math.max(1, rig.dist)) * 6);
    if (cx !== lastCx || cz !== lastCz || db !== lastDb) {
      lastCx = cx; lastCz = cz; lastDb = db;
      retirePatchesOutside(cx, cz, skinR);
      for (let x = cx - detailR - 1; x <= cx + detailR + 1; x += S.patch) {
        for (let z = cz - detailR - 1; z <= cz + detailR + 1; z += S.patch) dirtyAdd(patchKey(x, z), 'cammove');
      }
      retierPatches();
    }
    // Shells before voxels: a shell is 1 KB and covers the whole view, a chunk payload is ~100 KB and
    // covers 16 blocks. Sharing the browser's handful of connections, the cheap layer should win.
    //
    // Anchored on the orbit target, not the eye. An orbit swings the eye on a circle of radius
    // `dist`, and a skin that follows the eye re-requests, re-tiers and re-meshes a ring of patches
    // on every drag - the far LODs visibly flashed while the mouse was moving. The target does not
    // move during an orbit, so neither does the skin, its tiers, or the overview square that has to
    // agree with it. Coverage still reaches the eye: skinRadius already floors the radius at
    // dist * 1.15 / 16, so the eye always sits inside the square it is looking out of.
    shellStore.request(cx, cz, skinR, 0);
    requestLod();
  }
  // Voxels are requested out to payloadR, wider than the mesh ring on purpose: a chunk demoted
  // because the eye pulled back still has its payload, so zooming in again re-meshes instead of
  // re-fetching 100 KB per chunk.
  store.request(cx, cz, payloadR);
}

// ---- heightmap shell (M5) --------------------------------------------------
// One patch is S.patch x S.patch chunks and becomes a single BufferGeometry, so a 96-chunk-radius
// view costs a few hundred draw calls instead of a few thousand. Dirty work starts at the shell store
// (a new shell also changes the walls of its four neighbours) and is coarsened to patch keys.
const patchKey = (cx, cz) => `${Math.floor(cx / S.patch)},${Math.floor(cz / S.patch)}`;
const dirtyPatches = new Set();
// Counting why patches get marked, because 250 permanently dirty patches cost 25 ms of every
// frame and the reason was not guessable from the code.
const markWhy = {};
const dirtyAdd = (pk, why) => { markWhy[why] = (markWhy[why] || 0) + 1; dirtyPatches.add(pk); };
const markPatch = (cx, cz, why = 'mark') => dirtyAdd(patchKey(cx, cz), why);
// A patch's signature counts the shell chunks it holds, so every arriving chunk dirties its patch and
// one re-cut is 10-20 ms. While the store fills that is a rebuild per arrival - 24 ms a frame,
// measured, forever. So a patch waits until it has stopped changing before it is re-cut; a patch with
// no mesh yet never waits, and one that has waited too long is rebuilt regardless.
const dirtySince = new Map();
const PATCH_WAIT_MAX = 2000;
const shellMeshes = new Map();                 // "px,pz" -> { mesh, verts }
let shellVerts = 0, shellMs = 0, shellMsMax = 0, shellN = 0, lastCx = null, lastCz = null, lastDb = -1;
const shellAt = (cx, cz) => (shellStore ? shellStore.get(cx, cz) ?? null : null);
const detailHere = (cx, cz) => meshes.has(`${cx},${cz}`);

// ---- who gets a voxel mesh, who gets the cheap grid (PLAN 7.2) --------------------------------
// Three separate radii used to be one number, which is why far-away places kept their full-res
// meshes forever: `S.radius` decided what was fetched, what was meshed, and what was kept. Now:
//   detailR   what is meshed block-by-block (pixel budget, collapses when the eye is far)
//   payloadR  what voxels stay in memory (detailR + lead, so coming back costs a re-mesh not a
//             re-fetch), and the radius eviction actually uses
//   S.radius  the user's ceiling on both
const inDetailRing = (cx, cz, pad = 0) => {
  const [tcx, tcz] = centerChunk();
  return Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz)) <= detailR + pad;
};

// Store capacities follow the live radii, not the setting. maxChunks is what the store may hold at
// all, evictLimit is the radius it drops beyond - deliberately wider than the mesh ring.
function applyDetailBudget() {
  // Demote is not delete. Even with no mesh ring at all, a core of voxel payloads stays held around
  // what the camera looks at: at a 26 km pull-back that is 169 chunks (~17 MB) parked under a target
  // a few pixels wide, and it is what turns zooming back in into a re-mesh instead of another
  // 289-chunk download. The ring is what shrinks to nothing; the payload only ever trails it.
  payloadR = Math.min(S.radius, detailR + S.payloadLead);
  if (!store) return;
  const cap = +(params.get('maxchunks') ?? 0) || Math.max(64, (2 * payloadR + 5) ** 2);
  store.maxChunks = cap;
  store.evictLimit = payloadR + 2;
  markDetailRing();
  sweepMeshBytes();               // the ring just changed what the store is allowed to hold
}

// Anything held, inside the ring and without a mesh, needs meshing: a promoted chunk (the ring grew,
// or the camera panned back over payloads that were kept warm) is otherwise silently skipped, since
// the store only marks chunks dirty when they *arrive*.
function markDetailRing() {
  if (!store) return;
  for (const c of store.chunks.values()) {
    if (inDetailRing(c.cx, c.cz, 1) && !meshes.has(`${c.cx},${c.cz}`)) store.dirty.add(`${c.cx},${c.cz}`);
  }
}

// Demote: dispose the geometry (that is the VRAM and the draw cost), keep the payload. The patches
// the skin skipped because detail owned them have to be re-meshed, or dropping detail punches a hole
// - the same failure class as an overview cell that nothing paints.
function demoteOutsideRing(budget = 64) {
  let n = 0;
  for (const k of [...meshes.keys()]) {
    if (n >= budget) return n;
    const [cx, cz] = k.split(',').map(Number);
    if (inDetailRing(cx, cz, 1)) continue;
    if (dropChunkMesh(cx, cz, true)) { markPatch(cx, cz, 'demote'); demoted++; n++; }
  }
  return n;
}

// LOD for the skin: a shell column is one block close to the eye and up to 16 blocks far away.
// `?cell=N` forces one size everywhere; otherwise the pixel budget decides: a cell is only allowed
// to be as coarse as it can be while still covering less than `cellPx` pixels on screen.
const CELLS16 = [1, 2, 4, 8, 16];
const tiers = () => (S.forceCell ? [S.forceCell] : CELLS16.filter((c) => c <= S.cellMax));
const tierLabel = () => `${tiers().join('/')} blk @${(S.cellPx * costScale).toFixed(2)}px` +

  `, ${(S.vertBudget / 1e6).toFixed(1)} M vert${costScale > 1.05 || floorBoost > 1 ? ' (over budget)' : ''}`;
const patchTier = new Map();                    // "px,pz" -> tier index used by the live mesh
const cellOfTier = (t) => { const T = tiers(); return T[Math.max(0, Math.min(T.length - 1, t))]; };
// Closed-loop cost control. `cellBudget` is a real memory limit, but `budgetCell` can only reason
// about one chunk's distance, not about how much area the skin covers at that distance: measured, a
// 1.5 km pull-back asked for one-block columns in a full ring around the eye's ground track and came
// out at 31 M shell verts - three times the full-res detail it had just replaced. So the pixel rule
// is multiplied by this and the product is walked until the whole grid fits the budget. It is a
// multiplier on the *pixel* target, so it coarsens with distance and leaves the ground under the
// camera nearly alone: at 1.5 km it settles around 3-5, which is cell 2 in the foreground instead of
// cell 1. Start it back at 1 whenever the user changes the budget or the sharpness.
let costScale = 1, floorBoost = 1;

// Device pixels per radian: a thing `b` blocks wide at `d` blocks covers b * pxPerRad / d pixels.
const pxPerRad = () => renderer.domElement.height / (camera.fov * Math.PI / 180);

function tierAt(cx, cz, prev = 0) {
  const T = tiers();
  // Distance is measured from the orbit target, then converted to the closest the eye can get to
  // that chunk while orbiting: `closestApproach`. That is the distance which decides the biggest
  // pixel a cell can cover in this view, and it only depends on the target and the zoom, so it is
  // stable while you drag.
  const [tcx, tcz] = centerChunk();
  const dTarget = Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz));
  const nearBlocks = closestApproach(dTarget, rig.dist / CH) * CH;
  // Two independent limits. Pixels say how coarse the grid may get before a cell stops being worth
  // its texel; the column budget says how fine it can afford to be. Without the second one a 300
  // block pull-back asks for one-block columns across the whole held skin, which is 19 M vertices
  // the eye cannot tell apart from a quarter of that.
  // A column's top face covers `pxPerRad * cell / d * cos(incidence)` pixels, and the distance-only
  // rule ignores that last term. At a 1.5 km pull-back that was the whole cost of the skin: the ring
  // of ground under and around the eye is seen edge-on, yet the rule asked for one-block columns and
  // the annulus alone came to 34 M verts. Allow the cell to grow as the surface turns away.
  // Everything here is orbit-invariant (target distance, zoom, pitch) so it cannot retier on a drag.
  const face = faceFactor(rig.dist, rig.pitch, dTarget * CH);   // 1 = looking down, ~0 = edge-on
  const pxCell = cellForPixels(nearBlocks, pxPerRad(), (S.cellPx * costScale) / face, S.cellMax);
  const floorCell = budgetCell(nearBlocks, skinR * CH, S.cellBudget, 1, S.cellMax) * floorBoost;
  let floorIdx = 0;
  while (floorIdx < T.length - 1 && T[floorIdx] < floorCell) floorIdx++;
  let pxIdx = 0;
  while (pxIdx < T.length - 1 && T[pxIdx] < pxCell) pxIdx++;
  if (pxIdx <= prev) return Math.max(floorIdx, pxIdx);   // finer: take it now, detail is free to ask
  // Coarser: keep the detail unless the pixels are comfortably past the next step. The cost floor
  // is not subject to that slack - it is a memory limit, not a quality preference.
  let t = Math.max(prev, floorIdx);
  while (t < T.length - 1 && T[t + 1] * 1.7 <= pxCell) t++;
  return t;
}
const patchTierFor = (pk, prev = 0) => {
  const [px, pz] = pk.split(',').map(Number);
  const h = S.patch >> 1;
  return tierAt(px * S.patch + h, pz * S.patch + h, prev);
};
// The mesher has to know the *neighbour* chunk's cell to stop a wall at the right height, and after
// LOD that neighbour may belong to a patch meshed at a different tier.
const cellForChunk = (cx, cz) => cellOfTier(patchTier.has(patchKey(cx, cz))
  ? patchTier.get(patchKey(cx, cz)) : tierAt(cx, cz, 0));

// After the camera moves, every held patch re-checks its tier; a change also dirties the surrounding
// patches, because the wall along a shared border depends on both sides' cell size.
// Patches are only ever disposed when something marks them dirty and they get re-cut. A patch that
// has fallen outside the skin square is not dirty, its shell bytes may still be held, and nothing else
// looks at it - so panning left a carpet of the OLD view's coarse terrain standing there at the old
// tier until the store happened to evict its chunks. That is the "LODs don't disappear when I pan"
// report, and at close zoom it is a few million verts of scenery nobody is looking at.
//
// Retire on the spot: dispose the geometry, forget the tier, and drop the patch key. The shell frames
// themselves stay cached (2.4 KB each), so coming back is a re-cut, not a re-fetch.
let retireN = 0, retireCx = 1e9, retireCz = 1e9, retireSkin = -1;
function retirePatchesOutside(cx, cz, r) {
  if (cx === retireCx && cz === retireCz && r === retireSkin) return 0;
  retireCx = cx; retireCz = cz; retireSkin = r;
  const side = Math.max(1, S.patch);
  let n = 0;
  for (const [pk, e] of shellMeshes) {
    const c = pk.split(',');
    const mcx = (+c[0]) * side + (side >> 1), mcz = (+c[1]) * side + (side >> 1);
    if (Math.abs(mcx - cx) <= r + side && Math.abs(mcz - cz) <= r + side) continue;
    for (const m of [e.mesh, e.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
    shellMeshes.delete(pk);
    patchTier.delete(pk);
    dirtyPatches.delete(pk);
    n++;
  }
  retireN += n;
  return n;
}

function retierPatches() {
  for (const [pk, e] of shellMeshes) {
    const t = patchTierFor(pk, e.tier);
    if (t === e.tier) continue;
    e.tier = t;                                  // record it, or the next call finds the same "change"
    const [px, pz] = pk.split(',').map(Number);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) dirtyAdd(`${px + dx},${pz + dz}`, 'retier');
    }
  }
  fitGridBudget();
}

// How many heightmap columns the grid over the whole skin would hold at the current settings. This
// walks the patch square the skin *will* cover, not the patches that happen to be meshed yet: an
// estimate that lags behind the load lets the grid start too fine and only corrects after the fact.
function gridColumns() {
  const side = Math.max(1, Math.ceil((2 * skinR + 1) / S.patch));
  const [tcx, tcz] = centerChunk();
  const px0 = Math.floor((tcx - skinR) / S.patch), pz0 = Math.floor((tcz - skinR) / S.patch);
  let est = 0;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      est += (CH * S.patch / cellOfTier(patchTierFor(`${px0 + i},${pz0 + j}`, 0))) ** 2;
    }
  }
  return est;
}

// Start from "pixels decide" and coarsen until the grid fits the vertex budget. It is re-solved from
// scratch on every retier rather than remembered: a controller that only nudges its multiplier kept
// the world coarse for a dozen camera moves after a pull-back (measured costScale 13.6 at a 26 km
// zoom, where the answer is 1), and a laggy answer is a blurry world.
//
// Cells are the first lever because they are the cheapest thing to give up. Once the grid is already
// at the user's coarsest cell the walk cannot go further - and a cliff wall at cell 16 is still 16
// blocks wide - so the second lever is the *floor* under the near field (`floorBoost`), because the
// ring of ground round the eye is the part that costs: at a 1.5 km pull-back it was 34 M verts of
// one-block columns, and a two-block column there is still two pixels.
function vertsPerColumn() {
  let cols = 0, verts = 0;
  for (const e of shellMeshes.values()) {
    cols += (CH * S.patch / cellOfTier(e.tier)) ** 2;
    verts += e.verts || 0;
  }
  return cols > 0 ? Math.max(4, verts / cols) : 12;
}

// How far the walk is allowed to push. Not "as far as possible": measured at a 300 m pull-back,
// coarsening the far grid to the user's cell ceiling made the vertex count *worse* (8.6 M shell verts
// versus 6.2 M with pixels in charge) because every step down a cliff between a fine patch and a
// coarse one is drawn as walls, and the finer the ratio between neighbours the more of those walls
// there are. Cells are therefore only nudged two steps; below that the walk raises the near-field
// floor, and then admits it cannot fit.
const COST_MAX = 4;

function fitGridBudget() {
  const prevCost = costScale, prevBoost = floorBoost;
  costScale = 1; floorBoost = 1;
  for (let pass = 0; pass < 10; pass++) {
    const est = gridColumns() * vertsPerColumn();
    if (est <= S.vertBudget) break;
    if (costScale < COST_MAX) costScale = Math.min(COST_MAX, costScale * 1.5);
    else if (floorBoost < 8) floorBoost *= 2;    // the near field is the expensive part: coarsen it
    else break;                                  // at the ceiling: say so, don't thrash
  }
  // Re-meshing the whole skin is seconds of work, so a walk that lands one notch from where it was
  // is not worth running: keep the previous answer unless the budget wants two notches more (or
  // less). Measured, without this a zoom drag re-meshed ~500 patches on almost every wheel notch.
  const ratio = costScale / prevCost;
  if (ratio < 1.6 && ratio > 1 / 1.6 && floorBoost === prevBoost) {
    costScale = prevCost; floorBoost = prevBoost;
    return;
  }
  if (costScale > 1 || floorBoost > 1) retierPatches_tiers();   // the walk changed the answer
}

// Apply the coarser tiers the budget walk settled on, dirtying borders as a tier change always does.
function retierPatches_tiers() {
  for (const [pk, e] of shellMeshes) {
    const t = patchTierFor(pk, e.tier);
    if (t === e.tier) continue;
    e.tier = t;                                  // the walk's answer, so the next pass sees it
    const [px, pz] = pk.split(',').map(Number);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) dirtyAdd(`${px + dx},${pz + dz}`, 'budget');
    }
  }
}

function rebuildPatch(pk) {
  const old = shellMeshes.get(pk);
  if (old) {
    for (const m of [old.mesh, old.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
    shellMeshes.delete(pk);
  }
  const [px, pz] = pk.split(',').map(Number);
  const x0 = px * S.patch, z0 = pz * S.patch;
  let held = 0;
  for (let dz = 0; dz < S.patch; dz++) for (let dx = 0; dx < S.patch; dx++) if (shellAt(x0 + dx, z0 + dz)) held++;
  if (!held) { patchTier.delete(pk); return; }
  // A patch takes its ground away from the baked tiles only when it is whole: frames are still
  // arriving mid-load and the save really does have holes, and half a live patch over a discarded
  // tile is a hole in the view - which is what "the far LODs never load" looked like. With no baked
  // layer standing behind it there is nothing to hand the ground back to, so cut it anyway.
  if (held < S.patch * S.patch && lodPainting()) {
    if (old) {
      for (const m of [old.mesh, old.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
      shellMeshes.delete(pk); recountShellVerts();
    }
    patchTier.delete(pk);
    return;
  }
  const tier = patchTierFor(pk, patchTier.get(pk) ?? 0);
  // The baked tiles already paint this patch. The live skin stops where the tile grid takes over, so
  // the coarse ring is not meshed anywhere - that is the frame cost the bake was for.
  if (lodActive() && S.lodCap > 0 && cellOfTier(tier) > S.lodCap) {
    const old = shellMeshes.get(pk);
    if (old) {
      for (const m of [old.mesh, old.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
      shellMeshes.delete(pk);
      recountShellVerts();
    }
    patchTier.delete(pk);
    return;
  }
  patchTier.set(pk, tier);
  const mode = patchTexMode(px, pz, tier);
  const t0 = performance.now();
  const { stream, stats } = meshShellPatch(assets, shellAt, x0, z0, S.patch, S.patch, {
    cell: cellOfTier(tier), cellFor: cellForChunk, maxSkirt: S.skirt, skip: detailHere,
    blend: S.blend, trackStates: true, groundFar: S.groundFar, waterOpacity: S.water,
    aoFar: S.aoFar, tex: mode === 1, ...farLightOpts(),
  });
  const ms = performance.now() - t0;
  shellN++;
  shellMs += (ms - shellMs) / shellN;
  if (ms > shellMsMax) shellMsMax = ms;
  if (!stream.count) { patchTier.delete(pk); return; }
  // Two paints, two materials: a far cell is either a sprite quad or a plate of its sprite's mean
  // colour, and the sprite material has no partial alpha, so a lake stays a plate either way.
  const build = (s, mat) => {
    if (!s.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(s.position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(s.uv, 2));
    g.setAttribute('color', new THREE.Uint8BufferAttribute(s.color, 4, true));
    // one state id per quad, so a ray hit can be traced back to the block that painted it
    if (s.stateIds) g.userData.shellState = s.stateIds;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = 'shpatch';
    m.renderOrder = 0;
    shellGroup.add(m);
    return m;
  };
  shellMeshes.set(pk, {
    mesh: build(stream, mode === 1 ? shellTexMat : shellMat),
    verts: stream.count,
    tier, mode, sig: patchSig(pk),
  });
  recountShellVerts();
}

// Counted from the live meshes rather than the mesher stats: a patch that was skipped (detail owns
// it) contributes nothing, and stats would double-count after a rebuild.
function recountShellVerts() {
  shellVerts = 0;
  for (const { verts } of shellMeshes.values()) shellVerts += verts;
}

let shellCutAvg = 0, shellCuts = 0, PATCH_CUT_MAX = 64;
// Signature tests per frame: enough to settle a page of patches in a few frames, few enough that
// the tests themselves cannot become the frame.
const SETTLE_TESTS = 24;

function drainShellPatches(now) {
  let n = 0, tested = 0;
  for (const pk of [...dirtyPatches]) {
    const live = shellMeshes.get(pk);
    if (!dirtySince.has(pk)) dirtySince.set(pk, now);
    const waited = now - dirtySince.get(pk);
    if (live && waited < S.shellQuiesce && waited < PATCH_WAIT_MAX) continue;
    // A patch is marked dirty by its neighbours too (a shared border wall depends on both sides), so
    // most of these marks want nothing: rebuilding the same tier for the same shells throws away a
    // mesh and redraws it, which is exactly the flicker a drag used to produce. The signature is only
    // computed for a patch we might really cut - it walks 64 chunk keys to build it.
    //
    // It used to also demand that every chunk of the patch be held before a mesh counted as settled.
    // Outside the generated area, and wherever a chunk is a confirmed 404, that never happens, so those
    // patches were re-cut forever: 258 half-empty patches at r96 cost 25 ms of every frame, meshing the
    // same unchanged geometry four times a frame until the tab was closed. The signature already counts
    // held and missing chunks, which is the thing that arriving data actually changes.
    // A signature walks the patch's own tier, its eight neighbours' tiers and 64 chunk keys, and it
    // is only ever computed to *skip* work. On a skin square that is 193 chunks wide, 324 patch keys
    // sit dirty while 141 patches exist, and testing every one of them every frame measured 20 ms of
    // a 10 ms budget - the signature tests, not the meshing. So they are budgeted too: answer as many
    // as the frame can afford and leave the rest marked for the next one.
    if (live && tested++ < SETTLE_TESTS && live.sig === patchSig(pk)) {
      dirtyPatches.delete(pk); dirtySince.delete(pk);
      continue;
    }
    dirtyPatches.delete(pk); dirtySince.delete(pk);
    // Pay for the patch, then decide with the cost of *that* patch in hand. A 16x16 patch is 65 536
    // heightmap columns, and its cut measured 5.5 ms; a flat count of four per frame therefore cost
    // 22 ms of a 10 ms budget and put the whole page at 23 fps while the far grid stood up. Patches
    // vary several-fold, so the last cut is the only honest estimate of the next one.
    const t0 = performance.now();
    rebuildPatch(pk);
    const cut = performance.now() - t0;
    shellCutAvg += (cut - shellCutAvg) / ++shellCuts;
    if (++n >= PATCH_CUT_MAX || performance.now() + shellCutAvg > now + S.shellBudget) return;
  }
}

/**
 * Everything a patch mesh depends on except the shells themselves: its own LOD tier, the tiers of
 * the eight patches around it (the wall along a shared border is drawn to the lower of the two), and
 * how much of it the voxel detail already owns. Two patches with the same signature and the same
 * shells would come out byte-identical, so the second build is wasted work - and rebuilding a mesh
 * that is already on screen is what made the far terrain flicker while dragging.
 */
// The far layer shades itself with the save's light now, using the same curve and the same panel
// controls as the detail pass, so a cliff in a ravine does not go bright just because it is far.
const farLightOpts = () => ({
  lightOn: S.light, darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale,
});
const lightSigBit = () => `L${S.light ? 1 : 0}/${S.darkFloor}/${S.darkGamma}/${S.skyScale}`;

function patchSig(pk) {
  const [px, pz] = pk.split(',').map(Number);
  let s = String(patchTier.get(pk) ?? patchTierFor(pk, 0));
  // Meshing policy belongs in the signature too: a patch marked dirty because the user moved a far
  // grid or water slider must not be skipped as "already matches".
  s += `|g${S.groundFar}w${S.water.toFixed(2)}t${patchTexMode(px, pz, patchTier.get(pk) ?? patchTierFor(pk, 0))}a${S.aoFar}${lightSigBit()}`;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nk = `${px + dx},${pz + dz}`;
      s += shellMeshes.has(nk) ? String(shellMeshes.get(nk).tier) : String(patchTierFor(nk, 0));
    }
  }
  const x0 = px * S.patch, z0 = pz * S.patch;
  let owned = 0;
  for (let dz = 0; dz < S.patch; dz++) for (let dx = 0; dx < S.patch; dx++) if (detailHere(x0 + dx, z0 + dz)) owned++;
  // Held and confirmed-missing shell chunks, as two counts. A shell evicted from the store is a hole
  // in the mesh, and without this the patch on screen still "matches", is never re-cut, and a chunk
  // that arrives later paints nothing. Counts rather than a bitmap: 64 chunks of bitmap per patch per
  // frame is bookkeeping nobody can afford, and a hole changes the count anyway.
  let held = 0, gone = 0;
  if (shellStore) {
    for (let dz = 0; dz < S.patch; dz++) for (let dx = 0; dx < S.patch; dx++) {
      const k = `${x0 + dx},${z0 + dz}`;
      if (shellStore.shells.has(k)) held++; else if (shellStore.missing.has(k)) gone++;
    }
  }
  return `${s}|${owned}|h${held}m${gone}`;
}

// (There used to be a patchComplete() here asking whether every chunk of a patch was held. It gated
// the settle test, and patches over ungenerated land - where that is never true - were therefore
// re-cut on every frame forever. The signature's held/missing counts say the same thing in O(64).)

// ---- whole-dimension overview ----------------------------------------------
// The chunk skin is 1 KB per chunk, so covering a 1088x1632 chunk save costs 37 MB of fetches and a
// minute of streaming - that is what made zooming out feel broken. The overview is the same heightmap
// at 4 chunks per column, one file for the whole dimension: ~450 KB, one request, and it answers the
// only question a 20 km view can ask. It is baked by server/bake-shells.mjs and served by /overview;
// when it is not baked the far view falls back to the chunk skin alone, i.e. the old behaviour.
const ovGroup = new THREE.Group();
ovGroup.name = 'overview';
groups[0].add(ovGroup);
let overview = null;                     // parsed /overview frame, or null (not baked / ?nooverview)
const ovBands = new Map();               // band index -> { mesh, verts, cells, sig }
let ovMs = 0, ovVerts = 0, ovCells = 0, ovSkipped = 0;

// The grid is meshed in horizontal bands: a 100 000 cell dimension is a second of meshing, and one
// frame must not pay it. ~24 bands is fine enough that a band fits a frame budget and coarse enough
// that the bookkeeping stays a rounding error.
const ovBandRows = () => Math.max(4, Math.min(64, Math.round((overview ? overview.h : 0) / 24)));
const ovBandTotal = () => (overview ? Math.ceil(overview.h / ovBandRows()) : 0);

/**
 * The live world layer and the baked coarse tiles are the *same* layer made two ways: the tiles are
 * pre-cut at 16 blocks per column for the whole dimension, the live layer is cut in the browser from
 * a one-chunk grid. Drawing both stacks a second set of flat plates and cliff walls on top of the
 * tiles (which is what looked like "1x1 chunk LODs sitting on the detailed chunks"), and the live one
 * costs a 16 MB frame plus band meshing to do the coarser layer's job worse. So the tiles win where
 * they exist, and the live layer stands down - visible again the moment the tiles are switched off,
 * refused for disagreeing about terrain, or unavailable for that dimension.
 */
/* The tiles only take the far view once they are actually on screen. lodActive() alone would
 * leave a hole for the second between load (or a dimension switch) and the first tile landing,
 * and for a dimension that has no baked tiles at all. */
const lodPainting = () => lodActive() && lodAvail && lodMeshes.size > 0;
const ovActive = () => !!overview && !!S.shellOn && !!S.overview && !lodPainting();

function ovCount() {
  ovVerts = 0; ovCells = 0; ovSkipped = 0;
  // A standing-down layer contributes nothing to the frame's vertex count, or the HUD would bill
  // geometry that is not on screen.
  if (ovActive()) for (const b of ovBands.values()) { ovVerts += b.verts; ovCells += b.cells; ovSkipped += b.skipped; }
}

function dropBand(i) {
  const b = ovBands.get(i);
  if (!b) return;
  ovGroup.remove(b.mesh);
  b.mesh.geometry.dispose();
  ovBands.delete(i);
}

function clearOverview() {
  for (const i of [...ovBands.keys()]) dropBand(i);
  ovMs = 0; ovCursor = 0;
  ovCount();
}

async function loadOverview(dim) {
  const gen = dimGen;
  clearOverview();
  overview = null;
  if (!S.overview) return;
  try {
    const r = await fetch(`/overview?dim=${encodeURIComponent(dim)}`);
    if (!r.ok) return;                    // not baked yet: the chunk skin carries the far view
    const ab = await r.arrayBuffer();
    if (gen !== dimGen) return;           // dimension changed while this was in flight
    overview = openOverview(ab);
    // The honest zoom ceiling: with the overview in hand the view can pull back to fit the extent.
    S.worldSpan = dimSpanBlocks(dim);
    recomputeZoom();
  } catch { overview = null; }
}

/**
 * The square of overview cells the chunk skin is requested over, in grid coordinates. Diagnostics
 * only now: `ovCovered` below asks the stores directly which cells are painted, which cannot disagree
 * with them the way a hand-derived square did.
 */
function ovSkip() {
  const cell = overview.cell;
  const r = Math.ceil(skinR / cell) + 1;
  // Grid coordinates, not world cell numbers: a cell index in the mesher is `(cx - overview.x0)/cell`,
  // and the overworld grid starts at chunk -352. Mixing the two put this square 88 cells west of the
  // camera, which skipped ground nothing was drawing and left real terrain covered by a 64 block slab.
  const ax = Math.floor((rig.target.x / CH - overview.x0) / cell);
  const az = Math.floor((rig.target.z / CH - overview.z0) / cell);
  return { i0: ax - r, i1: ax + r, j0: az - r, j1: az + r };
}

/** True when every chunk under one overview cell is held, so something finer already draws it. */
function ovCovered(cx, cz, cell) {
  // Inside the square the heightmap skin is supposed to cover, the skin is authoritative. Requiring
  // every chunk under a 64 block cell to be held sounds stricter but is the weaker rule: one evicted
  // or confirmed-missing chunk un-skips the cell, and a coarse world-layer plate - dead flat, one
  // colour, straight cliff walls - lands on top of fine terrain a few dozen blocks from the camera.
  // Inside that square the coarse cell is skipped unless the cell is a real hole in the data.
  const [tcx, tcz] = centerChunk();
  if (Math.abs(cx - tcx) <= skinR && Math.abs(cz - tcz) <= skinR
      && Math.abs(cx + cell - 1 - tcx) <= skinR && Math.abs(cz + cell - 1 - tcz) <= skinR) {
    let holes = 0;
    for (let dz = 0; dz < cell; dz++) {
      for (let dx = 0; dx < cell; dx++) {
        if (shellStore && shellStore.missing.has(`${cx + dx},${cz + dz}`)) holes++;
      }
    }
    if (holes * 2 < cell * cell) return true;
  }
  // Outside it, fall back to what is actually held, so the coarse layer keeps its holes at bay.
  for (let dz = 0; dz < cell; dz++) {
    for (let dx = 0; dx < cell; dx++) {
      if (!detailHere(cx + dx, cz + dz) && !shellAt(cx + dx, cz + dz)) return false;
    }
  }
  return true;
}

// Which bands need re-cutting because the fine layers grew into them. Rate limited, because a band
// costs milliseconds and the whole grid costs hundreds: recomputing per cell would be 200 000 map
// lookups a frame, and rebuilding on every single arrival would starve the detail pass during a load.
//
// Quantising the counts was the bug. The skip decision is per cell - all sixteen chunks of a 4x4 cell
// held - so a coarse bucket could sit unchanged while the cell under the camera filled in, and the
// band kept drawing a cliff wall into the middle of the fine terrain. So: bump on any change, throttled
// in time, and always run one final pass once the stores go quiet, which is what makes the settled view
// correct whatever happened while it was loading.
let ovCov = '', ovCovStamp = 0, ovCovAt = 0, ovQuietDone = false;
function ovCoverage(now, quiet) {
  // What the skip decision depends on: how much is held, and which square the skin is authoritative
  // over. Leaving the square out means panning changes the answer without changing the signature, so
  // the coarse layer keeps a stale skip list behind it - the same class of bug as a signature that
  // quantises the quantity it is supposed to guard.
  const [tcx, tcz] = centerChunk();
  const q = `${meshes.size},${shellStore ? shellStore.loaded : 0},${skinR},${detailR},` +
    `${Math.floor(tcx / 8)},${Math.floor(tcz / 8)}`;
  if ((q !== ovCov && now - ovCovAt > 900) || (quiet && !ovQuietDone)) {
    ovCov = q; ovCovStamp++; ovCovAt = now; ovQuietDone = quiet;
  }
  if (!quiet) ovQuietDone = false;
  return ovCovStamp;
}

// A band's content depends on the meshing parameters and on how much of the ground is already owned
// by the finer layers - nothing else. Deliberately not the skip square's coordinates: those move
// during a pan, and re-cutting every band they touch is what made the far layer flash.
function ovSig(cov) {
  // Meshing policy belongs here as well: moving the far terrain shape or the water clarity slider has
  // to re-cut the bands, not just a coverage change.
  return `c${cov}|${S.ovStep}|${overview.cell}|g${S.groundFar}w${S.water.toFixed(2)}a${S.aoFar}${lightSigBit()}`;
}

// A coverage change makes every band stale, and a band costs enough that a frame only finishes one or
// two of them. Starting each pass at band 0 meant that while the world was still loading - coverage
// changing every second - the pass never got past the first third of the grid, so the far bands kept
// a stale skip list and drew a 64 block slab over terrain that had long had column detail. Round robin
// from a cursor instead: every band gets its turn however often the stamp moves.
let ovCursor = 0;

/**
 * Mesh the next slice of the overview grid, within a frame budget: the world appears coarse-to-fine
 * instead of the first frame stalling. A band is replaced by building the new one first and only then
 * retiring the old, so a re-cut never leaves a row of the world missing for a frame.
 */
function drainOverview(now) {
  if (!ovActive()) return;
  const rows = ovBandRows(), total = ovBandTotal(), cell = overview.cell;
  const quiet = shellStore && shellStore.inflight === 0 && shellStore.queue.length === 0
    && store.inflight === 0 && store.queue.length === 0 && store.dirty.size === 0;
  const cov = ovCoverage(now, quiet);
  // Band rows depend on settings, so a shrink leaves band indices nobody visits again: their meshes
  // would sit in the scene uncounted. Drop them here rather than rely on the sweep below.
  for (const k of [...ovBands.keys()]) if (k >= total) dropBand(k);
  for (let n = 0; n < total; n++) {
    const i = (ovCursor + n) % total;
    const row0 = i * rows, count = Math.min(rows, overview.h - row0);
    const sig = ovSig(cov);
    const live = ovBands.get(i);
    if (live && live.sig === sig) continue;
    const t0 = performance.now();
    const { stream, stats } = meshOverview(assets, overview, {
      row0, rows: count, minStep: S.ovStep, trackStates: true, groundFar: S.groundFar,
      waterOpacity: S.water, aoFar: S.aoFar, ...farLightOpts(),
      skip: (cx, cz) => ovCovered(cx, cz, cell),
    });
    ovMs += performance.now() - t0;
    // Retire the previous generation of this band BEFORE installing the new one. Without this the
    // old band mesh stays in the scene forever: every coverage re-cut (and there are dozens per
    // session) adds another whole-dimension layer, and coarse cells that the skip rule says are now
    // covered by chunk-resolved terrain keep painting over it. The counters read only ovBands, so
    // the ghosts were invisible to every probe: ovGroup.children grew while ovBands looked clean.
    dropBand(i);
    if (stream.count) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(stream.position, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(stream.uv, 2));
      g.setAttribute('color', new THREE.Uint8BufferAttribute(stream.color, 4, true));
      if (stream.stateIds) g.userData.shellState = stream.stateIds;
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, shellMat);
      mesh.name = 'overview';
      mesh.renderOrder = -1;               // draw the coarse layer before the skin covering the same ground
      ovGroup.add(mesh);
      ovBands.set(i, { mesh, verts: stream.count, cells: stats.columns, skipped: stats.skipped ?? 0, sig });
      if (ovGroup.children.length !== ovBands.size) {
        for (const m of [...ovGroup.children]) { ovGroup.remove(m); m.geometry.dispose(); }
      }
    } else {
      ovBands.delete(i);                   // nothing to draw here (all skipped, or nothing baked)
    }
    ovCount();
    if (performance.now() > now + S.shellBudget) { ovCursor = (i + 1) % total; return; }
  }
}


// ---- baked coarse LOD tiles ------------------------------------------------

// Everything coarser than 16 blocks per column used to be meshed in the browser on every pan and

// zoom: the whole-dimension overview plus the far ring of the shell skin, measured at 5-14 ms of

// every frame while the camera moved, and seconds before a new part of the world settled.

// server/bake-lod.mjs makes those vertices once per region and worldd serves them, so the far layer

// is a file read and a GPU upload at any distance, forever. 2.5 M verts covers the overworld's whole

// 512 km2 of saved ground - less geometry than one radius-8 ring of voxel detail.

//

// Tiles are drawn *under* the live layers, biased down 0.4 blocks. That is what lets one tile cover

// its whole region without z-fighting against the finer skin or the voxel detail sitting on the same

// heightmap surface: 0.4 blocks is far under a pixel at any distance where a tile is the visible

// thing, and up close it is simply hidden under geometry that really is finer.

const LOD_Y_BIAS = -0.4;

const lodGroup = new THREE.Group();

lodGroup.name = 'lod';

groups[0].add(lodGroup);

let lodStore = null, lodVerts = 0, lodTiles = 0, lodError = '', lodAvail = false;
// The index of which regions have tiles lands a few ms after the store exists. Asking for the whole
// bounding box in that window costs ~1 400 empty requests per view, so the first request waits.
let lodIndexPending = false, lodIndexError = '';
// The tiles on disk were baked with one far paint. If the viewer moves away from that paint, every
// tile is refused - and then nothing but the live grid draws the distance, which is exactly what
// this layer exists to avoid. So say so, and put the live grid back to its full range.
let lodPolicyBad = false;

let lodMat = null;

/**
 * Baked tiles, clipped to the region they are needed for.
 *
 * A tile is one mesh over a 512x512 block region, so it cannot be "unloaded near the camera": the
 * region under the camera is the same mesh as the region on the horizon. What has to go is the
 * *geometry inside the square the finer layers already own* - otherwise a coarse 16 block column,
 * whose height is the tallest thing in that chunk, stands 30 blocks above the fine terrain next to
 * it and wins the depth test in the sky pixels above it. That is the flat grey slab with a straight
 * cliff wall.
 *
 * So the material discards its own fragments inside that square. Tile-local coordinates are world
 * coordinates, so a varying and four floats do it; three.js frustum culling still decides which
 * tiles get drawn at all, and this decides which parts of them may show.
 *
 * It is only armed while the live far grid actually covers that square (`S.shellOn`): with the far
 * grid off, the baked tiles are the only thing painting the ground under the camera and clipping
 * them would open a hole. "Off" is an empty rectangle, not a branch, so the shader never varies.
 */
/* One texel per live far-grid patch: a baked tile fragment is discarded exactly where a live patch
 * paints, and nowhere else. A clip *rectangle* looked equivalent and is not - it came from the skin
 * radius, but patches are refused where their live cell would be too coarse, where shell frames have
 * not arrived, or where the save has a hole, and each of those left a square of nothing because the
 * tile that would have painted it was discarded anyway. Measured at zoom 4734 with all 327 tiles
 * drawn and 0 gaps: 34 of 84 screen samples hit no geometry at all. */
const COV_N = 128;                                // the patch grid wraps at 128 (the world is ~64)
// RGBA, not RedFormat: a 1-channel DataTexture sampled in the patched shader came back 0 for every
// fragment on this driver (proven by forcing the whole map covered, which changed 0.5% of pixels
// while an unconditional discard changed 30%), so the discard silently did nothing.
const covData = new Uint8Array(COV_N * COV_N * 4);
const covTex = new THREE.DataTexture(covData, COV_N, COV_N, THREE.RGBAFormat, THREE.UnsignedByte);
covTex.colorSpace = THREE.NoColorSpace;
covTex.magFilter = covTex.minFilter = THREE.NearestFilter;
covTex.generateMipmaps = false;
covTex.needsUpdate = true;
const uLodCov = { value: covTex };
const uCovAt = { value: new THREE.Vector2(0, 0) };   // patch coordinate sitting at the origin
const uCovBlk = { value: 256 };                      // blocks per far-grid patch (S.patch * CH)
const uKill = { value: 0 };                          // debug: unconditional discard for the baked tiles
let lodClipOn = 0, lodClipRect = [1e9, 1e9, -1e9, -1e9], lodCovPatches = 0;
let covForce = 0;                                // debug: 1 = everything covered, -1 = nothing, 0 = normal
let lodKill = 0;                                 // debug: unconditional discard, to prove the patch is live

/**
 * Is the eye inside the rock? The test is skylight, not depth: a ravine floor 40 blocks under the rim
 * is open to the sky and must keep the walls painted around it, a lava cavern is not. Measured in the
 * cavern at (40, 20, 8): the far layers there are 1.66 M shell verts plus 0.92 M baked-tile verts of
 * geometry nobody can use, and 16 fps against 30 with them off.
 */
let underFar = false;
function updateUnderground() {
  if (!S.underFar) { underFar = false; return; }
  const p = camera.position;
  const [ecx, ecz] = eyeChunk();
  const lx = Math.floor(p.x) & 15, lz = Math.floor(p.z) & 15, wy = Math.floor(p.y);
  let top = null, sky = -1;
  const c = store ? store.get(ecx, ecz) : null;
  if (c) {
    top = c.surfaceAt(Math.floor(p.x), Math.floor(p.z));
    sky = store.skyLevelAt(ecx, ecz, lx, wy, lz);
  }
  if (top === null) {
    const sh = shellAt(ecx, ecz);
    if (sh) top = sh.height[(lz << 4) | lx] - HEIGHT_BIAS;
  }
  if (top === null) return;                     // nothing to judge by yet: keep the last answer
  underFar = p.y < top - S.underDepth && (sky < 0 ? true : sky <= S.underSky);
}

function updateLodClip() {
  const on = lodActive() && S.shellOn && S.lodClip !== 0;
  const PB = uCovBlk.value = S.patch * CH;
  covData.fill(0);
  lodCovPatches = 0;
  if (covForce) {                                 // debug path: is the discard reaching the GPU at all?
    covData.fill(covForce > 0 ? 255 : 0);
    lodCovPatches = covForce > 0 ? 1 : 0;
  } else if (on) {
    const [tcx, tcz] = centerChunk();
    const acx = Math.floor(tcx / S.patch), acz = Math.floor(tcz / S.patch);
    uCovAt.value.set(acx, acz);
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const pk of shellMeshes.keys()) {
      const c = pk.indexOf(',');
      const px = +pk.slice(0, c), pz = +pk.slice(c + 1);
      const tx = ((px - acx) % COV_N + COV_N) % COV_N, tz = ((pz - acz) % COV_N + COV_N) % COV_N;
      const ci = (tz * COV_N + tx) << 2;
      if (covData[ci]) continue;
      covData[ci] = 255;
      lodCovPatches++;
      if (px < x0) x0 = px;
      if (pz < z0) z0 = pz;
      if (px + 1 > x1) x1 = px + 1;
      if (pz + 1 > z1) z1 = pz + 1;
    }
    lodClipRect = lodCovPatches ? [x0 * PB, z0 * PB, x1 * PB, z1 * PB] : [1e9, 1e9, -1e9, -1e9];
  } else lodClipRect = [1e9, 1e9, -1e9, -1e9];
  lodClipOn = lodCovPatches ? 1 : 0;
  covTex.needsUpdate = true;
}

const lodMatFor = () => {
  if (lodMat) return lodMat;
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, side: THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLodCov = uLodCov; sh.uniforms.uCovAt = uCovAt; sh.uniforms.uCovBlk = uCovBlk;
    sh.uniforms.uKill = uKill;
    sh.vertexShader = 'varying vec3 dvWorld;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tdvWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = 'uniform sampler2D uLodCov;\nuniform vec2 uCovAt;\nuniform float uCovBlk;\nuniform float uKill;\nvarying vec3 dvWorld;\n' + sh.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif ( uKill > 0.5 && uKill < 1.5 ) discard;\n\tif ( uKill > 1.5 && texture2D( uLodCov, vec2( 0.5, 0.5 ) ).r > 0.5 ) discard;\n\tif ( texture2D( uLodCov, ( mod( floor( dvWorld.xz / uCovBlk ) - uCovAt, 128.0 ) + 0.5 ) / 128.0 ).r > 0.5 ) discard;');
  };
  // Without a distinct cache key three reuses the unpatched program for the same material shape.
  m.customProgramCacheKey = () => 'dvclip';
  return (lodMat = m);
};

const lodMeshes = new Map();                     // "rx,rz" -> { mesh, verts }



// The policy a tile has to agree with. A tile baked with another ground rule, water film or light

// curve is a different world, so it is refused rather than quietly shown.

const lodPolicy = () => ({

  groundFar: S.groundFar, waterOpacity: S.water, aoFar: S.aoFar, lightOn: S.light,

  darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale,

});

const lodActive = () => !!lodStore && !!S.lod && !!S.shellOn && !lodPolicyBad;



function makeLodStore(dim) {

  lodStore = new LodStore(dim, { policy: lodPolicy(), max: S.lodMax, log: (m) => { lodError = m; } });

  return lodStore;

}



/** Which regions actually have tiles. A save's bounding box is mostly empty - the overworld spans
 *  1 734 region slots and only 327 of them hold ground - so a view that asks for the box spends its
 *  first seconds on 1 400 empty requests and reports them as gaps. */
async function lodIndexLoad(store) {
  lodIndexPending = true;
  lodIndexError = '';
  try {
    const r = await fetch(`/lodindex?dim=${encodeURIComponent(store.dim)}`);
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.tiles)) throw new Error('no tiles field');
    if (lodStore !== store) return;             // the dimension changed while this was in flight
    store.setIndex(j.tiles);
    recomputeZoom();
    requestLod();                     // fill the view now rather than waiting for the next camera move
  } catch (e) {
    // No index: the store probes the requested range instead. Slower and noisier, but correct.
    lodIndexError = String((e && e.message) || e);
  }
  if (lodStore === store) lodIndexPending = false;
}

function clearLodMeshes() {

  for (const e of lodMeshes.values()) { lodGroup.remove(e.mesh); e.mesh.geometry.dispose(); }

  lodMeshes.clear();

  lodVerts = 0; lodTiles = 0;

}



// Which region rectangle the view wants. By default the whole dimension: the layer exists so that

// pulling back shows the world, and three frustum-culls every tile that is not on screen anyway.

function lodRequestRect() {

  const e = dimExtent(currentDim());

  if (!e) return null;

  let rx0 = e.minX >> 5, rx1 = e.maxX >> 5, rz0 = e.minZ >> 5, rz1 = e.maxZ >> 5;

  if (S.lodSpan > 0) {

    const [tcx, tcz] = centerChunk();

    const r = S.lodSpan >> 5;

    rx0 = Math.max(rx0, (tcx >> 5) - r); rx1 = Math.min(rx1, (tcx >> 5) + r);

    rz0 = Math.max(rz0, (tcz >> 5) - r); rz1 = Math.min(rz1, (tcz >> 5) + r);

  }

  return [rx0, rz0, rx1 - rx0 + 1, rz1 - rz0 + 1];

}



function requestLod() {

  if (!lodActive() || lodIndexPending) return;

  const r = lodRequestRect();

  if (!r) return;

  const [tcx, tcz] = centerChunk();

  lodStore.request(r[0], r[1], r[2], r[3], [tcx >> 5, tcz >> 5]);

}



/** Move fetched tiles into drawables. Installing one is one BufferGeometry, so this is cheap. */

function drainLod(now) {
  // A policy the tiles disagree with can also be in force from the very first frame (`?groundfar=0`
  // in the URL), where no settings change ever runs. Once enough tiles have been refused and none
  // are held, the layer is off: the live far grid keeps its full range instead of leaving the
  // distance unpainted, and the HUD says why.
  if (!lodPolicyBad && lodStore && lodStore.mismatch && !lodStore.tiles.size && lodStore.badTiles > 8) {
    lodPolicyBad = true;
    clearLodMeshes();
    retierPatches();
  }


  if (!lodActive()) { if (lodMeshes.size) clearLodMeshes(); return 0; }

  for (const [k, e] of lodMeshes) {

    // A tile the store dropped - evicted, or refused because its policy disagreed - stops drawing.

    if (!lodStore.tiles.has(k)) { lodGroup.remove(e.mesh); e.mesh.geometry.dispose(); lodMeshes.delete(k); }

  }

  let n = 0;

  for (const [k, t] of lodStore.tiles) {

    if (lodMeshes.has(k)) continue;

    if (n >= 8 || performance.now() > now + 4) break;

    const g = new THREE.BufferGeometry();

    g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));

    g.setAttribute('color', new THREE.Uint8BufferAttribute(t.col, 4, true));

    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, lodMatFor());

    mesh.name = 'lod';
    mesh.userData.tile = k;                  // so a ray can say which baked tile painted this pixel

    mesh.position.y = LOD_Y_BIAS;

    mesh.renderOrder = -1;

    lodGroup.add(mesh);

    lodMeshes.set(k, { mesh, verts: t.verts });

    n++;

  }

  lodVerts = 0;

  for (const e of lodMeshes.values()) lodVerts += e.verts;

  lodTiles = lodMeshes.size;

  return n;

}



/** Which baked tile (if any) covers a block column, and whether it is being drawn. */

function lodAt(wx, wz) {

  const rx = Math.floor(wx / (CH * 32)), rz = Math.floor(wz / (CH * 32));

  const t = lodStore ? lodStore.get(rx, rz) : null;

  return { rx, rz, held: !!t, drawn: lodMeshes.has(rx + ',' + rz), verts: t ? t.verts : 0,

    policy: t ? t.policy : null };

}







// ---- loop ------------------------------------------------------------------
// Where a frame actually goes. The render call is one of five buckets, and every argument about
// performance here ("must be the GPU", "must be the vertex count") has been a guess about a number
// nobody was printing. These are wall-clock laps - two clock reads per bucket per frame, free next to
// what the buckets cost - so the HUD can say which of them to go after.
// Cumulative; a window is the difference between two snapshots, so a probe can read it at any moment
// and does not have to land inside the same 0.5 s the HUD used.
const prof = { view: 0, mesh: 0, refill: 0, shell: 0, ov: 0, demote: 0, count: 0, render: 0, frames: 0 };
const PROF_KEYS = ['view', 'mesh', 'refill', 'shell', 'ov', 'demote', 'count', 'render'];
const profSum = (p) => PROF_KEYS.reduce((a, k) => a + p[k], 0);
const profSnap = () => ({ ...prof });
let profWin = profSnap();          // snapshot at the last HUD tick
const profWindow = () => {
  const dn = Math.max(1, prof.frames - profWin.frames);
  const out = { frames: dn };
  for (const k of PROF_KEYS) out[k] = +((prof[k] - profWin[k]) / dn).toFixed(2);
  out.total = +(profSum(prof) - profSum(profWin)) / dn;
  out.total = +out.total.toFixed(2);
  return out;
};
let pT = 0;
const lap = (k) => { const t = performance.now(); prof[k] += t - pT; pT = t; };
let cpuRenderMs = 0;
let last = performance.now(), frames = 0, loopFrames = 0, fpsAt = last, verts = 0, tris = 0, drawn = 0;
// A throw inside the frame loop used to freeze the page silently: the loop re-arms at the end of
// itself, so a single exception left every later probe reading a stale scene that looked like a
// rendering bug. Keep the loop alive and put the failure where a probe can see it.
let frameError = null;
function frame(now) {
  try { frameBody(now); }
  catch (e) {
    frameError = String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 400);
    console.error(e);
    if (hud) hud.msg.textContent = 'frame error: ' + e;
  }
  requestAnimationFrame(frame);
}

function collectGpu() {
  if (!timerExt || !gpuQuery) return;
  if (!gpuPendingSince) gpuPendingSince = performance.now();
  if (performance.now() - gpuPendingSince > TIMER_GRACE_MS) { abandonTimer(); return; }
  // Chrome's WebGL2 does not expose getQueryObject; the plain WebGL2 entry points take the query and
  // the generic QUERY_RESULT / QUERY_RESULT_AVAILABLE pname instead.
  const ready = gl2.getQueryParameter(gpuQuery, gl2.QUERY_RESULT_AVAILABLE);
  if (ready !== true) return;                    // still in flight; keep waiting, never spin on it
  const disjoint = gl2.getParameter(timerExt.GPU_DISJOINT_EXT);
  const q = gpuQuery;
  gpuQuery = null;
  gpuPendingSince = 0;
  // Read the result before deleting: reading after the delete is an INVALID_OPERATION on a dead
  // object, which is what 122 console warnings looked like.
  const ns = disjoint ? 0 : gl2.getQueryParameter(q, gl2.QUERY_RESULT);
  gl2.deleteQuery(q);
  if (!ns || ns <= 0) return;                    // a mode switch or a driver that reports nothing
  const ms = ns / 1e6;
  gpuMs = gpuMs ? gpuMs * 0.8 + ms * 0.2 : ms;
  gpuSamples++;
}

function frameBody(now) {
  loopFrames++;
  collectGpu();
  pT = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  stepKeys(dt);
  updateCamera();
  updateView();
  // If the setting asks for mesh workers and the pool is somehow empty (a failed start, a reset that
  // never restarted), try again instead of meshing every chunk on the render thread forever. The 4 s
  // gap keeps a browser that refuses workers from spinning.
  if (assets && workerCount() > 0 && pool.length === 0 && now - lastWorkerTry > 4000) {
    lastWorkerTry = now;
    try { startWorkers(); } catch (e) { workerError = String(e && e.message || e); }
  }
  lap('view');

  drainMeshes(now);
  lap('mesh');
  // Refill when idle: request() skips coordinates already held, so this converges on the radius
  // around the camera instead of storming the server every frame. It used to run on every idle
  // frame, which at skin 96 is a 37 000-key scan and sort per frame - about 10 ms of pure
  // bookkeeping, forever, with nothing left to fetch. A quarter of a second apart is plenty, and a
  // camera that crosses into a new chunk refills immediately.
  const [rcx, rcz] = centerChunk();
  if (store.inflight === 0 && store.queue.length === 0 &&
      (now - lastRefill > 400 || rcx !== refillCx || rcz !== refillCz)) {
    lastRefill = now; refillCx = rcx; refillCz = rcz;
    requestAround();
  }
  lap('refill');
  // The baked far layer goes in before the live layers, and against a fresh clock instead of the
  // frame's own start. Its work is a fetch plus a buffer upload, and it is the one stage whose
  // output makes every other stage cheaper. Left at the end of the frame it starved: a frame that
  // was already 22 ms into re-cutting far patches always exceeded the 4 ms budget, so 327 held tiles
  // sat fetched-but-never-drawn - and with no baked geometry on screen the live grid kept spending
  // the entire vertex budget on itself, which is what made the frame 22 ms in the first place.
  // Whichever coarse whole-world layer is drawing is the only one allowed on screen, and the answer
  // can change without a settings event: a bake landing, a tile refusal, a dimension switch.
  updateUnderground();
  const ovOn = ovActive() && !underFar;
  if (ovGroup.visible !== ovOn) ovGroup.visible = ovOn;
  if (shellMeshes.size || shellGroup.visible !== (S.shellOn && !underFar)) shellGroup.visible = S.shellOn && !underFar;
  if (lodGroup.visible !== (lodPainting() && !underFar)) lodGroup.visible = lodPainting() && !underFar;
  if (!underFar) drainLod(performance.now()); lap('lod');
  // Coarsest layer first: the overview is one request and a second of meshing, and it is what makes
  // the world legible at all while the chunk skin and the voxel detail are still arriving. Up close
  // the order is reversed - there the voxel detail is the whole picture, and making it wait behind a
  // 12 000 cell grid would only delay the thing the user is looking at.
  if (skinR > S.radius * 2) {
    drainOverview(now); lap('ov');
    if (shellStore && !underFar) { drainShellPatches(now); updateLodClip(); } lap('shell');
  } else {
    if (shellStore && !underFar) { drainShellPatches(now); updateLodClip(); } lap('shell');
    drainOverview(now); lap('ov');
  }

  // Demote before counting, so a pull-back stops paying for full-res geometry in the same frame it
  // decided to. Bounded: disposing 300 BufferGeometries in one frame is its own hitch.

  if (S.shellOn) demoteOutsideRing(64);
  // The store evicts on its own schedule; once a second is often enough to notice that a parked
  // mesh's payload has gone away, and rarely enough that walking the map is free.
  if (now - lastBytesSweep > 1000) { lastBytesSweep = now; sweepMeshBytes(); }
  lap('demote');

  verts = 0; tris = 0; drawn = 0; detailVerts = 0;
  recomputeAgg();
  for (const list of meshLists()) {
    for (const { mesh } of list) {
      const n = mesh.geometry.attributes.position.count;
      verts += n; tris += n / 3; drawn++; detailVerts += n;
    }
  }
  verts += shellVerts; tris += shellVerts / 3;
  drawn += shellMeshes.size + (ovActive() ? ovBands.size : 0);
  verts += ovVerts; tris += ovVerts / 3;
  verts += lodVerts; tris += lodVerts / 3; drawn += lodTiles;
  lap('count');

  const flat = params.get('view') === 'flat';
  const t0 = performance.now();
  // One query in flight at a time; the result is collected at the top of a later frame.
  if (timerExt && !gpuQuery && !flat) {
    gpuQuery = gl2.createQuery();
    gl2.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery);
    renderer.render(scene, camera);
    gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
  } else {
    renderer.render(flat ? flatScene : scene, flat ? flatCam : camera);
  }
  cpuRenderMs = performance.now() - t0;
  lap('render');
  prof.frames++;
  frames++;
  if (now - fpsAt > 500) {
    lastFps = frames * 1000 / (now - fpsAt);
    hud.fps.textContent = lastFps.toFixed(0);
    hud.verts.textContent = verts.toLocaleString();
    hud.tris.textContent = Math.round(tris).toLocaleString();
    hud.chunks.textContent = `${store.loaded} held (detail r${detailR}), ${drawn} meshes`;
    hud.queue.textContent = `${store.inflight} req, ${store.queue.length} queued`;
    hud.mesh.textContent = `${meshAvg.toFixed(1)} ms avg, ${meshMax.toFixed(1)} max, ${meshN}` +
      (aggTotal.darkCulled ? `, ${aggTotal.darkCulled} dark faces culled` : '') +
      (aggTotal.buried ? `, ${aggTotal.buried} buried` : '') +
      (aggTotal.covered ? `, ${aggTotal.covered} behind far skin` : '') +
      (pool.length ? ` on ${workerReady}/${pool.length} workers, ${jobs.size} in flight`
        : (workerError ? ` on the render thread (workers failed: ${workerError})` : ' on the render thread'));
    // One line saying what a frame costs and which bucket spent it, in ms per frame over the tick.
    const w = profWindow();
    hud.cpu.textContent = `${w.view}+${w.mesh}+${w.refill}+${w.shell}+${w.ov}+${w.demote}+${w.count}+${w.render} ` +
      `= ${w.total} ms/frame over ${w.frames} frames` +
      (timerExt ? ` | gpu ${gpuMs.toFixed(1)} ms, draw scale ${(resWanted() / DPR_CAP).toFixed(2)}`
        : ` | draw scale ${(resWanted() / DPR_CAP).toFixed(2)} (no gpu timer here)`);
    tuneRes(now);
    profWin = profSnap();
    meshWait = 0;                                  // a per-HUD-tick peak, not an all-time one
    if (shellStore) {
      hud.shell.textContent = `${shellMeshes.size} patches / ${shellStore.loaded} shells (r${skinR}), ` +
        `${shellVerts.toLocaleString()} verts, ${shellMs.toFixed(1)} ms (${tierLabel()})` +
        (overview ? (ovActive()
          ? ` / world layer ${ovCells.toLocaleString()} cells, ${ovVerts.toLocaleString()} verts` +
            (ovSkipped ? ` (${ovSkipped.toLocaleString()} hidden under finer terrain)` : '')
          : ' / world layer off (baked tiles cover the world)') : '') +
        (lodPolicyBad ? ` / baked tiles disagree about the terrain rule (${lodStore.mismatch}) - ` +
          'live far mesh; re-run npm run bake:lod'
          : lodTiles ? ` / baked ${lodTiles} tiles, ${lodVerts.toLocaleString()} verts` +
            (lodStore && lodStore.gaps() ? ` (${lodStore.gaps()} missing)` : '') +
            (lodStore && lodStore.shadeDiff ? ` (shaded for ${lodStore.shadeDiff})` : '') : '');
    }
    const [cx, cz] = centerChunk();
    hud.pos.textContent = `${rig.target.x.toFixed(0)} ${rig.target.y.toFixed(0)} ${rig.target.z.toFixed(0)} (chunk ${cx},${cz})`;
    // Keep the sliders honest: the zoom slider has to follow the wheel, and its ceiling follows the
    // far-view setting. Skip the control being dragged so the panel never fights the pointer.
    if (panel && !panel.busy()) panel.refresh();
    frames = 0; fpsAt = now;
  }
}

// The GPU timer tells us the truth about the frame: our own CPU work is measured per bucket, and if
// the sum of those buckets is small while the frame rate is still poor, the pixels are the cost.
// WebGL only answers that question asynchronously, through a query that comes back a frame or two
// later; where the extension is missing (Firefox, SwiftShader) the governor stays off and the
// resolution row in the panel is the manual version of the same knob.
const gl2 = renderer.getContext();
let timerExt = gl2 && gl2.getExtension
  ? gl2.getExtension('EXT_disjoint_timer_query_webgl2') : null;
let gpuQuery = null, gpuMs = 0, gpuSamples = 0, gpuPendingSince = 0, timerDead = false;
const TIMER_GRACE_MS = 3000;

// A driver that accepts the query but never answers it must not leave one pending forever: after a
// grace period the query is dropped and the timer is switched off, which also turns off auto
// resolution (it has no number to work from) and says so in the HUD and in __world.res().
function abandonTimer(now) {
  if (gpuQuery) { gl2.deleteQuery(gpuQuery); gpuQuery = null; }
  timerDead = true;
  timerExt = null;
}

function applyRes() {
  renderer.setPixelRatio(resWanted());
  resize();
}

function tuneRes(now, force = false) {
  if (!S.resAuto || !timerExt || params.get('view') === 'flat') return;
  // Waiting on the network or on meshing threads is not the graphics card's fault, and shrinking the
  // picture would not help.
  if (!force && (store.inflight || store.queue.length || store.dirty.size || jobs.size)) return;
  // Neither is being CPU-bound: `total - render` is our own work, and while it is large the frame is
  // spent meshing, not drawing.
  const w = profWindow();
  if (!force && w.total - w.render > (1000 / S.targetFps) * 0.5) return;
  if (gpuSamples === 0 || now - resTuneAt < 900) return;
  resTuneAt = now;
  const want = 1000 / S.targetFps;
  if (gpuMs > want * 0.85 && resAuto > 0.5) resAuto = Math.max(0.5, resAuto * 0.88);
  else if (gpuMs < want * 0.55 && resAuto < 1) resAuto = Math.min(1, resAuto * 1.06);
  else return;
  applyRes();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  recomputeZoom();                     // a wider window reaches farther, so the ceiling moves with it
  // The flat view is measured in CSS pixels, so it has to follow the viewport too; forgetting
  // this is how a 1:1 debug view ends up squeezed into the wrong part of the canvas.
  if (flatCam) {
    flatCam.left = 0; flatCam.right = w; flatCam.top = 0; flatCam.bottom = -h;
    flatCam.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);

// ---- flat atlas view (?view=flat) -----------------------------------------
// A 1:1, unlit, unprojected view of the atlas. It isolates "is the texture uploaded the way we
// address it?" from every other bug, which is exactly the question a wrong-looking sprite raises.
let flatCam = null, flatScene = null;
function buildFlatView() {
  const size = assets.size;
  flatScene = new THREE.Scene();
  flatScene.background = new THREE.Color(0x20242a);
  flatCam = new THREE.OrthographicCamera(0, innerWidth, 0, -innerHeight, -1, 1);
  const geo = new THREE.PlaneGeometry(size, size);
  // PlaneGeometry puts uv (0,0) at its bottom-left corner; the atlas is addressed from its top-left
  // (v0 = top row, flipY=false upload), so mirror v or the debug view shows the page upside down.
  const puv = geo.attributes.uv;
  for (let i = 0; i < puv.count; i++) puv.setY(i, 1 - puv.getY(i));
  const quad = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: atlasTex }));
  quad.position.set(size / 2, -size / 2, 0);
  flatScene.add(quad);
  for (const id of ['hud', 'help']) if ($(id)) $(id).hidden = true;
}
// Headless verification (tools/browser-probe.mjs) and the browser console both need a way in.
let bootError = null, lastFps = 0;

// Projection helpers live at module scope so internal callers (texProbe) and the page-side debug
// handle share one implementation instead of shadowing each other.
function screenOf(x, y, z) {
  // project() reads matrixWorldInverse, which only refreshes during render; a probe that moves the
  // camera and projects in the same task would otherwise project against last frame's pose.
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const v = new THREE.Vector3(x, y, z).project(camera);
  return {
    x: +((v.x * 0.5 + 0.5) * innerWidth).toFixed(1),
    y: +((1 - (v.y * 0.5 + 0.5)) * innerHeight).toFixed(1),
    ndcz: +v.z.toFixed(3),
  };
}

// Force a render immediately before the read so the drawing buffer is still intact. It has to
// render whichever view is on screen: reading after a forced main-scene render while the flat view
// is displayed would compare the 3D world against the atlas image.
function pick(x, y) {
  const flat = params.get('view') === 'flat';
  renderer.render(flat ? flatScene : scene, flat ? flatCam : camera);
  const gl = renderer.getContext(), dpr = renderer.getPixelRatio();
  const px = new Uint8Array(4);
  // readPixels is bottom-origin: the device row covering CSS row y starts at h - (y+1), and the
  // center of that row is (h - y - 0.5) from the bottom. Using (h - y) reads one row too high.
  const gx = Math.floor((x + 0.5) * dpr), gy = Math.floor((innerHeight - y - 0.5) * dpr);
  gl.readPixels(gx, gy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px];
}

// The parts of a ray hit that a colour probe needs, shared by the single-hit and hit-stack probes.
// Attribution is fiddly (a hit sits exactly on a face plane), and the two probes must agree about
// which block a pixel means, so it lives here once.
function describeHit(hit, ray) {
  const p = hit.point, d = ray.direction;
  const n = hit.face && hit.face.normal;
  const cands = [];
  if (n) { cands.push([-n.x, -n.y, -n.z]); cands.push([n.x, n.y, n.z]); }
  cands.push([d.x, d.y, d.z]);
  let block = null, key = null;
  for (const [sx, sy, sz] of cands) {
    const b = [Math.floor(p.x + sx * 0.05), Math.floor(p.y + sy * 0.05), Math.floor(p.z + sz * 0.05)];
    block = block ?? b;
    const k = atState(...b);
    if (k && k !== 'minecraft:air') { block = b; key = k; break; }
  }
  if (!key) key = atState(...block);
  let drawn = 'detail';
  for (let o = hit.object; o; o = o.parent) {
    // The overview is its own group (it draws under the skin), so without this a coarse world-layer
    // quad reports itself as detail and a "what painted this pixel" probe lies about the LOD stack.
    if (o === lodGroup) { drawn = 'lod'; break; }
    if (o === ovGroup) { drawn = 'overview'; break; }
    if (o === shellGroup) { drawn = 'shell'; break; }
  }
  // The colour of a shell quad came from the state the mesher picked for that quad, which after
  // decimation is the tallest column of the cell - not the column this ray landed in.
  const ids = hit.object.geometry.userData?.shellState;
  const qid = drawn !== 'detail' && ids && hit.faceIndex !== undefined && hit.faceIndex < ids.length
    ? ids[hit.faceIndex >> 1] : 0;
  const shellState = qid ? assets.states[qid - 1]?.k ?? null : null;
  const sh = drawn === 'shell' ? shellAt(Math.floor(p.x / 16), Math.floor(p.z / 16)) : null;  const shellColumn = sh
    ? (() => { const id = sh.state[((Math.floor(p.z) & 15) << 4) | (Math.floor(p.x) & 15)];
        return id ? assets.states[id - 1]?.k ?? null : null; })()
    : null;
  return {
    point: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
    block, drawn, state: drawn === 'shell' ? null : key,
    shellState: shellState ?? shellColumn, shellColumn,
    lodTile: drawn === 'lod' ? hit.object.userData?.tile ?? null : null,
    nrm: n ? [Math.round(n.x), Math.round(n.y), Math.round(n.z)] : null,
    // identity of the quad that drew this pixel: two samples with the same `quad` sit on the same
    // face, so their framebuffer colours must match the mesh exactly, with no coverage mixing
    quad: `${hit.object.name ?? '?'}:${hit.faceIndex >> 1}`,
    op: hit.object.material.opacity ?? 1,
    // the bytes the mesh itself wrote for this triangle; the probe converts them to the same space
    // as the framebuffer, so a wrong pixel can be pinned to mesh, material, or blend
    vcol: (() => {
      const ca = hit.object.geometry.attributes.color, f = hit.face;
      return ca && f ? [f.a, f.b, f.c].map((i) => [ca.getX(i), ca.getY(i), ca.getZ(i)]) : null;
    })(),
  };
}

// Everything a pixel is made of, front to back. A translucent quad is blended over whatever is
// behind it, so the nearest hit alone cannot explain the colour of a water pixel - the lake bed
// under it is half the answer.
function pickStack(x, y, limit = 8) {
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  rc.far = Math.max(64, scene.fog ? scene.fog.far : Infinity);
  return rc.intersectObjects(groups, true).slice(0, limit).map((h) => describeHit(h, rc.ray));
}

// Which block is under a screen pixel? Raycast what is actually drawn, then floor the hit point
// into block space. The hit lands exactly on a face plane, so nudge it a hair along the ray
// before flooring, otherwise the block *behind* the surface wins the floor().
function pickState(x, y) {
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  // Fog already hides anything past `far`, so a probe that reports a hit 900 blocks away is
  // describing pixels the user sees as plain sky; keep the ray to the visible range.
  rc.far = Math.max(64, scene.fog ? scene.fog.far : Infinity);
  const hit = rc.intersectObjects(groups, true)[0];
  if (!hit) return null;
  const h = describeHit(hit, rc.ray);
  const p = hit.point, key = h.state ?? h.shellState;
  const what = h.drawn, shellKey = h.shellState, shellColKey = h.shellColumn;
  // Shell and detail own different data, and describeHit reports both views: which pass drew the
  // pixel, the state whose sprite painted it, and the heightmap column the ray landed in.
  const cell = key ? window.__world.stateQuads(key) : null;
  // "What colour did the mesh itself carry here?" - the raw bytes of the colour attribute at the hit
  // triangle. Without this, a wrong pixel can only be blamed on the data or on the material.
  const ca = hit.object.geometry.attributes.color;
  const face = hit.face;
  return {
    point: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
    block: h.block,
    pass: hit.object.renderOrder,
    drawn: what,
    obj: hit.object.name ?? null,
    // the quad's own direction, so a probe can compare a pixel against the shade that face gets
    nrm: h.nrm,
    quad: h.quad,
    mat: (() => {
      const m = hit.object.material;
      return { type: m.type, vc: !!m.vertexColors, map: !!m.map, side: m.side,
        opacity: m.opacity, alphaTest: m.alphaTest, fog: !!m.fog,
        base: m.color.toArray().map((v) => +v.toFixed(2)) };
    })(),
    vcol: (ca && face) ? [face.a, face.b, face.c].map((i) => [ca.getX(i), ca.getY(i), ca.getZ(i)]) : null,
    state: key,
    shellState: shellKey,
    shellColumn: shellColKey,
    quads: cell && cell.map((q) => ({ tex: q.tex, dir: q.dir, id: assets.textures[q.tex]?.id ?? null })),
  };
}

// One bulk read of the drawing buffer. Per-pixel readPixels forces a full render each time, which
// turns a million-pixel upload check into an hour of GPU work; this reads everything once.
// Rows come back in GL order (row 0 = bottom of the screen).
function grabFrame() {
  const flat = params.get('view') === 'flat';
  renderer.render(flat ? flatScene : scene, flat ? flatCam : camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf, w, h, dpr: renderer.getPixelRatio() };
}

// Sample the CPU copy of the atlas with atlas-space uv (v measured from the top, as atlas.json
// addresses it). Keeping this exported lets a probe compare the framebuffer against the image
// itself rather than against the same code path that produced the uv.
function sampleAtlas(u, v) {
  if (!assets || !atlasPixels) return null;
  const size = assets.size;
  const x = Math.min(size - 1, Math.max(0, Math.round(u * size - 0.5)));
  const y = Math.min(size - 1, Math.max(0, Math.round(v * size - 0.5)));
  const i = (y * size + x) * 4;
  return [atlasPixels[i], atlasPixels[i + 1], atlasPixels[i + 2], atlasPixels[i + 3]];
}

/** [sky, block] light stored at a world coordinate, or null when no chunk is loaded there. */
function atLight(wx, wy, wz) {
  if (!store) return null;
  const c = store.get(Math.floor(wx / 16), Math.floor(wz / 16));
  if (!c) return null;
  const s = c.sectionAt(wy);
  if (!s) return null;
  return [s.sky ?? 0, s.blk ?? 0];
}

function atState(wx, wy, wz) {
  if (!store) return null;
  const c = store.get(Math.floor(wx / 16), Math.floor(wz / 16));
  if (!c) return null;
  const id = c.stateAt(wx & 15, wy, wz & 15);
  return id ? assets.states[id - 1]?.k ?? `id${id}` : null;
}

window.__world = {
  get state() {
    return {
      fps: lastFps, frameError, loopFrames, verts, tris, drawn, bootError: bootError && bootError.message,
      chunks: store ? store.loaded : 0, inflight: store ? store.inflight : -1,
      queued: store ? store.queue.length : -1, missing: store ? store.missing.size : -1,
      dirty: store ? store.dirty.size : -1, dist: rig.dist, dim: hud.dim.value,
      mesh: aggTotal, meshMs: +meshAvg.toFixed(2), meshMax: +meshMax.toFixed(2), meshed: meshN,
      // What the player actually waits for: request-accepted to mesh-landed, which includes queueing.
      meshWait: +meshWait.toFixed(2), workers: pool.length, workerReady, workerError, workerReadyMsgs, meshQueued: jobs.size,
      lodOn: lodActive() ? 1 : 0, lodTiles, lodVerts, lodAvail: lodAvail ? 1 : 0,
  lodGaps: lodStore ? lodStore.gaps() : 0, lodError, lodCap: S.lodCap,
  shellPatches: shellMeshes.size, shellVerts, retired: retireN, shellHeld: shellStore ? shellStore.loaded : 0,
      shellTextured: [...shellMeshes.values()].filter((e) => e.mode === 1).length,
      ovCells, ovVerts, ovSkipped, ovMs: +ovMs.toFixed(1), ovReady: !!overview, ovOn: ovActive() ? 1 : 0,
      ovMeshes: ovGroup.children.length,   // must equal ovBands: more means ghost bands still drawing
      ovBands: ovBands.size, ovBandsTotal: ovBandTotal(), ovBandRows: ovBandRows(),
      shellMissing: shellStore ? shellStore.missing.size : 0,
      shellMs: +shellMs.toFixed(2), shellMsMax: +shellMsMax.toFixed(2),
      shellCells: tiers().slice(), shellTiers: tierLabel(),
      shellTiersLive: [...patchTier.values()],
      skinRadius: skinR, skinCap: S.skinCap, skinFloor: S.skinFloor,
      // The three radii of PLAN 7.2, plus what each layer actually costs. `detailVerts` is the number
      // that was invisible before: `verts - shellVerts - ovVerts` used to be the only way to get it.
      detailRadius: detailR, detailCeiling: S.radius, payloadRadius: payloadR, detailPx: S.detailPx,
      detailMeshes: meshes.size, detailVerts, demoted, dirtyPatches: dirtyPatches.size, bytesHeld: store ? store.bytesHeld : 0,
      underFar: underFar ? 1 : 0,
      cullDark: aggTotal.darkCulled, cullBuried: aggTotal.buried, cullCoveredFaces: aggTotal.covered,
      detailLod: S.detailLod, detailReachBlocks: Math.round(detailReach(pxPerRad(), S.detailPx)),
      lightOn: S.light ? 1 : 0, darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale, ao: S.ao ? 1 : 0,
      cavesOn: S.caves, darkcut: S.caves ? -1 : S.darkcut,
      // The zoom-back budget: what is parked, what it costs, how often it was reused.
      meshCacheMB: +(meshBytesTotal / 1048576).toFixed(1), meshCachedChunks: meshBytes.size,
      meshReused: cachedInstalls, meshCacheDropped: meshBytesDropped,
      farCostScale: +costScale.toFixed(2), farFloorBoost: floorBoost, cpuRenderMs: +cpuRenderMs.toFixed(2),
      shellPatch: S.patch, maxZoom: S.maxZoom, worldSpan: S.worldSpan,
      near: camera.near, far: camera.far,
      fogNear: scene.fog ? scene.fog.near : 0, fogFar: scene.fog ? scene.fog.far : 0,
      target: [+rig.target.x.toFixed(1), +rig.target.y.toFixed(1), +rig.target.z.toFixed(1)],
      states: assets ? assets.states.length : 0, atlas: assets ? assets.size : 0, mipCap,
    };
  },
  go: (x, y, z) => { rig.target.set(x, y, z); },
  // asset-table probes for headless verification ("state" is the stats getter, so this one has
  // to have a different name or it silently replaces it)
  bake: (k) => (assets ? assets.states[assets.indexOf(k)] ?? null : null),
  cell: (i) => (assets ? assets.texCell(i) ?? null : null),
  // The quads a state draws for one face direction. A probe needs this *before* picking a block, so
  // it can skip states that stack an overlay quad on top of the face it wants to measure (grass
  // blocks do exactly that: side plus side_overlay).
  stateQuads: (key, dir = -1, armIdx = 0) => {
    const i = assets.indexOf(key);
    if (i < 0) return null;
    const st = assets.states[i];
    const out = [];
    if (st.cube) {
      const code = st.cube[armIdx]?.[dir];
      if (code != null) {
        const tex = (code >> 3) & 0xfff;
        out.push({ tex, uvT: code & 7, dir, cell: assets.texCell(tex) });
      }
    } else if (st.g) {
      for (const q of st.g[armIdx] ?? []) {
        const pk = assets.ref[q * 2 + 1];
        const d = ((pk >> 12) & 7) - 1;
        if (dir >= 0 && d !== dir) continue;
        const tex = pk & 0xfff;
        out.push({ tex, dir: d, gi: assets.ref[q * 2], cull: ((pk >> 15) & 7) - 1,
                   cell: assets.texCell(tex) });
      }
    }
    return out;
  },
  at: (wx, wy, wz) => atState(wx, wy, wz),
  light: (wx, wy, wz) => atLight(wx, wy, wz),
  // [level, brightness-multiplier, colour-that-would-be-painted] for the cell a probe cares about.
  litAt: (wx, wy, wz) => store
    ? store.lightLevelAt(Math.floor(wx / 16), Math.floor(wz / 16), wx & 15, wy, wz & 15, S.skyScale) : -1,
  // the placeholder tint a state would get, so a probe can predict a colour instead of
  // only describing one after the fact
  tint: (k) => { const i = assets ? assets.indexOf(k) : -1; return i < 0 ? null : tintOf(assets.states[i]); },
  orbit: (yaw, pitch, dist) => {
    if (yaw != null) rig.yaw = yaw;
    if (pitch != null) rig.pitch = pitch;
    if (dist != null) rig.dist = dist;
  },
  // sample the scene straight down a column: what actually got drawn under the camera
  column: (wx, wz, r = 3) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const c = store && store.get(cx, cz);
    if (!c) return { error: `chunk ${cx},${cz} not loaded` };
    const out = [];
    for (let y = 200; y >= -64; y--) {
      const id = c.stateAt(wx & 15, y, wz & 15);
      if (!id) continue;
      const st = assets.states[id - 1];
      if (st && assets.stateAir[id - 1] === 1) continue;
      out.push({ y, k: st ? st.k : `id${id}` });
      if (out.length >= r) break;
    }
    return { column: [wx, wz], top: out };
  },

  // Numeric texture probe: re-mesh one chunk and find the triangle that covers a chosen block
  // face. Everything else (sampling the framebuffer, sampling the atlas image, scoring the two
  // orientation hypotheses) is done page-side so the maths stays visible.
  texProbe: (wx, wy, wz, dirIdx = 1) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const c = store && store.get(cx, cz);
    if (!c) return { error: `chunk ${cx},${cz} not loaded` };
    const at = (ax, az, lx, ly, lz) => store.stateIndexAt(ax, az, lx, ly, lz, stateOf);
    const { streams } = meshChunk(assets, c, at);
    const D = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][dirIdx];
    const q = [wx + 0.5 + D[0] * 0.5, wy + 0.5 + D[1] * 0.5, wz + 0.5 + D[2] * 0.5];
    const triAt = (s, i) => [0, 1, 2].map((k) => ({
      p: [s.position[(i + k) * 3], s.position[(i + k) * 3 + 1], s.position[(i + k) * 3 + 2]],
      uv: [s.uv[(i + k) * 2], s.uv[(i + k) * 2 + 1]],
      col: [s.color[(i + k) * 4] / 255, s.color[(i + k) * 4 + 1] / 255, s.color[(i + k) * 4 + 2] / 255],
    }));
    let nearest = null, hit = null;
    for (let pass = 0; pass < streams.length && !hit; pass++) {
      const s = streams[pass];
      for (let i = 0; i + 5 < s.count; i += 6) {
        const t = triAt(s, i);
        const e1 = t[1].p.map((v, k) => v - t[0].p[k]);
        const e2 = t[2].p.map((v, k) => v - t[0].p[k]);
        const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(...nrm);
        if (len < 1e-9) continue;
        const n = nrm.map((v) => v / len);
        const pp = q.map((v, k) => v - t[0].p[k]);
        const dist = pp[0] * n[0] + pp[1] * n[1] + pp[2] * n[2];
        const d2 = pp[0] ** 2 + pp[1] ** 2 + pp[2] ** 2;
        if (!nearest || d2 < nearest.d2) nearest = { d2, pass, tri: t };
        if (Math.abs(dist) > 0.02) continue;
        // barycentric containment of the face centre
        const d00 = e1[0] ** 2 + e1[1] ** 2 + e1[2] ** 2;
        const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
        const d11 = e2[0] ** 2 + e2[1] ** 2 + e2[2] ** 2;
        const d20 = pp[0] * e1[0] + pp[1] * e1[1] + pp[2] * e1[2];
        const d21 = pp[0] * e2[0] + pp[1] * e2[1] + pp[2] * e2[2];
        const den = d00 * d11 - d01 * d01;
        if (!den) continue;
        const v = (d11 * d20 - d01 * d21) / den;
        const w = (d00 * d21 - d01 * d20) / den;
        if (v < -1e-4 || w < -1e-4 || v + w > 1 + 1e-4) continue;
        hit = { d2, pass, tri: t, bary: [1 - v - w, v, w] };
        break;
      }
    }
    const best = hit || nearest;
    if (!best) return { error: 'chunk produced no triangles' };
    return {
      face: [wx, wy, wz, dirIdx], state: __world.at(wx, wy, wz), pass: best.pass,
      exact: !!hit, d2: +best.d2.toFixed(5),
      tri: best.tri.map((t) => ({ p: t.p.map((v) => +v.toFixed(3)), uv: t.uv.map((v) => +v.toFixed(4)), col: t.col.map((c2) => +c2.toFixed(3)) })),
    };
  },
  goto: applyGoto,
  screenOf,
  shellAt: (cx, cz) => {
    const s = shellAt(cx, cz);
    if (!s) return null;
    const tops = [], ground = [], cover = [];
    for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
      const k = (z << 4) | x;
      tops.push(s.height[k] - HEIGHT_BIAS);
      ground.push(s.ground ? s.ground[k] - HEIGHT_BIAS : s.height[k] - HEIGHT_BIAS);
      const cid = s.cover ? s.cover[k] : s.state[k];
      cover.push(assets.states[cid - 1] ? assets.states[cid - 1].k : null);
    }
    return { cx: s.cx, cz: s.cz, tops, ground, cover,
      states: [...new Set(s.state.filter((v) => v))].length };
  },
  patches: () => [...shellMeshes.keys()],
  // The baked far layer: which tile covers a block, how many are held/drawn, and what was refused.
  lodDiag: () => ({
    on: lodActive() ? 1 : 0, avail: lodAvail ? 1 : 0, cap: S.lodCap,
    clipOn: lodClipOn, clip: lodClipRect.map((v) => (v > 1e8 ? 'off' : v)), cov: lodCovPatches,
    held: lodStore ? lodStore.tiles.size : 0, drawn: lodTiles, verts: lodVerts,
    wanted: lodStore ? lodStore.wanted.size : 0, gaps: lodStore ? lodStore.gaps() : 0,
    indexed: lodStore && lodStore.index ? lodStore.index.size : -1,
    blind: lodStore ? lodStore.reqBlind : 0, pending: lodIndexPending ? 1 : 0,
    policyBad: lodPolicyBad ? 1 : 0, shadeDiff: lodStore ? lodStore.shadeDiff : null,
    indexError: lodIndexError,
    missingN: lodStore ? lodStore.missing.size : 0,
    missingSample: lodStore ? [...lodStore.missing.keys()].slice(0, 6) : [],
    inflight: lodStore ? lodStore.inflight.size : 0, refused: lodStore ? lodStore.badTiles : 0,
    mismatch: lodStore ? lodStore.mismatch : null, error: lodError,
    rect: lodRequestRect(),
  }),
  // Which unloaded-but-far-painted neighbours a chunk's faces would be hidden behind.
  coveredAt: (cx, cz) => coveredNeighbours(cx, cz),
  /**
   * Debug for the baked-tile discard, because "the coarse layer is still painting the close ground"
   * can come from three different bugs (the coverage set is wrong / the CPU thinks it is covered but
   * the GPU never sees it / the shader patch is not in the compiled program). These answer each one:
   *   dbgCovAt(x, z)  what the CPU-side coverage map says for that block column
   *   dbgCovFill(1)   force the whole map covered - if tiles still paint, the discard is not in the
   *                   compiled shader
   *   dbgLodUniforms  the uniforms the shader is sampling with, and how many compiled programs carry
   *                   the patched material's cache key
   */
  dbgCovAt: (wx, wz) => {
    const px = Math.floor(wx / uCovBlk.value), pz = Math.floor(wz / uCovBlk.value);
    const tx = ((px - uCovAt.value.x) % COV_N + COV_N) % COV_N, tz = ((pz - uCovAt.value.y) % COV_N + COV_N) % COV_N;
    return { patch: [px, pz], texel: [tx, tz], covered: covData[((tz * COV_N + tx) << 2)], blk: uCovBlk.value };
  },
  dbgCovFill: (v) => { covForce = v === 0 ? 0 : (v > 0 ? 1 : -1); },
  dbgLodKill: (v) => { lodKill = +v || 0; uKill.value = lodKill; },
  dbgPrograms: () => renderer.info.programs.map((p) => ({ name: p.name, used: p.usedTimes, key: /dvclip\w*/.exec(p.cacheKey) })),
  dbgLodUniforms: () => ({
    at: [uCovAt.value.x, uCovAt.value.y], blk: uCovBlk.value, tex: !!uLodCov.value,
    patchedPrograms: renderer.info.programs.filter((p) => /dvclip/.test(p.cacheKey)).length,
  }),
  lodAt: (wx, wz) => lodAt(wx, wz),
  pickState,
  pickStack,
  // Ray for a screen point, so a probe can walk the world along the line of sight instead of only
  // asking what the rasteriser happened to draw there.
  ray: (x, y) => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
    return { o: rc.ray.origin.toArray(), d: rc.ray.direction.toArray() };
  },
  // What the coarse layer thinks it is skipping. Most "why is a 64 block plate drawn over the terrain
  // in front of me" reports are this square being wrong or the bands being stale, and the screenshot
  // cannot tell those apart.
  // Which LOD actually owns a world position, and at what cell size: "why is that face so blocky"
  // needs the tier of the patch under the cursor, not just the label in the HUD.
  renderMs: () => +cpuRenderMs.toFixed(2),
  // Bucket means in ms/frame over the last HUD tick (0.5 s). The honest answer to "what is slow".
  prof: () => profWindow(),
  res: () => ({ scale: resWanted(), cap: DPR_CAP, auto: resAuto, setting: S.res, autoOn: !!S.resAuto,
    gpuTimer: !!timerExt, timerDead, gpuMs, cpuRenderMs, samples: gpuSamples }),
  // Drive the resolution governor from a probe: claim a GPU time and run one step of the control
  // loop. Without this the shrink path only shows up on a card that is actually slow, and a probe
  // cannot tell "the governor is off" from "the governor decided correctly".
  tuneResNow: (ms, force = true) => {
    if (typeof ms === 'number' && ms > 0) { gpuMs = ms; gpuSamples = Math.max(1, gpuSamples); }
    resTuneAt = 0;
    tuneRes(performance.now(), !!force);
    return { auto: +resAuto.toFixed(3), gpuMs: +gpuMs.toFixed(2), want: 1000 / S.targetFps,
      px: [renderer.getContext().drawingBufferWidth, renderer.getContext().drawingBufferHeight] };
  },
  setRes: (v) => { S.res = Math.max(0.4, Math.min(2, +v)); resAuto = 1; applyRes(); },
  markCounts: () => ({ ...markWhy }),
  profAll: () => {
    const n = Math.max(1, prof.frames);
    const out = { frames: prof.frames };
    for (const k of PROF_KEYS) out[k] = +(prof[k] / n).toFixed(2);
    out.total = +(profSum(prof) / n).toFixed(2);
    return out;
  },
  lodOf: (wx, wz) => {
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH), pk = patchKey(cx, cz);
    const tier = patchTier.get(pk);
    return {
      chunk: [cx, cz], patch: pk, tier: tier ?? null, cell: cellOfTier(tier ?? tierAt(cx, cz, 0)),
      shell: !!shellAt(cx, cz), detail: detailHere(cx, cz), tiers: tierLabel(),
      // "no detail mesh" has two very different causes now, and a probe must tell them apart:
      // demoted (voxels held, the grid paints it) versus never fetched.
      payload: !!store.has(cx, cz), inDetailRing: inDetailRing(cx, cz, 1),
      detailRadius: detailR, payloadRadius: payloadR,
    };
  },
  // What the coarse layer holds at one world position, so "is that sky a hole, or is the world simply
  // not explored here" is a question a probe answers instead of one guessed from a screenshot.
  ovAt: (wx, wz) => (overview ? (() => {
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH);
    const i = Math.floor((cx - overview.x0) / overview.cell);
    const j = Math.floor((cz - overview.z0) / overview.cell);
    const inside = i >= 0 && j >= 0 && i < overview.w && j < overview.h;
    const k = inside ? j * overview.w + i : -1;
    return {
      chunk: [cx, cz], cell: [i, j], inside,
      h: inside ? overview.height[k] - HEIGHT_BIAS : null,
      state: inside && overview.state[k] ? (assets.states[overview.state[k] - 1] || {}).k : null,
      shell: !!shellAt(cx, cz), detail: detailHere(cx, cz), covered: ovCovered(cx, cz, overview.cell),
      payload: !!store.has(cx, cz), inDetailRing: inDetailRing(cx, cz, 1),
    };
  })() : null),
  ovDiag: () => (overview ? {
    cell: overview.cell, x0: overview.x0, z0: overview.z0, w: overview.w, h: overview.h,
    skip: ovSkip(), skinR, dist: Math.round(rig.dist), target: centerChunk(),
    bands: ovBands.size, bandTotal: ovBandTotal(), bandRows: ovBandRows(),
    cells: ovCells, skipped: ovSkipped, cov: ovCov, covStamp: ovCovStamp, cursor: ovCursor,
    stale: [...ovBands.values()].filter((b) => b.sig !== ovSig(ovCovStamp)).length,
    bandSig: [...ovBands.entries()].slice(0, 3).map(([i, b]) => `${i}:${b.sig}`),
  } : null),
  faceShade: FACE_SHADE,
  // The blending algebra the tests pin down, handed to probes so they predict a pixel with the same
  // numbers rather than reimplementing source-over and getting the colour space wrong.
  composite: { layerAlpha, stackOver, over, dmax, opacity: () => materials[2]?.opacity ?? 1 },
  // probes need to know which material a hit object actually used
  mats: () => ({ shell: shellMat, detail: materials.map((m) => m) }),
  pick,
  grab: grabFrame,
  renderer,
  scene,
  // the camera's own basis, so the movement keys can be checked numerically instead of eyeballed
  axes: () => (camera.updateMatrixWorld(), {
    fwd: fwdOf().toArray(), right: rightOf().toArray(),
    view: camera.getWorldDirection(new THREE.Vector3()).toArray(),
    camRight: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray(),
    yaw: +rig.yaw.toFixed(3),
  }),
  keys: rig.keys, stepKeys,
  // world -> screen pixels, for checking that a drag moves the scene the way the cursor does
  project: (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera);
    return [+((v.x * 0.5 + 0.5) * innerWidth).toFixed(1), +((1 - (v.y * 0.5 + 0.5)) * innerHeight).toFixed(1), +v.z.toFixed(3)]; },
  camera,
  atlasPixel: sampleAtlas,
  camPos: () => camera.position.toArray().map((v) => +v.toFixed(2)),
  sync: () => { updateCamera(); updateView(); },
  settings: S,
  // Probes and the console use short names; the panel keys are wordier.
  panel: () => panel,
  // Headless Chrome stops producing frames for a page it considers invisible, and a stalled rAF loop
  // makes every later probe read a frozen scene. Run the loop body by hand instead.
  // What the far grid costs under the current settings: columns it would hold, the multiplier the
  // budget walk settled on, and the resulting cell ladder. `gridVerts` is the same number in the
  // units the GPU counts, so an estimate and a mesh can be compared directly.
  gridEst: () => ({ columns: gridColumns(), costScale, floorBoost, vpc: +vertsPerColumn().toFixed(1),
    cutMs: +shellCutAvg.toFixed(2), cuts: shellCuts, dirty: dirtyPatches.size,
    estVerts: Math.round(gridColumns() * vertsPerColumn()), budget: S.vertBudget,
    cellPx: S.cellPx * costScale,
    verts: [...shellMeshes.values()].reduce((a, e) => a + (e.verts || 0), 0),
    tiers: [...shellMeshes.values()].map((e) => e.tier).sort() }),
  tick: (n = 1, dt = 16) => { const t = performance.now(); for (let i = 0; i < n; i++) frameBody(t + (i + 1) * dt); return loopFrames; },
  set: (k, v) => { const key = { dist: 'distance', far: 'skinCap', detail: 'radius', world: 'dim' }[k] ?? k; return panel ? panel.set(key, v) : undefined; },
  fit: () => fitWorld(),
  switchDim,
  dims: () => (meta?.dims ?? []).map((d) => d.id),
  dim: () => currentDim(),
};

// ---- settings --------------------------------------------------------------
// Applying a change is deliberately narrow: each control says what it invalidates, and the cheapest
// honest action is taken. `budget` and friends need nothing at all; anything that changes shell
// geometry has to re-dirty the patches that used to mesh against the old value.
function applySettings(what) {
  // A baked tile states the far paint it was made with. If the viewer changed that paint - the ground
  // rule, the water film, the light curve - the tiles that no longer agree are dropped and refused,
  // rather than going on drawing a world that disagrees with the settings.
  if (lodStore && lodStore.policy) {
    lodStore.policy = lodPolicy();
    if (lodStore.recheck()) clearLodMeshes();
    lodStore.forgetMissing();
    lodPolicyBad = false;               // the refetch under the new policy decides, tile by tile
  }
  if (what === 'water' || what === 'alphaTest') {
    if (materials) {
      materials[1].alphaTest = S.alphaTest;
      materials[2].opacity = S.water;
      materials[1].needsUpdate = materials[2].needsUpdate = true;
    }
    if (shellTexMat) shellTexMat.alphaTest = S.alphaTest;
    // The far view paints a lake as its bed plus a film of the same water at the same alpha. Where the
    // far layer is a flat plate that alpha is baked into the vertex colour, so clarity re-cuts; where
    // it is a real translucent quad the material change alone is enough.
    for (const pk of [...shellMeshes.keys()]) dirtyAdd(pk, 'apply');
    return;
  }
  if (what === 'aofar') {
    // The far darkening lives in the vertex colours, so the only way to change it is to re-cut. The
    // overview takes care of itself: the value is part of its band signature.
    for (const [pk] of shellMeshes) dirtyAdd(pk, 'apply');
    return;
  }
  if (what === 'fog' || what === 'skin') {
    if (shellStore) shellStore.keep = S.skinCap + 2;    // don't evict the ring the new ceiling wants
    recomputeZoom();
    rig.dist = Math.min(rig.dist, S.maxZoom);
    updateView();
    requestAround();
    retierPatches();
    return;
  }
  if (what === 'radius' || what === 'detailpx') {
    lastDetailR = -1;                     // force the ring, its store budgets, and a re-mark
    applyDetailBudget();
    requestAround();
    retierPatches();                      // land handed back by the ring goes to the far grid
    return;
  }
  if (what === 'lodtiles') {
    // Tiling on or off moves the boundary between "baked" and "meshed here", so every patch has to
    // re-decide, and the tiles have to be asked for again under the new policy.
    clearLodMeshes();
    if (lodStore) { lodStore.policy = lodPolicy(); lodStore.clear(); }
    retierPatches();
    for (const pk of [...shellMeshes.keys()]) dirtyAdd(pk, 'apply');
    recomputeZoom();
    requestAround();
    return;
  }
  if (what === 'lod' || what === 'skirt' || what === 'blend') {
    if (what === 'lod') costScale = 1;   // the user just restated the budget; let the loop re-decide
    retierPatches();
    for (const pk of [...shellMeshes.keys()]) dirtyAdd(pk, 'apply');
    return;
  }
  if (what === 'patch') {
    // Patch identity is a key in three maps at once, so changing the size invalidates all of them.
    for (const e of shellMeshes.values()) for (const m of [e.mesh, e.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
    shellMeshes.clear(); patchTier.clear(); recountShellVerts();
    if (shellStore) for (const k of shellStore.shells.keys()) markPatch(...k.split(',').map(Number), 'allshells');
    return;
  }
  if (what === 'shelltex' || what === 'texpx') {
    // Both the material objects and the per-patch choice change, so every patch has to be re-cut: the
    // mode is part of its signature, and the vertex colours differ between the two paints.
    if (!shellMat || !assets) return;
    makeShellMats();
    for (const [pk] of shellMeshes) dirtyAdd(pk, 'apply');
    return;
  }
  if (what === 'shellOn') {
    if (shellGroup) shellGroup.visible = S.shellOn;
    // The overview is a separate group (it draws under the skin), so the far-terrain switch has to
    // reach it too: "draw far terrain" off means nothing coarse anywhere in the view.
    ovGroup.visible = ovActive();
    if (!shellStore && S.shellOn) makeShellStore(hud.dim.value);
    requestAround();
    return;
  }
  if (what === 'ao' || what === 'light') {
    // Parked vertex bytes are not a re-tintable cache: they *are* the light and occlusion of the
    // moment they were made, so changing either retires every one of them.
    clearMeshBytes();
    // Occlusion and light are both baked into vertex colours, so the only honest way to see either
    // change is to re-mesh. The far layer bakes light into its colours too, so its patches re-cut
    // with them; the overview does it itself, since the light settings are in its band signature.
    if (store) for (const k of [...meshes.keys()]) store.dirty.add(k);
    if (what === 'light') for (const [pk] of shellMeshes) dirtyAdd(pk, 'apply');
  }
}

// The wheel ceiling. With the whole-extent overview underneath the far field, the only thing that
// bounds zoom-out is the size of the dimension itself; before the overview the ceiling had to follow
// the per-chunk skin, because past that there was nothing to draw and the world stopped mid-frame.
function recomputeZoom() {
  const byWorld = S.worldSpan ? maxZoomFor(S.worldSpan, camera.fov, 400) : Infinity;
  const bySkin = zoomCeiling(S.skinCap, camera.fov, camera.aspect);
  // Either coarse whole-dimension layer - the overview frame or the baked LOD tiles - means the
  // whole world is drawable, so the wheel may pull back that far.
  S.maxZoom = Math.max(60, (S.overview || lodActive()) ? byWorld : Math.min(byWorld, bySkin));
  if (rig.dist > S.maxZoom) rig.dist = S.maxZoom;
}

// Frame the whole loaded save: look at its middle from the ceiling distance.
function fitWorld() {
  const e = dimExtent();
  if (e) {
    // The extent is in chunks; the middle of chunk column [minX,maxX] is (minX+maxX+1)/2 chunks.
    rig.target.x = (e.minX + e.maxX + 1) * CH / 2;
    rig.target.z = (e.minZ + e.maxZ + 1) * CH / 2;
  }
  rig.pitch = 0.72;
  rig.dist = S.maxZoom;
}

const storeOpts = () => ({
  tile: +(params.get('tile') ?? 6),
  // Evicting chunks the camera is about to look at again is how a view starts popping: keep
  // room for the whole requested radius plus a margin, and let ?maxchunks override for tests.
  maxChunks: +(params.get('maxchunks') ?? Math.max(400, (2 * S.radius + 5) ** 2)),
});

function makeShellStore(dim) {
  shellStore = new ShellStore(dim, {
    // Shells are 1 KB, so batches are much bigger than the voxel tiles; 16x16 is ~266 KB.
    tile: +(params.get('shelltile') ?? 16),
    keep: +(params.get('shellkeep') ?? Math.max(4, S.skinCap + 2)),
    maxConcurrent: +(params.get('shellconc') ?? 3),
  });
  // The store tracks dirtiness per chunk (a new shell also changes its four neighbours' walls);
  // the renderer only cares about whole patches, so coarsen at the boundary.
  shellStore.onChange(() => {
    for (const k of shellStore.takeDirty()) {
      const [cx, cz] = k.split(',').map(Number);
      markPatch(cx, cz, 'shellchange');
    }
  });
  return shellStore;
}

const DIM_LABEL = {
  'minecraft:overworld': 'Overworld',
  'minecraft:the_nether': 'Nether',
  'minecraft:the_end': 'End',
};
// Custom dimensions are named `modnamespace:something`; a person choosing one wants the friendly
// half, not the namespace they have to know the mod's name to read.
const dimLabel = (id) => DIM_LABEL[id]
  ?? (id.split(':')[1] ?? id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Change dimension without a page reload. A reload used to be the only path (`location.search =
// ?dim=...`), which also threw away every setting the user had just dialled in - and the dropdown
// that did it sat inside the HUD, which is pointer-events:none, so it never even responded to a
// click. Everything dimension-scoped is dropped here: chunk payloads, their meshes, the heightmap
// skin and its patches, and the in-flight worker jobs (guarded by dimGen).
function switchDim(id) {
  if (!id || id === currentDim() || !assets) return;
  dimGen++;
  clearMeshBytes();               // those bytes are voxels of the dimension we just left
  hud.dim.value = id;

  for (const k of [...meshes.keys()]) {
    const [cx, cz] = k.split(',').map(Number);
    dropChunkMesh(cx, cz);
  }
  store = new ChunkStore(id, storeOpts());
  applyDetailBudget();

  for (const e of [...shellMeshes.values()]) for (const m of [e.mesh, e.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
  shellMeshes.clear(); patchTier.clear(); dirtyPatches.clear(); recountShellVerts();
  if (shellStore && S.shellOn) makeShellStore(id);
  clearLodMeshes();
  if (lodStore) lodStore.clear();
  if (S.lod && S.shellOn) { makeLodStore(id); lodIndexLoad(lodStore); } else lodStore = null;
  if (S.overview) loadOverview(id); else clearOverview();
  resetWorkers();

  // Keep the camera where it is if that world has ground under it; otherwise go to the middle of
  // the new one. Y is left alone - the dimensions here overlap in height, and nothing in /meta
  // says where a dimension's floor is.
  const e = dimExtent(id);
  if (e) {
    const x0 = e.minX * CH, x1 = (e.maxX + 1) * CH, z0 = e.minZ * CH, z1 = (e.maxZ + 1) * CH;
    if (rig.target.x < x0 || rig.target.x > x1 || rig.target.z < z0 || rig.target.z > z1) {
      rig.target.x = (x0 + x1) / 2;
      rig.target.z = (z0 + z1) / 2;
    }
  }
  skinR = S.skinFloor;
  S.worldSpan = dimSpanBlocks(id);
  recomputeZoom();
  rig.dist = Math.min(rig.dist, S.maxZoom);
  updateView();
  requestAround();
  if (panel) panel.refresh();
}

// Sliders over the page's own settings object. Only the handful a person actually reaches for are
// out in the open; everything else lives in a collapsed group, because "cliff skirt" and "tier slack"
// are not phrases anyone who did not write the mesher should have to decode. Each control keeps its
// URL name in the tooltip, so a number from HANDOFF.md is still findable.
function buildPanel() {
  const dims = (meta?.dims ?? []).map((d) => {
    const e = d.chunkExtent;
    const km = e ? ` (${(Math.max(e.maxX - e.minX + 1, e.maxZ - e.minZ + 1) * CH / 1000).toFixed(0)} km)` : '';
    return { value: d.id, label: `${dimLabel(d.id)}${km}` };
  });
  const mfmt = (v) => `${Math.round(v)} m`;
  panel = mountPanel({
    title: 'view  (p)',
    items: [
      { key: 'dim', label: 'world', kind: 'select', options: dims,
        hint: 'Which world to look at. Switching keeps every setting and drops nothing but the loaded chunks.',
        get: () => currentDim(), set: (v) => switchDim(v) },

      { key: 'distance', label: 'zoom', min: 20, max: 1200, step: 1, maxFn: () => Math.max(40, Math.round(S.maxZoom)),
        fmt: mfmt,
        hint: 'How far the camera sits from what it looks at - the mouse wheel does the same. It runs up\nto the point where the whole world fits in the frame. Press F to jump straight there.',
        get: () => rig.dist,
        set: (v) => { rig.dist = Math.max(2, Math.min(S.maxZoom, v)); updateView(); requestAround(); } },

      { key: 'radius', label: 'close detail', min: 0, max: 14, step: 1, live: false,
        fmt: (v) => (v ? `${v * CH} m` : 'off'),
        hint: 'The most terrain built block by block with real textures, around what you look at - a\nceiling, not a promise: zoom out and less of it is drawn, because far away those\ntriangles are smaller than a pixel. Bigger is prettier and slower. URL: ?radius',
        get: () => S.radius, set: (v) => { S.radius = Math.max(0, v | 0); applySettings('radius'); } },

      { key: 'detailsharp', label: 'detail sharpness', min: 0.5, max: 12, step: 0.25,
        fmt: (v) => `${v} px`,
        hint: 'How close you have to be before a block is worth its own triangles - one block must still\ncover this many pixels. Zoom out past that and the cheap far terrain paints it instead: a 26 km\npull-back used to keep every full-res chunk of the spawn area on the GPU. URL: ?detailpx',
        get: () => S.detailPx, set: (v) => { S.detailPx = Math.max(0.25, v); applySettings('detailpx'); } },

      { key: 'detaillod', label: 'voxel detail regardless of zoom', kind: 'check', live: false,
        hint: 'Off keeps every loaded chunk built block by block even from kilometres out - the old\nbehaviour, and the honest way to compare what the LOD is buying you. URL: ?nodetaillod',
        get: () => S.detailLod, set: (v) => { S.detailLod = v; applySettings('detailpx'); } },

      { key: 'farshape', label: 'far terrain stands at', min: 0, max: 1, step: 1,
        fmt: (v) => ['treetops', 'the ground'][v],
        hint: 'What the coarse far terrain stands at. Trees, flowers and lake water are not a floor: a\ncell of grass under a 12 m spruce used to hang a 12 m dirt cliff under the treetops, and a cell of\nsand under 20 m of lake water drew a blue sheet. Default stands the cell on the solid ground and\nkeeps the lake skin. URL: ?groundfar',
        get: () => S.groundFar, set: (v) => { S.groundFar = Math.max(0, Math.min(1, v | 0)); applySettings('lod'); } },

      { key: 'lodtiles', label: 'baked far world (whole dimension)', kind: 'check', live: false,
        hint: 'The whole world below 16 blocks per column, pre-meshed on the server\n(npm run bake:lod) and streamed as region tiles, instead of being meshed in the browser on\nevery pan and zoom. Off restores live far meshing. URL: ?nolod',
        get: () => !!S.lod && lodAvail ? 1 : 0,
        set: (v) => {
          S.lod = v ? 1 : 0;
          if (S.lod && !lodStore && lodAvail) makeLodStore(currentDim());
          if (!S.lod) { clearLodMeshes(); }
          applySettings('lodtiles');
        } },

      { key: 'lodcap', label: 'live far grid stops at', min: 0, max: 16, step: 1,
        fmt: (v) => (v ? `${v} blocks` : 'never (mesh it all)'),
        hint: 'How coarse the browser-meshed far terrain is allowed to get before the baked tiles take\nover. Its only job is to not leave a gap where the tiles are already painting the same ground.\nURL: ?lodcap',
        get: () => S.lodCap,
        set: (v) => { S.lodCap = Math.max(0, Math.min(16, v | 0)); applySettings('lodtiles'); } },

      { key: 'cullcovered', label: 'drop walls the far view already paints', kind: 'check', live: false,
        hint: 'The edge of the loaded area is a full-depth wall of dirt down to the void. When the \nfar layer paints that ground the wall is hidden behind it, so it is not meshed at all - \nfewer trixels and no black band while chunks stream in. Where the save has no chunk there \n(a world frontier) the wall stays: it is the only thing painting that ground. Off restores \nevery wall. URL: ?nocullcovered',
        get: () => S.cullCovered, set: (v) => { S.cullCovered = v ? 1 : 0; applySettings('light'); } },

      { key: 'underfar', label: 'hide the surface layer underground', kind: 'check', live: true,
        hint: 'Down in a cavern the far layers are not a far view, they are the *surface*: their coarse \nplates and skirt walls hang around you as floating scraps, and cost verts and frames for nothing. \nWhen the block you stand in gets no skylight those layers stand down, until you are back under open \nskylight. A ravine keeps its walls - its floor sees the sky. URL: ?nounderfar',
        get: () => S.underFar,
        set: (v) => { S.underFar = v ? 1 : 0; } },

      { key: 'underdepth', label: 'blocks underground before the far view returns', min: 0, max: 24, step: 1,
        fmt: (v) => (v | 0),
        hint: 'How far below the surface skin the eye has to be before the far layers stand down. Small \nkeeps the ground painted around a shallow hole; large means the plates vanish the moment you \ndip under a canopy. URL: ?underdepth',
        get: () => S.underDepth,
        set: (v) => { S.underDepth = Math.max(0, v | 0); } },

      { key: 'buriedsky', label: 'skylight that still counts as open sky', min: 0, max: 15, step: 1,
        fmt: (v) => (v | 0),
        hint: 'A face under the surface skin is dropped only if the air in front of it gets no more \nthan this much skylight. Modded and Starlight light fields are not tidy: a sealed cavern reads \nskylight 1-2 in places, and demanding total darkness leaves floating scraps on cave walls. \nAt 15 nothing is ever dropped for being underground. URL: ?buriedsky',
        get: () => S.buriedSky,
        set: (v) => { S.buriedSky = Math.max(0, Math.min(15, v | 0)); applySettings('light'); } },

      { key: 'lodclip', label: 'hide baked tiles under the close view', kind: 'check', live: true,
        hint: 'A baked tile is one mesh over 512x512 blocks, so it cannot be unloaded near the camera -\nit is clipped there instead, or its 16 block columns stand over the close terrain as flat slabs\nwith straight cliff walls. Off draws them everywhere. URL: ?nolodclip',
        get: () => S.lodClip, set: (v) => { S.lodClip = v ? 1 : 0; updateLodClip(); } },

      { key: 'farsharp', label: 'far detail', min: 1, max: 6, step: 0.25,
        fmt: (v) => `${v} px`,
        hint: 'How small a block may get in the cheap far terrain before it is merged with its\nneighbours. Lower is sharper and costs more. URL: ?cellpx',
        get: () => S.cellPx, set: (v) => { S.cellPx = Math.max(0.5, v); applySettings('lod'); } },

      { key: 'shadow', label: 'shadow depth', min: 0, max: 1, step: 0.02, live: false,
        fmt: (v) => `${Math.round(v * 100)}%`,
        hint: 'How dark the crevices between blocks get, on top of the light field the save stores.\nApplies to terrain re-drawn after you move it. URL: ?ao',
        get: () => 1 - S.aoMin,
        set: (v) => { S.aoMin = Math.min(1, Math.max(0, 1 - v)); applySettings('ao'); } },

      { key: 'cave', label: 'cave brightness', min: 0, max: 1, step: 0.02, live: false,
        fmt: (v) => `${Math.round(v * 100)}%`,
        hint: 'How bright an unlit cell is drawn. The save really does put light 0 down there; this is\nhow much of that darkness you keep. 0 is in-game dark (caves go black), 0.32 is the default,\n1 switches lighting off. URL: ?darkfloor=',
        get: () => S.darkFloor,
        set: (v) => { S.darkFloor = Math.min(1, Math.max(0, v)); applySettings('light'); } },

      { key: 'caves', label: 'mesh unlit caves', kind: 'check', live: false,
        hint: 'Off (default) does not draw faces no light touches - the rock deep in a cave, the back of\n a tunnel. They were the majority of the vertex and mesh-time budget for something no\n camera can see. On draws every face, which is the old behaviour. URL: ?caves=1',
        get: () => S.caves, set: (v) => { S.caves = v ? 1 : 0; applySettings('light'); } },

      { key: 'darkcut', label: 'what counts as unlit', min: 0, max: 15, step: 1, live: false,
        fmt: (v) => S.caves ? 'caves drawn anyway' : (v <= 0 ? 'pitch dark only' : `light <= ${v}`),
        hint: 'The save stores light on a 0-15 scale. 0 (default) drops only faces in total darkness;\n raise it and the dim fringe of a torch pool goes too, which saves more and eats cave\n mouths. Faces whose light is unknown (neighbour chunk not loaded) are always kept. URL: ?darkcut=',
        get: () => S.darkcut,
        set: (v) => { S.darkcut = Math.min(15, Math.max(0, v | 0)); applySettings('light'); } },

      { key: 'buried', label: 'what counts as underground', min: 0, max: 32, step: 1, live: false,
        fmt: (v) => S.caves ? 'caves drawn anyway' : (v <= 0 ? 'only pitch dark' : `${v}+ blocks of rock`),
        hint: 'A lava pool 30 m down is lit - by the lava - and still invisible from above ground. A face\nwhose air cell sits this many blocks under the surface of its own column, and gets no skylight\nthere, is not drawn. A ravine keeps its walls: its air has skylight. 0 turns it off. URL: ?buried=',
        get: () => S.buried,
        set: (v) => { S.buried = Math.min(64, Math.max(0, v | 0)); applySettings('light'); } },

      { key: 'daylight', label: 'daylight', min: 0, max: 1, step: 0.05, live: false,
        fmt: (v) => v < 0.02 ? 'torches only' : `${Math.round(v * 100)}%`,
        hint: 'How much of the sky channel counts. Lower it to read torch/cave light on the surface\nwithout the daylight flattening it. Block light is always full. URL: ?skyscale=',
        get: () => S.skyScale,
        set: (v) => { S.skyScale = Math.min(1, Math.max(0, v)); applySettings('light'); } },

      { key: 'meshcache', label: 'keep meshes when zoomed out', min: 0, max: 2048, step: 64, live: false,
        fmt: (v) => (v ? `${v | 0} MB` : 'off, re-mesh instead'),
        hint: 'Zooming out throws a chunk\'s triangles away, and zooming back in used to rebuild them\nat ~51 ms a chunk - the hitch when you come back. This keeps the vertex bytes of the\nchunks you left behind (the payload ring already keeps their voxels), so returning is a\nGPU upload. RAM, not disk: 256 MB is about 350 chunks. 0 disables it. URL: ?meshcache=',
        get: () => S.meshCacheMb,
        set: (v) => { S.meshCacheMb = Math.max(0, v); trimMeshBytes(); } },

      { key: 'aofar', label: 'far brightness match', min: 0.6, max: 1.1, step: 0.01, live: false,
        fmt: (v) => v.toFixed(3),
        hint: 'How much darker the far terrain is painted, to match the close-up pass: that\npass darkens corners with ambient occlusion and the far layer has no corners to darken.\n0.949 is that pass\'s measured mean over 2.7 M sampled vertices (tools/dbg-aohist.mjs). Raise it\nif far ground reads paler than near ground, lower it if it reads darker. URL: ?aofar=',
        get: () => S.aoFar, set: (v) => { S.aoFar = v; applySettings('aofar'); } },

      { key: 'clarity', label: 'water clarity', min: 0, max: 0.8, step: 0.02,
        fmt: (v) => `${Math.round(v * 100)}%`,
        hint: 'How much you can see through water and ice. URL: ?water',
        get: () => 1 - S.water, set: (v) => { S.water = 1 - v; applySettings('water'); } },

      { key: 'shellon', label: 'draw far terrain', kind: 'check', live: false,
        hint: 'Off shows only the close detail ring - useful for seeing what the far pass is doing. URL: ?noshell',
        get: () => S.shellOn, set: (v) => { S.shellOn = v; applySettings('shellOn'); } },

      { key: 'invert', label: 'invert orbit drag', kind: 'check',
        hint: 'Off (default) is mouse-look: drag right and the view turns right. On grabs the world and\nspins it with the cursor, like right-drag pan. URL: ?invert',
        get: () => S.invert, set: (v) => { S.invert = v; } },

      { kind: 'section', key: 'adv', label: 'advanced (how the renderer works)', open: false,
        hint: 'How the far terrain is decimated, batched and meshed. Nothing here is needed to look at\nthe world; the URL name of each control is in its tooltip.' },

      { key: 'maxradius', label: 'detail skin radius', min: 8, max: 160, step: 8, live: false,
        fmt: (v) => `${v * CH} m`,
        hint: 'Radius of the per-chunk heightmap skin. Beyond it the whole-world overview takes over, so\nthis only changes how much of the near-ish world is at full column resolution. URL: ?maxradius',
        get: () => S.skinCap, set: (v) => { S.skinCap = clampInt(v, 8, 160); applySettings('skin'); } },

      { key: 'overview', label: 'world layer', kind: 'check',
        hint: 'One request that paints the whole dimension as a coarse heightmap - what you see when zoomed\nfar out, without streaming 37 000 chunk shells. Needs `node server/bake-shells.mjs`.\nURL: ?nooverview',
        get: () => S.overview,
        set: (v) => { S.overview = v; recomputeZoom(); ovGroup.visible = S.shellOn && v; if (!v) clearOverview(); else loadOverview(currentDim()); } },
      { key: 'ovstep', label: 'world layer cliff step', min: 0, max: 32, step: 1,
        fmt: (v) => (v ? `${v} m` : 'every step'),
        hint: 'Height difference before the coarse layer draws a cliff wall; 0 draws every one. URL: ?ovstep',
        get: () => S.ovStep, set: (v) => { S.ovStep = Math.max(0, v | 0); } },

      { key: 'fog', label: 'fog', min: 0, max: 3, step: 0.05,
        fmt: (v) => (v ? `${Math.round(fogFor(rig.dist, skinR, { scale: v }).far)} m` : 'off'),
        hint: 'How fast distance fades into the sky colour; 0 is no fog. URL: ?fog',
        get: () => S.fog, set: (v) => { S.fog = Math.max(0, v); applySettings('fog'); } },

      { key: 'minradius', label: 'far view floor', min: 4, max: 128, step: 4, live: false,
        fmt: (v) => `${v * CH} m`, hint: 'Far view kept even when zoomed right in. URL: ?minradius',
        get: () => S.skinFloor, set: (v) => { S.skinFloor = Math.max(4, v | 0); applySettings('skin'); } },
      { key: 'cellmax', label: 'coarsest far grid', min: 0, max: 4, step: 1, live: false,
        fmt: (v) => `${CELLS16[v]} blk`,
        hint: 'Ceiling on how coarse the far grid may get, however small it is on screen. URL: ?cellmax',
        get: () => CELLS16.indexOf(S.cellMax), set: (v) => { S.cellMax = CELLS16[v]; applySettings('lod'); } },
      { key: 'vertbudget', label: 'far terrain verts', min: 500000, max: 40000000, step: 500000, live: false,
        fmt: (v) => `${(v / 1e6).toFixed(1)} M`,
        hint: 'How much heightmap terrain the page may hold, in vertices - memory, not taste. Over\nthis, the far grid merges more (and its cliff walls shrink) until it fits. URL: ?vertbudget',
        get: () => S.vertBudget,
        set: (v) => { S.vertBudget = Math.max(200000, v | 0); applySettings('lod'); } },
      { key: 'colbudget', label: 'far grid columns', min: 50000, max: 2000000, step: 50000, live: false,
        fmt: (v) => `${(v / 1e6).toFixed(2)} M`,
        hint: 'How many heightmap columns the far terrain may hold. This, not distance, decides how\nfar away the grid starts merging. URL: ?colbudget',
        get: () => S.cellBudget, set: (v) => { S.cellBudget = Math.max(20000, v | 0); applySettings('lod'); } },
      { key: 'patch', label: 'batch size', min: 1, max: 32, step: 1, live: false,
        hint: 'Chunks per far-terrain batch; one batch is one draw call. URL: ?patch',
        get: () => S.patch, set: (v) => { S.patch = Math.max(1, v | 0); applySettings('patch'); } },
      { key: 'skirt', label: 'cliff wall height', min: 0, max: 96, step: 4, live: false,
        hint: 'How far down the side of a cliff is drawn in the far view, in blocks. 0 shows cliff tops\nonly, which reads as floating terrain from the side. URL: ?skirt',
        get: () => S.skirt, set: (v) => { S.skirt = Math.max(0, v | 0); applySettings('skirt'); } },
      { key: 'blend', label: 'far colour blending', min: 0, max: 1, step: 0.05, live: false,
        hint: 'How much a coarse far cell borrows the colour around it. Too high and a stone field next\nto a forest turns green. URL: ?blend',
        get: () => S.blend, set: (v) => { S.blend = Math.min(1, Math.max(0, v)); applySettings('blend'); } },
      { key: 'mipmax', label: 'texture blur limit', min: 0, max: 10, step: 1, live: false,
        hint: 'How deep the texture mip chain goes. Deep levels average neighbouring sprites together\nand read as grey mush, which is why this is capped. URL: ?mipmax',
        get: () => S.mipmax, set: (v) => { S.mipmax = v; if (atlasTex) mipCap = capAtlasMipLevel(atlasTex, v); } },
      { key: 'alphatest', label: 'leaf cutout', min: 0, max: 1, step: 0.01,
        hint: 'How much of a leaf/grass sprite has to be solid to be drawn. URL: ?alphatest',
        get: () => S.alphaTest, set: (v) => { S.alphaTest = v; applySettings('alphaTest'); } },
      { key: 'aoon', label: 'corner shadows', kind: 'check', live: false,
        hint: 'On/off for the whole ambient-occlusion pass. URL: ?noao',
        get: () => S.ao, set: (v) => { S.ao = v; applySettings('ao'); } },
      { key: 'lighton', label: 'light from the save', kind: 'check', live: false,
        hint: 'Sky and block light decoded from the chunk data. Off is the old flat shading, kept for\ncomparison. URL: ?nolight',
        get: () => !!S.light, set: (v) => { S.light = !!v; applySettings('light'); } },
      { key: 'shelltex', label: 'texture far terrain', kind: 'check', live: false,
        hint: 'Off by default: at far distances the texture of a block is squeezed under a single screen pixel, which rings and reads as noise. auto textures a patch once its cells are texpx across, ?shelltex=2 always, ?texpx= sets the crossover.',
        get: () => !!S.shellTex, set: (v) => { S.shellTex = v ? 1 : 0; applySettings('shelltex'); } },
      { key: 'texpx', label: 'far paint switches at', min: 0, max: 6, step: 0.2, live: false,
        fmt: (v) => `${v.toFixed(1)} px`,
        hint: 'How many pixels across a far quad has to be before it is worth drawing the real sprite\ninstead of a flat plate of its mean colour. Under a pixel a sprite samples one texel and reads as\nflickering noise, which is why the far horizon stays flat. URL: ?texpx',
        get: () => S.texPx, set: (v) => { S.texPx = Math.max(0, v); applySettings('texpx'); } },
      { key: 'budget', label: 'meshing ms per frame', min: 0, max: 40, step: 1,
        hint: 'Time per frame spent building close-up chunk meshes. Higher loads faster but hitches. URL: ?budget',
        get: () => S.budget, set: (v) => { S.budget = v; } },
      { key: 'sbudget', label: 'far meshing ms per frame', min: 0, max: 60, step: 1,
        hint: 'Same, for far-terrain batches. URL: ?sbudget',
        get: () => S.shellBudget, set: (v) => { S.shellBudget = v; } },
      { key: 'shellQuiesce', label: 'far redraw wait (ms)', min: 0, max: 1000, step: 50, live: false,
        hint: 'How long a block of far terrain waits after new ground arrives under it before it is drawn again. Short fills in sooner but redraws the same area many times while a load is still arriving. URL: ?quiesce',
        get: () => S.shellQuiesce, set: (v) => { S.shellQuiesce = Math.max(0, v); } },
      { key: 'res', label: 'draw resolution', min: 0.4, max: 1, step: 0.05, live: true,
        hint: 'How many pixels are drawn, as a fraction of the screen. Below 1 the image is rendered smaller\nand stretched, which is the cheapest way to gain frame rate. Auto mode only lowers it when the GPU\nitself is the limit and the terrain is fully loaded. URL: ?res=0.75 ?noautores',
        get: () => S.res,
        set: (v) => { S.res = Math.max(0.4, Math.min(2, v)); resAuto = 1; applyRes(); } },
      { key: 'resAuto', label: 'auto resolution', min: 0, max: 1, step: 1, live: true,
        labels: ['manual', 'auto'],
        hint: 'Shrink the drawn resolution only when the graphics card is the limit, the view is fully\nloaded, and the frame is still slower than the target. Needs a browser that reports GPU time. URL: ?noautores',
        get: () => S.resAuto, set: (v) => { S.resAuto = v | 0; applyRes(); } },
      { key: 'targetFps', label: 'target frame rate', min: 20, max: 120, step: 5, live: true,
        hint: 'What auto resolution aims at. URL: ?targetfps',
        get: () => S.targetFps, set: (v) => { S.targetFps = Math.max(20, Math.min(120, v | 0)); } },
      { key: 'workers', label: 'meshing threads', min: 0, max: 8, step: 1, live: false,
        hint: 'Background threads that build chunk meshes. Changing this restarts them (a moment of stutter).\n0 meshes on the render thread instead. URL: ?workers',
        get: () => workerCount(),
        set: (v) => { S.workers = Math.max(0, Math.min(8, v | 0)); resetWorkers(); } },
    ],
    actions: [
      { label: 'see the whole world', hint: 'pull back until the entire loaded extent fits the frame',
        run: () => { rig.pitch = 0.72; rig.dist = S.maxZoom; updateView(); requestAround(); } },
      { label: 'fit world', hint: 'zoom out to the whole loaded extent (f)', run: () => fitWorld() },
      { label: 'spawn', hint: 'back to the world spawn (r)',
        run: () => { rig.target.set(SPAWN[0], SPAWN[1], SPAWN[2]); rig.dist = 40; } },
    ],
  });
}

// ---- boot ------------------------------------------------------------------
(async () => {
  try {
    meta = await fetch('/meta').then((r) => r.json());
    if (meta.level?.spawn) SPAWN = meta.level.spawn;
    hud.dim.innerHTML = (meta.dims ?? [])
      .map((d) => `<option value="${d.id}">${dimLabel(d.id)}</option>`).join('');
    const want = params.get('dim') || 'minecraft:overworld';
    hud.dim.value = (meta.dims ?? []).some((d) => d.id === want) ? want : meta.dims[0].id;
    // How big is this dimension, in blocks? That is the only honest ceiling for "zoom all the way
    // out": past the loaded extent there is nothing to paint, whatever the far plane says.
    S.worldSpan = dimSpanBlocks(currentDim());
    recomputeZoom();
    rig.target.set(SPAWN[0], SPAWN[1], SPAWN[2]);
    applyGoto();

    await loadAssets();
    // Spinning the workers up costs one atlas-JSON parse each (~50 ms), which is free next to the
    // first chunk mesh; do it before any chunk is requested so no frame pays for it later.
    startWorkers();
    // Baked far tiles replace the whole-dimension overview, so do not spend 16 MB and a second of
    // meshing on a layer nothing will see. ?ov=1 asks for both.
    lodAvail = (meta.packed?.lod?.tiles ?? 0) > 0;
    if (lodAvail && S.lod && !params.has('ov')) S.overview = 0;
    // The world-layer request goes out before any chunk does: it is one request for the whole
    // dimension and it is what the screen shows while everything else streams in.
    if (S.overview) loadOverview(hud.dim.value);
    if (params.get('view') === 'flat') buildFlatView();
    store = new ChunkStore(currentDim(), storeOpts());
    applyDetailBudget();
    resize();
    if (S.shellOn && params.get('view') !== 'flat') makeShellStore(hud.dim.value);
    if (S.lod && S.shellOn && lodAvail && params.get('view') !== 'flat') {
      makeLodStore(hud.dim.value);
      lodIndexLoad(lodStore);
      // The zoom ceiling only opens up to the world once a coarse whole-dimension layer exists, so
      // it has to be recomputed after the store exists - boot computed it before this line.
      recomputeZoom();
    }
    rig.dist = Math.min(rig.dist, S.maxZoom);
    updateView();
    requestAround();
    buildPanel();
    requestAnimationFrame(frame);
    hud.msg.textContent = `${assets.states.length} block states, ${assets.textures.length} textures` +
      (shellStore ? ` / far terrain to ${S.skinCap * CH} m (grid ${tiers().join('/')})`
        : ' / far terrain off') +
      ` / zoom out to ${Math.round(S.maxZoom)} m - p opens settings, f fits the world`;
    hud.dim.addEventListener('change', () => switchDim(hud.dim.value));
  } catch (e) {
    bootError = e;
    hud.msg.textContent = `startup failed: ${e.message}`;
    hud.msg.classList.add('err');
    console.error(e);
  }
})();
