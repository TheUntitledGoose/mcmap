// Renderer bootstrap: three.js scene, camera rig, chunk streaming, per-chunk meshes.
// The asset/payload/mesher layers are DOM-free and unit-tested under tests/; this file is kept
// thin on purpose, so a visual bug is usually a scene-graph bug rather than a data bug.
import * as THREE from '/vendor/three.module.js';
import { Assets } from './assets.js';
import { meshChunk, tintOf, FACE_SHADE, NEIGH_COVERED } from './mesher.js';
import { ChunkStore } from './store.js';
import { ShellStore } from './shell-store.js';
import { LodStore } from './lod-store.js';
import { pickLodRung, LOD_CELL } from '../../shared/lod-format.mjs';
import { openOverview, withAccessors } from './payload.js';
import { applyEdits, editsForCell, histStamp, rowsByCell, scanFromCentre, stateIdsByName } from './ledger-terrain.mjs';
import { sectionIndex, idToState, voxelId } from './lookup.js';
import { meshShellPatch, meshOverview } from './shell-mesh.js';
import { PATCH_REACH, packPatchFrames, packPatchPolicy, patchFrameGetter, patchPolicy } from './shell-batch.js';
import { cutReserve, patchThreadCap } from '../../shared/pool.mjs';
import { recordCut, cutPrice, decideCut, mayTakeThread } from '../../shared/cutpolicy.mjs';
import { meshKeyTool } from './mesh-key.js';
import { parkPasses, indexedMatch } from './mesh-bytes.js';
import { mountPanel } from './ui.js';
import { HEIGHT_BIAS } from '../../shared/chunk-format.mjs';
import { layerAlpha, stackOver, over, dmax } from '../../shared/composite.mjs';
import { CH, maxZoomFor, cornerTan, zoomCeiling, frustumFor, groundReach, skinRadius, fogFor,
  closestApproach, cellForPixels, budgetCell, detailRadius, detailReach, faceFactor, tierDistance,
  pickEvictions, aaDefault } from '../../shared/view.mjs';
// M11 first-person rig. The arithmetic (keys, mouse-look, the wheel, standing on the ground) lives in
// shared/walk.mjs next to the other view policies, so the tests cover it without a browser. M14 puts a
// real body under it: gravity, jumping, collision with the voxels, in shared/player.mjs.
import { EYE_DIST, PITCH_LIMIT, look as walkLook, wish as walkWish, rising as walkUp,
  descending as walkDown, sprinting as walkSprintKey, wheelReach, walkWant } from '../../shared/walk.mjs';
import { BODY, C_FULL, C_PASS, C_UNKNOWN, FALL_MAX, FLY_V, SPRINT, WALK, dropToClear, newPlayer, place as placePlayer,
  simulate as simulatePlayer, floorTop as playerFloorTop, hits as playerHits } from '../../shared/player.mjs';
import { makeCellAt } from './collision.js';
import { fromWire, makeReader } from '../../shared/regionbits.mjs';
// M12: the block-history overlay - "who placed this, and can I find it". The log holds 424,599 rows
// for a 3.6 GB world, and only 20,322 of the overworld's 284,239 chunks were ever touched, so the page
// gets a sparse table (34 B per touched chunk, 691 KB for the whole overworld) and asks for one chunk's
// rows at a time. What the log *means* - the filter, the heat scale, the geometry, the wording of an
// evidence line - is decided in web/js/ledger-view.mjs, which is tested without a browser; this page
// only turns those numbers into a mesh, a card and two buttons.
import {
  buildHeatQuads, buildPins, collectCells, formatTime as fmtLedger, LEDGER_CLASSES, nearRows, rankCells,
  rowLine, summarizeRows, timeAgo,
} from './ledger-view.mjs';
import { decodeTimeline, readPack, tlPackCoord } from '../../shared/ledger-pack.mjs';
// M12b: the time machine's data half - filters, decal geometry and the playhead index, all of it
// testable without a browser (tests/web-timemachine.test.mjs). This page owns the mesh and the
// scrubber; the numbers in the readouts come from the tested functions.
import { actionName, buildTimeQuads, filterRows, playhead, quadAt, rowForBlock, voxelKey, voxelRows } from './ledger-time.mjs';
import { buildTimeBlocks, markerOfIndex, resetMarkerLift } from './ledger-blocks.mjs';


const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const num = (name, def) => {
  const v = params.get(name);
  return v === null || v === '' || !Number.isFinite(+v) ? def : +v;   // +null is 0, so test first
};
/** A word parameter, checked against the values that are actually implemented. A typo in ?timelook=
 *  must not silently become the default look, because then the picture and the panel disagree. */
const word = (name, def, allowed) => {
  const v = (params.get(name) ?? '').trim().toLowerCase();
  if (!v) return def;
  if (!allowed.includes(v)) {
    console.warn(`?${name}=${v} is not one of ${allowed.join('/')}; using ${def}`);
    return def;
  }
  return v;
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
  radius: Math.max(0, num('radius', 8)),         // detail (voxel) ring ceiling, in chunks
  // 5 was too small to see: at a 257 m orbit that is an 80 m sharp patch in a 1200 m view, which is
  // what the "sliver of detail surrounded by LOD" complaint is. 8 chunks = 128 m of block-by-block
  // ground, ~290 chunk meshes, ~4 M verts. The panel row goes to 24 for people with the GPU for it.
  detailPx: num('detailpx', 1),            // a 1-block column must cover this many px to earn triangles
  detailLod: !params.has('nodetaillod'),   // off = the old behaviour: full res whatever the zoom
  // Should the sharp ring shrink when the zoom makes its one-block columns sub-pixel? ON by default.
  // Priced at a 1 200 m orbit (radius 8, `build/q_pancount.js`): the sharp ring is 361 chunks,
  // 5.19 M verts and 727 chunk meshes per pan - 19 s of worker CPU, 3 s of settling, 57 fps after
  // the pan. Pixel-limited it is 0 chunks, 9.4 M verts, 102 meshes, 2.7 s, 1 s, 240 fps - and
  // 2.7 % of the pixels change (`build/shot_dp_off.png` / `shot_dp_on.png`). The limit is not a
  // distance: it is "a one-block column must cover a pixel", so at this window the sharp ring
  // reaches 739 m out and nothing changes closer in than that. URL: ?detailpixels=0 / ?nodetailpixels
  detailPixels: params.has('nodetailpixels') ? 0 : (num('detailpixels', 1) ? 1 : 0),
  payloadLead: num('payloadlead', 6),
  // Re-mark the sharp ring when the view centre moves (URL: ?noringscan). A pan slides the
  // ring over payloads that were pre-fetched and already dropped from the mesh queue.
  ringScan: params.has('noringscan') ? 0 : (num('ringscan', 1) ? 1 : 0),
  // payloadLead keeps voxel payload warm beyond the mesh ring. Those payloads are marked dirty on
  // arrival and the mesh queue drops the ones that are out of ring - which is why a centre change
  // has to re-mark the ring (ringScan, just above).
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
  // A far patch whose cut does not fit the frame is left marked, and this is how long it may wait
  // before the render thread cuts it anyway (`shared/cutpolicy.mjs`). It has to be finite: a patch
  // with no mesh is a hole in the ground, and a patch that stays dirty means the pan never settles.
  patchStarve: num('starvems', 400),
  // A cut above this cost may take a worker thread even when the cap on far cuts is already full
  // (`mayTakeThread` in shared/cutpolicy.mjs). Refusing it does not free a thread - a thread was idle -
  // it only moves a 30-50 ms mesh onto the render thread. 20 ms sits between the cell-2 cut (14 ms,
  // fine inline) and the cell-1 cut (33 ms, not). `?stealms=0` is the A/B: never take a reserved thread.
  patchStealMs: num('stealms', 20),
  // Price a far cut by its own cell, or by the average of all cuts (the pre-9.9 rule). `?cutavg=1`
  // is the A/B; the average rule is what let a 47 ms cell-1 patch start 1 ms into a 10 ms frame.
  cutCellPrice: !params.has('cutavg'),
  // Demotion is a *time* budget as well as a headcount. Demoting one chunk means slicing three
  // attribute arrays into the park and deleting up to three GPU buffers; 64 of them measured 45 ms
  // in a single frame in the middle of a pan, which is a stutter you can see and hear.
  demoteBudget: num('demotems', 6),
  // Render scale, as a multiple of the capped device pixel ratio. Fewer pixels is the one remedy
  // that helps no matter which stage of the pipeline is slow. URL: ?res=0.75
  res: Math.max(0.4, Math.min(2, num('res', 1))),
  // Multisample edge smoothing. There is no post pass in this viewer, so MSAA is the only thing
  // that softens the edge of a quad, and at whole-world framing almost every edge is a fraction of
  // a pixel. It is chosen when the GL context is made, so it is a URL switch rather than a slider:
  // ?noaa forces off, ?aa=1 forces on. Measured on a real GPU at 1280x720 (9.7): at
  // 9.4 M verts it costs 0.5 ms of a 2.6 ms GPU frame and the frame rate does not move; at 31.8 M
  // verts it costs nothing at all (11.5 ms with, 12.8 ms without); at 4x the pixels it costs a
  // third of the frame (157 fps with, 238 without). So it is asked for on every screen and left
  // to auto resolution to buy the pixels back on a 2x one, rather than deciding the picture is
  // already sharp enough on the viewer's behalf.
  aa: aaDefault({
    aa: params.has('aa') ? num('aa', 1) : undefined,
    noAA: params.has('noaa'),
  }),
  // Auto resolution: only while the GPU timer is available and the view is fully loaded.
  resAuto: params.has('noautores') ? 0 : 1,
  targetFps: Math.max(20, Math.min(120, num('targetfps', 60))),
  // How long a block of far terrain waits after new ground arrives under it before it is drawn again.
  shellQuiesce: Math.max(0, num('quiesce', 250)),
  workers: num('workers', -1),
  patchWorkers: Math.max(0, Math.min(6, num('patchworkers', 6))),
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
  // The same question without the light probe: is there opaque rock over the air a face looks into?
  // If yes it is not on the surface, so it is not meshed at all. OFF by default: it is cheaper
  // (measured over 24 sampled chunks with tools/dbg-surfacecost.mjs: 16,184 verts and 25.9 ms per
  // chunk with the underground, 13,659 verts and 19.9 ms as a skin, -16 % / -23 %), but the saving
  // is much smaller than the dark + buried rules already get, and what it gives back is the top of
  // every cave under a thin lid - the mine entrances and the shallow galleries that make the world
  // read as dug-out. `buried`/`buriedSky` keeps the deep dark instead; this takes the caves.
  // ?surface=1 asks for the skin. URL: ?surface=
  surface: params.has('nosurface') ? 0 : (num('surface', 0) ? 1 : 0),

  // ---- M12: the ledger (block history) --------------------------------------------------------
  // Off at boot: the overlay paints one decal per chunk the log touched, which is an answer to a
  // question you only ask on purpose. URL: ?ledger=1, ?ledgercls=2 (place), ?ledgerwho=4 (a player id),
  // ?ledgermin=20, ?noledgerxray, ?ledgerrows=, ?ledgerblockr=
  ledger: params.has('ledger') ? (num('ledger', 1) ? 1 : 0) : 0,
  ledgerCls: Math.max(0, Math.min(6, num('ledgercls', 0))),   // 0 = every kind of action summed
  ledgerWho: Math.max(0, num('ledgerwho', 0)),                // 0 = anybody, fire/water/monsters included
  ledgerMin: Math.max(1, num('ledgermin', 1)),                // hide chunks under this many actions
  // A decal on the ground is hidden by the hill in front of it, which is honest and useless at the same
  // time. Default draws through the world (it is an overlay, not terrain); ?noledgerxray puts it back on
  // the ground so you can see what the overlay looks like where you actually are.
  ledgerXray: params.has('noledgerxray') ? 0 : (num('ledgerxray', 1) ? 1 : 0),
  // One click asks about one chunk: how many of its rows to fetch, and how wide "this block" is.
  // 1 block of radius covers the block and its six face neighbours, which is what you meant when you
  // clicked the lid of a chest rather than its body.
  ledgerRows: Math.max(10, Math.min(2000, num('ledgerrows', 200))),
  ledgerNear: Math.max(0, Math.min(4, num('ledgerblockr', 1))),
  // M12b: the time machine. `timeAt` is a MOMENT - seconds since this dimension's first logged row -
  // not a percentage, so a URL can point at a date and a probe can ask for one. The panel slider
  // speaks in permille of the current filter and converts.
  time: num('time', 0) ? 1 : 0,
  timeAt: Math.max(0, num('timeat', 0)),
  timePlay: num('timeplay', 0) ? 1 : 0,
  // Whether anyone ASKED for a play state. Arming the time machine plays by default (see timeRebuild);
  // a URL that says ?timeplay=0, or a hand on the play row, is an answer to that and is never overruled.
  playTouched: params.has('timeplay') ? 1 : 0,
  timeSpeed: Math.max(0.05, Math.min(5e6, num('timespeed', 20000))),  // LOGGED CHANGES per wall-clock second
  // Not days per second. This dimension logged changes on 9 of the 822 days its log spans, with 99 % of
  // its rows inside the first week and 83,101 of them on one day. A calendar-driven playhead would sit
  // motionless for a month and then blur; an event-driven one builds at a rate the eye can read.
  timeCls: Math.max(0, Math.min(7, num('timecls', 2))),             // 0 = any change, 2 = block place
  timeLimit: Math.max(0, num('timelimit', 0)),                      // 0 = draw every row of the filter
  // Undoing the log in the voxels defaults ON whenever the time machine does, because the two answer one
  // question and a viewer who turns on "watch it get built" and sees only dots move has been let believe
  // the blocks do not change. `?timeterrain=0` says otherwise, and that choice is respected for the session
  // (S.timeTouched) so pressing M never quietly re-arms a cost the player just turned off.
  timeTerrain: num('timeterrain', num('time', 0) ? 1 : 0) ? 1 : 0,  // undo the log in the VOXELS too
  timeTouched: params.has('timeterrain') ? 1 : 0,
  timeTerrainStep: Math.max(1, num('timeterrainstep', 64)),         // rows the playhead may jump before the terrain re-syncs
  timeTerrainLimit: Math.max(0, num('timeterrainlimit', 4096)),     // voxels one chunk may rewrite; 0 = all
  timeTerrainMax: Math.max(1, num('timeterrainmax', 192)),          // chunks re-cut per playhead sync
  timeTiles: num('timetiles', 1) ? 1 : 0,                           // the per-change markers; the playhead works without them
  // M12b tier 3: what a logged change LOOKS like, and the ceiling that decides whether it can afford to.
  // Measured over the whole overworld filter (build/dbg-ghostcost.mjs, real atlas, real timeline):
  //   90,045 place rows  = 553,726 quads / 66 MB as the block's own model, 117,651 quads / 14 MB as a
  //                        textured top face, 90,045 quads / 11 MB as a flat coloured tile
  //   351,531 any-change = 2.94M quads / 352 MB as blocks, 1.65M quads / 198 MB as plates
  // so blocks are tried first and the look steps DOWN when it would not fit timeGeomMb, in the panel's
  // line of sight rather than silently. URL: ?timelook=plates, ?timegeommb=256
  timeLook: word('timelook', 'blocks', ['blocks', 'plates', 'tiles']),
  timeGeomMb: Math.max(2, Math.min(2048, num('timegeommb', 128))),
  // A line around the voxel under the cursor. Cheap by policy, not by luck: one reusable 24-vertex box
  // and one raycast at `hoverMs` intervals, because a highlight that allocates a mesh per hover is a
  // hitch per hover. URL: ?nohover, ?hoverms=60
  hover: num('hover', 1) ? 1 : 0,
  hoverMs: Math.max(16, Math.min(1000, num('hoverms', 90))),
  decalOp: Math.max(0, Math.min(1, num('decalop', 0.45))),           // how solid BOTH ledger overlays are
  decalShrink: Math.max(0.2, Math.min(1, num('decalshrink', 0.82))), // a tile as a fraction of what it covers
  // The settings panel's own width in CSS pixels, because a panel that hides its own numbers behind
  // an ellipsis is a bug you can now resize: drag the panel's left edge, or set this. The value
  // column is what needs the room - the time machine prints a date stamp there. URL: ?panelw=440
  panelW: Math.max(360, Math.min(760, num('panelw', 396))),
  // 9.6's two rules together, for A/B: skip a mesh whose payload and known border already answer it,
  // and hold a chunk while a neighbour is still in flight. 0 = mesh on every dirty mark (?meshkey=0).
  meshKey: num('meshkey', 1) ? 1 : 0,
  bytesKeep: num('byteskeep', 1) ? 1 : 0,          // keep parked triangles across a payload eviction
  meshIndex: params.has('soup') ? 0 : 1,           // 9.5a: indexed detail meshes; ?soup=1 = the old soup
  // Leave the old triangles on screen while a re-cut is in flight. A single time-machine move marks up to
  // 192 chunks, and dropping each one when its job is POSTED showed the world flicker to the far layer for
  // a whole worker round trip. ?keepmesh=0 restores that flicker for an A/B of the flicker, not of the
  // geometry: the triangles that land are the same either way.
  keepMesh: num('keepmesh', 1) ? 1 : 0,
  // Which region files this save has, fetched once per dimension from /regions (637 bytes for the
  // overworld), so the store never asks for a tile of ground this world never had. Over the bounding
  // box that is 75 % of the map, and a camera parked over void used to spend its whole queue on it.
  // ?nocov=1 turns the answer off again for an A/B of request volume.
  groundCov: params.has('nocov') ? 0 : 1,
  groundTtlMs: Math.max(5000, num('groundttl', 120000)),  // how long one "no ground here" is believed
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
  lodMax: Math.max(16, num('lodmax', 640)),        // tiles held (the overworld is 327 coarse, 3 298 fine)
  // A baked column has to be worth the triangle it is made of. This is how wide one column of a rung
  // has to measure, in device pixels, before that rung is asked for: 3 px means a 4-block rung is used
  // out to where a column is three pixels wide, and beyond that the 16-block rung paints the same hill
  // for a thirteenth of the geometry. ?lodcellpx=0 asks for the coarse rung everywhere (the old build).
  lodCellPx: Math.max(0, num('lodcellpx', 3)),
lodCellMaxPx: Math.max(1, num('lodcellmax', 8)),
  // The bill for the fine rung, in drawn vertices. The overworld is 2.4 M verts at cell 16 and 32 M at
  // cell 4, so a world-sized view cannot be given the fine rung everywhere; the budget is spent
  // nearest-first, which is what keeps the middle of the frame sharp and the horizon cheap.
  lodVerts: Math.max(1e5, num('lodverts', 9e6)),
  // The skin at the surface, drawn where the skin stands. Off puts the old flat cell back: one height
  // per column, extruded to the neighbours, which is what made a distant tree a solid brown tower.
  caps: params.has('nocaps') ? 0 : (num('caps', 1) ? 1 : 0),
  capDrop: Math.max(1, Math.min(255, num('capdrop', 4))),
  // A cap is a box `cell` blocks wide, so it stops reading as a canopy once the cell is wider than the
  // skin it draws: a 16-block cap over a forest is a plateau with a lid. Caps therefore stop at this cell
  // size, and the cell goes back to standing on its ground with the canopy surviving as colour.
  capCell: Math.max(1, Math.min(255, num('capcell', 4))),
  // How far the far world is allowed to drop in quality, in blocks per column. 100 = as coarse as it
  // likes (today's behaviour, 16-block columns at the horizon). Pull it to 50 and nothing coarser than
  // 8-block columns is ever accepted *where a coarse column would actually be a visible blob*, so a
  // distant hillside stops being a few big slabs; at 25 nothing coarser than 4. Ask for finer than the
  // baked rungs go and the baked layer keeps painting that ground at its own rung rather than leaving a
  // hole, while the live far grid draws it finer - correctly but far more expensively, which is the
  // honest price of refusing to blur and the reason the slider exists rather than a fixed policy.
  // Measured at a 1.2 km view: 100 -> 3.8 M baked verts / 6.4 fps, 50 -> 6.4 M / 6.1 fps (refusing the
  // coarse rung unconditionally cost 23.8 M verts and 3 fps), 25 -> 4.0 M live verts / 5.6 fps,
  // 0 -> 10.2 M live verts / 3.6 fps. Only the live grid still pays for the floor at the horizon.
  lodQuality: Math.max(0, Math.min(100, num('lodquality', 100))),
  lodMaxCell: (() => {
    const q = Math.max(0, Math.min(100, num('lodquality', 100)));
    return [1, 1, 2, 2, 4, 4, 8, 8, 16, 16, 16][Math.round(q / 10)];
  })(),
  // Vertex bytes kept when a chunk leaves the detail ring, so zooming back in is an upload, not a
  // re-mesh. 256 MB is ~350 chunks. 0 turns the reuse off (every return re-meshes from voxels).
  meshCacheMb: Math.max(0, num('meshcache', 256)),
  // What decides how coarse a patch of far terrain gets: how close the orbiting eye can get to it
  // (`approach`, the old rule) or how far it sits from the middle of the view (`center`, the default).
  // The old rule is a function of the zoom, so pulling back pushed the ground under the crosshair into
  // the coarse tier as well: at a 4 km pull-back the chunk in the middle of the frame went to
  // 16-block plates, and the gesture unloaded and reloaded the whole skin on the way. A sharp island
  // in a coarse field is what people want when they look for a building, and it costs the same total
  // vertices because the budget controller still decides how far the fine region reaches.
  // URL: ?lodanchor=approach
  lodAnchor: params.get('lodanchor') === 'approach' ? 'approach' : 'center',
  // The far layers are a height field: a top quad and skirt walls, no bottom cap. Seen from below - in
  // a cave, under an overhang, orbiting under the plateau - the back of that plate is culled, so you
  // look straight through the ground at the sky. Painting the backs costs fill only, no geometry.
  // URL: ?noflatback
  flatBack: params.has('noflatback') ? 0 : (num('flatback', 1) ? 1 : 0),
  // Baked tiles are clipped out of the square the live grid and the detail ring own (see
  // lodMatFor). ?nolodclip leaves them drawn everywhere, which is how the coarse layer
  // looked before, cliffs and all.
  lodClip: params.has('nolodclip') ? 0 : (num('lodclip', 1) ? 1 : 0),
  // Re-cut a coarse patch when a full-resolution chunk lands inside it. Off only to A/B the plate that
  // this exists to remove. URL: ?nopatchdetail
  patchDetail: params.has('nopatchdetail') ? 0 : (num('patchdetail', 1) ? 1 : 0),
  invert: params.has('invert'),       // orbit drag direction: mouse-look (default) vs grab-the-world
  // ---- M11/M14: walking (first person), with a body that has weight ----------------------------
  // Same rig, distance driven to about zero, so the orbit target becomes the eye, and the wheel stops
  // meaning zoom and starts meaning how far ahead of the eye the world stays drawn. What stands on the
  // ground is a 0.6 x 1.8 body with gravity and voxel collision (shared/player.mjs), not an eye that
  // hopes the floor is where the heightmap says it is.
  // URL: ?view=walk, ?view=fly (no gravity, no walls), ?reach=, ?wspeed=, ?wsprint=, ?gravity=,
  //      ?jump=, ?look=
  walk: /walk|fly|first|spect/i.test(params.get('view') ?? '') ? 1 : 0,
  walkFly: /fly|spect/i.test(params.get('view') ?? '') || params.has('noclip') ? 1 : 0,
  walkReach: clampInt(num('reach', 420), 96, 1600),   // blocks of world kept drawn ahead of the eye
  walkSpeed: Math.max(0.5, num('wspeed', 4.317)),     // blocks/s on foot: what a player walks in-game
  walkSprint: Math.max(1, num('wsprint', 1.3)),       // held Ctrl; in-game 5.613 / 4.317
  walkGravity: Math.max(0, num('gravity', 32)),       // blocks/s^2: the game's 0.08 blocks per tick^2
  walkJump: Math.max(0, num('jump', 8.4)),            // blocks/s upward: 1.25 blocks of clearance
  walkSneak: Math.max(0.2, num('wsneak', 1.3)),       // blocks/s with Shift: what you crawl at
  walkSens: Math.max(0.0004, num('look', 0.0025)),    // pointer-lock mouse-look, rad per pixel
  worldSpan: 0,        // blocks across the loaded part of this dimension, filled in at boot
  maxZoom: 1200,       // wheel ceiling, recomputed from worldSpan + skinCap
};
const hud = {
  fps: $('fps'), scale: $('scale'), verts: $('verts'), tris: $('tris'), chunks: $('chunks'), queue: $('queue'),
  cpu: $('cpu'),
  mesh: $('mesh'), shell: $('shell'), pos: $('campos'), dim: $('dim'), msg: $('msg'),
};
// What the page says unprompted is one number - frames per second - plus a status line when there
// is something to say. Everything else on screen is the world. The instrument block under the pill
// (verts, tris, mesh timings, worker counts, the frame-cost buckets) sits behind H, and is on by
// default only for ?debug=1 or the flat atlas view: every headless probe loads ?debug=1, so hiding
// it from a person looking at the map costs the tooling nothing. Same condition as DEBUG twelve
// lines down, spelled out because DEBUG does not exist yet when this has to run.
let readouts = 0, helpFade = 0;
function setReadouts(on) {
  readouts = on ? 1 : 0;
  document.body.classList.toggle('hidehud', !readouts);
  showHelp();
}
// The line of keys is not part of the instruments: a first visit needs it whether or not the
// numbers are up. It fades on its own once you have clearly started driving, and H brings it back.
// Two key lines, because the keys change: an orbit is dragged and zoomed, a walk is driven.
const HELP_ORBIT = '<b>drag</b> orbit &nbsp; <b>right-drag</b> pan &nbsp; <b>wheel</b> zoom &nbsp; <b>WASD</b> move'
  + ' &nbsp; <b>V</b> walk &nbsp; <b>P</b> settings &nbsp; <b>F</b> whole world &nbsp; <b>M</b> time machine'
  + ' &nbsp; <b>K</b> play &nbsp; <b>H</b> readouts';
const HELP_WALK = '<b>WASD</b> walk &nbsp; <b>Space</b> jump &nbsp; <b>Ctrl</b> sprint &nbsp; <b>Shift</b> sneak'
  + ' &nbsp; <b>click</b> look with the mouse &nbsp; <b>wheel</b> view depth &nbsp; <b>V</b> orbit again';
function setHelp(on) {
  const h = $('help');
  if (h) h.innerHTML = on ? HELP_WALK : HELP_ORBIT;
  showHelp();
}
function showHelp() {
  document.body.classList.remove('helpgone');
  clearTimeout(helpFade);
  helpFade = setTimeout(() => document.body.classList.add('helpgone'), 20000);
}
setReadouts(params.has('debug') || params.get('view') === 'flat' ? 1 : 0);

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
  canvas, antialias: S.aa === 1, preserveDrawingBuffer: DEBUG, powerPreference: 'high-performance',
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
// Every mesh this viewer builds is authored in world coordinates and never moved afterwards, so the
// per-frame matrix work is pure waste: three.js composes a local matrix and multiplies it into the
// world matrix for every object in the scene, and with the whole world in view that measured 2.1% of
// the page's CPU in updateMatrixWorld plus 1.4% in multiplyMatrices. Pin them instead: one compose when
// the mesh is built, nothing per frame. `?matrixlive=1` puts the per-frame recomputation back so the
// difference can be measured (and so a future feature that does move a mesh has a knob to find it).
const STATIC_MATRIX = !params.has('matrixlive');
const pinStatic = (o) => { o.matrixAutoUpdate = STATIC_MATRIX; o.updateMatrix(); return o; };
// The shell skin lives in its own node inside the opaque group, so the vert counter and the
// "far view" HUD row can see it without walking the detail meshes.
const shellGroup = new THREE.Group();
shellGroup.name = 'shell';
groups[0].add(shellGroup);

// ---- camera rig ------------------------------------------------------------
const rig = { target: new THREE.Vector3(0, 100, 0), yaw: 0.7, pitch: 0.42, dist: +(params.get('dist') ?? 40), keys: new Set() };

// ---- M11: the walking rig ---------------------------------------------------
// Not a second camera. `dist` goes to about zero, which makes the orbit target the eye, and every
// distance policy in shared/view.mjs - tier distance, sharp-ring reach, skin radius, the frustum -
// starts reading "from the eye" for free. What the mode has to supply instead is what to *ask for*:
// an orbit sizes the world from the frame's corners at the target, and with the target in the eye
// that square is a point, so a walker sizes it by view depth (`reach`) instead.
const walk = { on: 0, reach: 0, distWas: 40, fly: 0, frozenFrames: 0, landed: 0,
  embedded: 0, unstuck: 0, placed: 0 };
// The body. Feet position, velocity, and what the last physics step concluded; the eye is derived
// from it (`player.y + BODY.eye`), never the other way round, or standing on a slab and falling into a
// cave become camera decisions instead of collisions.
const player = newPlayer(0, 0, 0);

/**
 * The collision answer for one block coordinate. The rule - and the reason a cell below the stored
 * range is a floor while a cell whose chunk has not streamed is unknown - lives in web/js/collision.js
 * next to the other payload readers, where tests/web-player.test.mjs can put it against real region
 * bytes. A body that meets C_UNKNOWN stops rather than integrates blind: an unloaded chunk is not a
 * hole in the world, and a walker that free-falls through un-streamed rock and lands inside a mountain
 * is worse than one that waits a fifth of a second for the bytes.
 */
const cellAt = makeCellAt((cx, cz) => (store ? store.get(cx, cz) : null), () => assets);

/** The bottom of the world under the feet, when that column is held. */
function worldBottomY() {
  const c = store ? store.get(player.x >> 4, player.z >> 4) : null;
  return c ? c.yMin * 16 : NaN;
}

/** Put the body where the eye is, out of walls and down onto a floor if one is close. */
function standPlayer(maxDrop = 8) {
  const y = placePlayer(cellAt, player, player.x, player.y, player.z, { maxRise: 3, maxDrop });
  if (Number.isFinite(y)) { rig.target.set(player.x, player.y + BODY.eye, player.z); walk.placed = 1; }
  return y;
}

// The body does not belong where it is - a `?goto=` into a mountainside, flight that ended inside a
// roof, bytes that arrived around it. Two answers, in the order they move it least: step up out of what
// it is standing in, then fall to the first clear box below. Looking only up was the bug - the height a
// link gives you is often inside the hill, and the ground you want is under your feet, not over them.
// If neither answers, the voxels are not known yet, and waiting is better than guessing.
function recoverBody() {
  if (Number.isFinite(standPlayer(8))) return 1;
  if (Number.isFinite(dropToClear(cellAt, player))) {
    walk.placed = 1;
    syncEye(); updateCamera(); updateView();
    standPlayer(8);
    return 1;
  }
  return 0;
}
function syncEye() { rig.target.set(player.x, player.y + BODY.eye, player.z); }
// Free flight is the same mover with the cell probes off: gravity is still integrated, walls are not.
// Leaving flight clears the placement latch so the voxels get to say where the body belongs again,
// rather than leaving it hanging at whatever height the mode let it reach.
function setFly(on) {
  S.walkFly = on ? 1 : 0;
  walk.fly = walk.on ? S.walkFly : 0;
  player.vy = 0;
  if (!walk.fly) {
    // Leaving flight hands the body back to the world. Flight can have left it inside a mountain, and a
    // collision resolver will not push a body out of solid rock - every move is refused and the viewer
    // has a statue - so the mode switch itself asks for the first clear position under where it was.
    walk.embedded = 0;
    walk.placed = 0;
    if (walk.on) recoverBody();
  }
  if (panel) panel.refresh();
  return walk.fly;
}

function setWalk(on) {
  on = !!on;
  if (on === !!walk.on) return walk.on;
  walk.on = on ? 1 : 0; S.walk = walk.on;
  if (on) {
    walk.distWas = rig.dist;
    walk.reach = S.walkReach;
    walk.fly = S.walkFly;
    rig.dist = EYE_DIST;
    rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rig.pitch));
    // The body starts at the eye: feet where the eye was, then let the voxels say where the feet
    // really belong. A `?goto=` into a tree canopy or into rock is a normal thing to do from a link.
    player.x = rig.target.x; player.z = rig.target.z;
    player.y = rig.target.y - BODY.eye;
    player.vy = 0;
    walk.placed = 0; walk.embedded = 0;
    standPlayer();
  } else {
    if (document.pointerLockElement) document.exitPointerLock();
    rig.dist = Math.max(2, Math.min(S.maxZoom, walk.distWas || 40));
  }
  // The request ring, the far grid's tiers and the store budgets are all anchored on the camera's
  // distance, so all of them re-anchor on the eye now the mode changed. Without the lastCx/lastDb
  // reset a requestAround() in the same chunk would decide nothing had moved.
  lastCx = null; lastCz = null; lastDb = -1;
  lastTierSig = ''; lastDetailR = -1;
  applyDetailBudget(); requestAround(); retierPatches(); updateCamera(); updateView();
  if (panel) panel.refresh();
  setHelp(!!walk.on);
  if (hud.msg && !hud.msg.classList.contains('err')) {
    hud.msg.textContent = on ? 'walking - click the picture to look with the mouse, V for orbit again' : '';
  }
  return walk.on;
}
// The wheel in walking mode buys view depth. One number drives the skin radius, the far grid's reach
// and (through the tier rule) how coarse the ground ahead of you may get.
function setReach(m) {
  S.walkReach = walk.reach = Math.max(96, Math.min(1600, +m || 0));
  if (walk.on) { updateView(); requestAround(); }
  if (panel) panel.refresh();
  return S.walkReach;
}
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
// The centre chunk the sharp ring was last marked for. The ring marking is what finds
// payloads that are already held; it used to run only when the ring's RADIUS changed.
let lastMarkCx = null, lastMarkCz = null;
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
  // Walking owns the distance, so anything that sets it (a preset, F, R, `__world.set('dist')`) is
  // undone here rather than leaving the mode half-applied with the target no longer the eye.
  if (walk.on && rig.dist !== EYE_DIST) rig.dist = EYE_DIST;
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
  // A walker has no frame corners to size the skin by - the target is the eye, so the square this
  // maths produces is a point. The view depth from the wheel is what the skin is asked to cover.
  // A walker sizes the world by view depth, and a walker who is falling or mining downward wants the
  // depth to reach down with them: the depth below the eye is what a hole in the ground is made of.
  const want = walk.on
    ? walkWant(walk.reach, S.fog,
        (player.vy < -1 || (walk.fly && walkDown(rig.keys)) || player.climbing) ? walk.reach * 0.6 : 0)
    : Math.max(frameWant, Math.min(groundWant, fogWant));
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
  // Under centre anchoring the ring does not collapse either: the point of the anchor is that the
  // sharp ground sits in the middle of the frame at any zoom, and a ring that shrinks on a wheel
  // gesture is exactly the unload/reload churn that made the view feel broken.
  const wantD = (S.shellOn && S.detailLod && (S.lodAnchor !== 'center' || S.detailPixels))
    ? detailRadius(rig.dist, pxPerRad(), S.detailPx, S.radius) : S.radius;
  // Grow at once - detail that arrives late is a visible hole. Shrink only once it is clearly more
  // than needed, so a wheel drag does not thrash 300 chunks between mesh and demote every frame.
  detailR = wantD >= detailR ? wantD : (wantD <= detailR - 2 ? wantD : detailR);
  if (detailR !== lastDetailR) { lastDetailR = detailR; applyDetailBudget(); }
  // A pan moves the ring without changing its radius, and `markDetailRing` - the only thing
  // that marks chunks which are *already held* - used to run only when the radius changed.
  // A payload fetched in the lead ring is marked dirty on arrival and dropped from the queue
  // as out-of-ring; slide the ring back over it and the chunk is held, unmeshed and unqueued
  // forever. The far grid then paints ground the sharp layer owns, and only an action that
  // calls applyDetailBudget (a zoom, a panel change - the user found that clicking anything
  // in the panel 'kick-started the chunk gen') would clear it.
  const [mcx, mcz] = centerChunk();
  if (S.ringScan && (mcx !== lastMarkCx || mcz !== lastMarkCz)) {
    lastMarkCx = mcx; lastMarkCz = mcz;
    markDetailRing();
    // drainMeshes already puts this wave's leftovers back and re-picks from the new centre
  }
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
  const sig = `${Math.round(rig.dist / 8)}|${skinR}|${detailR}|${S.cellPx}|${S.cellBudget}|${S.cellMax}|${S.forceCell}|${walk.on ? Math.round(walk.reach / 8) : 0}`;
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
let drag = null, pressXY = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, orbit: e.button === 0 }; pressXY = [e.clientX, e.clientY]; });
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
  if (walk.on) { setReach(wheelReach(walk.reach, e.deltaY)); return; }
  rig.dist = Math.max(2, Math.min(S.maxZoom, rig.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });
// Click to look with the mouse. Pointer lock is the only way to keep turning past the edge of the
// canvas, so it is asked for by a click rather than taken on entering the mode, and Escape gives the
// cursor back the way the browser expects. Dragging still looks around with no lock at all.
canvas.addEventListener('click', (e) => {
  if (!walk.on || document.pointerLockElement) return;
  // A click that was really a drag (you were looking around) must not steal the cursor.
  if (pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 6) return;
  canvas.requestPointerLock();
});
// M12: a click in orbit mode asks the ledger about the block under the cursor - "who placed this".
// A click that was really a drag is not a click (same 6 px rule as pointer lock), and walk mode keeps
// its click for the pointer, so there the question is asked with T at the crosshair instead.
// `askAt` loads /ledger/meta on demand: the click is an entry point, not a side effect of having turned
// on an overlay, and a handler that required meta to be already present answered a click with silence.
canvas.addEventListener('click', (e) => {
  if (walk.on) return;
  if (pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 6) return;
  askAt(e.clientX, e.clientY);
});

canvas.addEventListener('mousemove', (e) => {
  if (!walk.on || document.pointerLockElement !== canvas) return;
  const l = walkLook({ yaw: rig.yaw, pitch: rig.pitch, dx: e.movementX, dy: e.movementY,
    sens: S.walkSens, invert: S.invert });
  rig.yaw = l.yaw; rig.pitch = l.pitch;
});

let SPAWN = [0, 110, 0];
let panel = null;
addEventListener('keydown', (e) => {
  // The panel holds inputs; WASD belongs to the camera only while nothing is being typed into.
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  rig.keys.add(e.code);
  if (e.code === 'KeyR') {
    if (walk.on) { player.x = SPAWN[0]; player.y = SPAWN[1] - BODY.eye; player.z = SPAWN[2]; player.vy = 0; standPlayer(); }
    else { rig.target.set(SPAWN[0], SPAWN[1], SPAWN[2]); rig.dist = 40; }
  }
  if (e.code === 'KeyP' && panel) panel.toggle();
  if (e.code === 'KeyF') fitWorld();
  if (e.code === 'KeyX') groups.forEach((g) => g.traverse((o) => { if (o.material) o.material.wireframe = !o.material.wireframe; }));
  if (e.code === 'KeyV') { setWalk(!walk.on); return; }
  // Space and the arrows are walk keys here; the page must not scroll out from under them.
  if (walk.on && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
  if (e.code === 'KeyH') setReadouts(!readouts);   // instruments and the key line, together
  // M12: L is the ledger overlay, T asks who touched what is in the middle of the view, and Escape
  // closes the card. L rather than a panel-only switch because the overlay is a question you ask the
  // world while looking at it, not a setting you tune.
  if (e.code === 'KeyL') { setLedger(!S.ledger); return; }
  if (e.code === 'KeyT') ledgerAskCentre();
  // M12b: M runs the time machine and K plays or stops it. K is separate from M because watching a
  // build go up is a different question from asking whether the layer is on at all.
  if (e.code === 'KeyM') { setTime(!S.time); return; }
  if (e.code === 'KeyK') {
    if (!S.time) { setTime(true); S.timePlay = 1; } else setTimePlay(!S.timePlay);
    return;
  }
  if (e.code === 'Escape') { closeLedgerCard(); if (clearLedgerPins()) showLedger('markers cleared - F tours the hotspots again'); }
  if (e.code === 'BracketLeft') nudgeY(-4);
  if (e.code === 'BracketRight') nudgeY(4);
});
addEventListener('keyup', (e) => rig.keys.delete(e.code));

/** `[` / `]`: four blocks of altitude. In orbit that is the target; in walk mode it is the body, and
 *  the body then has to be set back down properly rather than dropped into a floor. */
function nudgeY(dy) {
  if (walk.on) { player.y += dy; standPlayer(2); }
  else rig.target.y += dy;
  updateView(); requestAround();
}

function stepKeys(dt) {
  if (walk.on) {
    // One physics call, one truth: shared/player.mjs owns gravity, collision, jumping, ladders and
    // swimming, and shared/walk.mjs owns what the keys mean. Space jumps, Ctrl sprints, Shift sneaks
    // (slower, and it does not fall off a ledge); in water or on a ladder Shift means down instead.
    const w = walkWish({ keys: rig.keys, yaw: rig.yaw });
    const x0 = player.x, y0 = player.y, z0 = player.z;
    const out = simulatePlayer(player, {
      fx: w.fx, fz: w.fz, jump: walkUp(rig.keys), down: walkDown(rig.keys),
      sneak: walk.fly ? 0 : walkDown(rig.keys),
      sprint: walkSprintKey(rig.keys), fly: walk.fly,
    }, dt, cellAt, {
      gravity: S.walkGravity, jumpV: S.walkJump, speed: S.walkSpeed, sprintMul: S.walkSprint,
      sneakMul: S.walkSneak / S.walkSpeed,
      flyV: S.walkSpeed * 4, flySprint: S.walkSpeed * 4 * S.walkSprint, minY: worldBottomY(),
    });
    walk.frozenFrames = out.frozen ? walk.frozenFrames + 1 : 0;
    if (out.landed) walk.landed = out.landed;
    // The body's box must never overlap a solid voxel. When it does, the usual cause is boot order: the
    // page puts the body at the ?goto= height before the bytes for that column have streamed, and the
    // height it was given is inside the ground. The honest repair is what the tests already assert -
    // climb out and stand on the floor - done on a slow timer so it cannot thrash, and counted so a
    // probe can see it happened rather than being handed a body that quietly sits in a rock.
    if (!walk.fly) {
      // Until the bytes under the body arrive there is nothing to stand on, so keep asking every frame
      // rather than integrating blind: the first frame that knows the column puts the feet on its floor.
      if (!walk.placed && recoverBody()) walk.unstuck++;
      const embed = playerHits(cellAt, player.x, player.y, player.z);
      walk.embedded = embed ? walk.embedded + 1 : 0;
      // Repair a body at rest inside a solid, which is what late bytes around it leave. A body moving fast
      // is not repaired: that is a fall arriving in a chunk that loaded under it, and the collision in
      // moveAxis already stops it there - yanking it to a floor mid-fall would be the bug, not the fix.
      if (embed > 0 && Math.abs(player.vy) < 6 && walk.embedded >= 20 && (walk.embedded - 20) % 30 === 0) {
        if (recoverBody()) walk.unstuck++;
      }
    }
    syncEye();
    if (Math.abs(player.x - x0) + Math.abs(player.y - y0) + Math.abs(player.z - z0) > 1e-4 || out.frozen) {
      updateView(); requestAround();
    }
    return;
  }
  const speed = (rig.keys.has('ShiftLeft') ? 120 : 30) * dt;
  if (rig.keys.has('KeyW') || rig.keys.has('ArrowUp')) rig.target.addScaledVector(fwdOf(), speed);
  if (rig.keys.has('KeyS') || rig.keys.has('ArrowDown')) rig.target.addScaledVector(fwdOf(), -speed);
  if (rig.keys.has('KeyA') || rig.keys.has('ArrowLeft')) rig.target.addScaledVector(rightOf(), -speed);
  if (rig.keys.has('KeyD') || rig.keys.has('ArrowRight')) rig.target.addScaledVector(rightOf(), speed);
  if (rig.keys.has('KeyE')) rig.target.y += speed;
  if (rig.keys.has('KeyQ')) rig.target.y -= speed;
}

// Free flight is not a second mover: it is the same simulate() with `fly` set, which skips the cell
// probes entirely. That is what the mode is for - looking at a mountain from outside it - and it is
// also why flight never freezes over a chunk that has not streamed, while walking does.

// ---- data ------------------------------------------------------------------
let assets = null, atlasTex = null, atlasPixels = null, materials = null, shellMat = null,
  shellTexMat = null,
  store = null, shellStore = null, mipCap = null;
const meshes = new Map();   // "cx,cz" -> {list, stats, mk}
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
  const flat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const tex = atlasTex && makeMaterial(1, atlasTex);
  for (const m of [shellMat, shellTexMat]) if (m && m.dispose) m.dispose();
  shellMat = flat; shellTexMat = tex;
  setCoarseSide();
}

// Which way the coarse layers face. A shell column or a baked tile is a one-sided height field, and
// from below its quads are culled, so the ground turns into a window on the sky. DoubleSide paints
// the same quads from behind instead of adding geometry; the cost is fill over the underside, which is
// only paid when the underside is what you are looking at.
function setCoarseSide() {
  const side = S.flatBack ? THREE.DoubleSide : THREE.FrontSide;
  for (const m of [shellMat, shellTexMat, lodMat]) if (m) m.side = side;
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
  // Wants the whole map as a surface skin, and the underground only when asked for.
  surfaceOnly: S.caves ? 0 : S.surface,
  // Four vertices and six indices per face instead of six vertices. The triangles are identical -
  // 100 real chunks: 20 717 verts/chunk becomes 13 811 in this form, and 12 347 once neighbouring
  // faces share corners too (build/dbg-mergerate.mjs). ?soup=1 puts the old emission back for an A/B.
  index: S.meshIndex,
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

/**
 * @param over 3x3 map of "cx,cz" -> {ch, secOf} PATCHED chunks (M12b Tier 2). The mesher reads its
 * neighbours for border faces, so a corrected chunk and an uncorrected neighbour draw a seam at the
 * shared wall; the overrides are what keep the two sides agreeing. Absent = the store's payload.
 */
function buildChunkGeometries(chunk, over = null) {
  const at = (cx, cz, lx, ly, lz) => {
    if (over) {
      // lx/lz are LOCAL to the meshed chunk, so a neighbour read at local -1 or 16 belongs to the
      // next chunk over - the same rounding the lookup helpers do.
      const e = over.get(`${cx + (lx >> 4)},${cz + (lz >> 4)}`);
      if (e) return idToState(voxelId(e.ch, e.secOf, lx, ly, lz), assets.states.length);
    }
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
    if (s.index) g.setIndex(new THREE.BufferAttribute(s.index, 1));
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
let meshBytesGhost = 0;                // parked bytes whose voxels the store has let go
// Parked passes that had an index buffer, and installs that got one. These two counters are the
// regression check for the park losing an index: a mesh parked indexed and installed unindexed is drawn
// as a strip over 4-corner data, which is a picture of broken quads, not a missing chunk.
let parkedIndex = 0, installedIndex = 0;
const parkIndexLost = { count: 0 };        // parked with an index, installed without one

const detailSig = () => `A${S.ao ? 1 : 0}/${S.aoMin}L${S.light ? 1 : 0}/${S.darkFloor}/${S.darkGamma}` +
  `/${S.skyScale}D${S.caves ? -1 : S.darkcut}B${S.caves ? 0 : S.buried}S${S.buriedSky}U${S.caves ? 0 : S.surface}` +
  `C${S.shellOn && S.cullCovered ? 1 : 0}` +
  `I${S.meshIndex}` +                            // four verts + indices, or the soup: not interchangeable
  `G${dimGen}`;

// ---- one mesh per (payload + the border the mesher reads) ----------------------------------------
// A chunk arrives, is meshed, and then every neighbour that arrives marks it dirty again: in a
// streaming wave one chunk answers to five mesh jobs (itself plus four neighbours) to build five
// identical meshes, and a parked camera paid for 33 of them in five idle seconds. What can legitimately
// change a chunk's triangles is exactly: its own payload, one of the eight neighbours appearing,
// disappearing or being re-fetched, whether the far skin owns a neighbour's ground, or a mesh setting.
// So a mesh carries a key made of those, and a dirty mark whose key already matches installs nothing.
//
// A payload held by the store is immutable - a re-fetch replaces the object - so object identity is a
// sound payload stamp. An unheld neighbour has no stamp, which is why "unknown" can never read as air
// here: the moment it is known the key changes and the wall is built against real voxels.
const meshDone = new Map();                 // "cx,cz" -> key of the mesh currently installed
const PARK_THEN_BUILD_MS = 10000;           // a re-cut this soon after an install means the install was wasted
const meshUnchanged = { count: 0 };         // dirty marks that needed no work at all
// A worker result that gets thrown away has already consumed the chunk's dirty mark - `takeDirty` handed
// the key over and the result was rejected. Without a re-mark the chunk ends up held, inside the ring,
// unmeshed and unqueued, which is the `ringStuck [6,0]` settle failure: six chunks at the dead centre of
// the view, 24 sections of voxels in hand, and a hole in the middle of the picture that no amount of
// waiting fixed. Counted so a regression shows up as a number instead of a screenshot.
const meshResultsDropped = { count: 0 };
const meshUnsettled = { count: 0 };         // meshes actually built against a border with a hole in it

// The key itself lives in web/js/mesh-key.js, which is DOM-free and three-free so a test can hold it:
// same payload and same known border must not re-mesh, and a neighbour that turns up must.
const meshKeys = meshKeyTool(
  (cx, cz) => (store ? store.get(cx, cz) : null),
  (cx, cz) => !!(store && store.missing.has(`${cx},${cz}`)));
const stampOf = meshKeys.stampOf;

const coveredKey = (cx, cz) => {
  const c = coveredNeighbours(cx, cz);
  return c ? c.map(([x, z]) => x + ':' + z).join(',') : '';
};

// The history stamp of the 3x3 joins the key, so a playhead move invalidates exactly the touched
// chunks and their borders, and nothing else. It is NOT in detailSig, which would invalidate every
// mesh in the world - including 350 parked triangle sets - on every sync.
const meshKeyFor = (cx, cz) => meshKeys.key(cx, cz, detailSig() + histSuffix(cx, cz), coveredKey(cx, cz));
const settledNeighbours = (cx, cz) => meshKeys.settled(cx, cz);

/** Why a key is dirty and how long it has waited, so "skip the work" never means "never do it". */
const dirtyTag = new Map();

const dirtyWhy = new Map();
const meshWhy = new Map();
function tagDirty(k, why) {
  if (!dirtyTag.has(k)) dirtyWhy.set(why, (dirtyWhy.get(why) || 0) + 1);
  dirtyTag.set(k, why);
}
function markChunk(k, why, keepTag = false) {
  if (!store) return;
  if (!keepTag || !dirtyTag.has(k)) tagDirty(k, why);
  store.dirty.add(k);
}
let meshBuilds = 0;                         // mesher runs actually started, worker or inline
function countMesh(k) {
  meshBuilds++;
  const t0 = parkedAt.get(k);
  if (t0 !== undefined) { parkedAt.delete(k); if (performance.now() - t0 <= PARK_THEN_BUILD_MS) parkThenBuild++; }
  const why = dirtyTag.get(k);
  if (why) meshWhy.set(why, (meshWhy.get(why) || 0) + 1);
  dirtyTag.delete(k);
}

// Was a parked set installed and then thrown away by a real rebuild? Parking that only buys a few
// frames of use is not parking: `reused` alone counts the install, this counts the waste after it.
const parkedAt = new Map();                 // key -> ms, when its bytes last came back
let parkThenBuild = 0;

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
  // The copying, and the `geometry.index` vs `geometry.attributes.index` decision, live in
  // web/js/mesh-bytes.js so a Node test can hold them.
  const { passes, bytes, indexBuffers } = parkPasses(entry.list);
  if (!passes.length) return;
  parkedIndex += indexBuffers;
  dropBytes(key);
  meshBytes.set(key, { passes, stats: entry.stats, bytes, mk: entry.mk, sig: detailSig() });
  meshBytesTotal += bytes;
  trimMeshBytes();
}

/** Parked bytes for a chunk the store itself dropped can never be installed again: they are RAM
 * for a voxel payload that no longer exists.
 *
 * That held when the key stamped a payload by *object identity*, and it cost the round trip: a
 * 400-block pan at a 1.2 km pull-back evicts every chunk it leaves behind, this sweep deleted their
 * parked triangles with them, and coming back rebuilt 66-83 chunks from scratch with `reused 0` in
 * every run. The fingerprint now carried by `openChunk` changes the premise: parked bytes say which
 * voxels and which border they were cut against, so they stay useful until either the ground under
 * them changes (a different fingerprint at install time) or the byte cap wants the room. The cap is
 * still the only bound, and it evicts farthest-from-camera first. ?byteskeep=0 restores the old
 * delete-on-eviction rule for an A/B. */
function sweepMeshBytes() {
  if (!store) return;
  if (!S.bytesKeep) {
    for (const k of [...meshBytes.keys()]) {
      if (store.has(...k.split(',').map(Number))) continue;
      meshBytesDropped++;
      dropBytes(k);
    }
  }
  trimMeshBytes();
  meshBytesGhost = 0;
  for (const k of meshBytes.keys()) if (!store.has(...k.split(',').map(Number))) meshBytesGhost++;
}

/** Rebuild a chunk from parked bytes. False means nothing usable was parked: mesh it normally. */
function installCached(cx, cz, mk) {
  const key = `${cx},${cz}`, e = meshBytes.get(key);
  if (!e) return false;
  // The key, not just the settings: bytes parked while a neighbour was still unknown must not be
  // installed once that neighbour is here, or the wall against its ground is missing. With ?meshkey=0
  // the old settings-only rule is back, so an A/B of 9.6 compares behaviour, not the byte cache.
  if (S.meshKey ? e.mk !== mk : e.sig !== detailSig()) { dropBytes(key); return false; }
  dropBytes(key);
  // Park the variant being replaced, but only while the time machine runs: a playhead that goes out and
  // back wants the other geometry, and outside that mode this is the path the 9.x measurements priced.
  const wasCovered = dropChunkMesh(cx, cz, HIST.on);
  const geos = e.passes.map(({ pass, position, uv, color, index }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Uint8BufferAttribute(color, 4, true));
    if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    // Parked an index, installed none = the geometry is a strip over 4-corner data. Loud, because the
    // picture it draws is garbage rather than a hole.
    if (!indexedMatch({ index }, g)) parkIndexLost.count++;
    return { pass, geometry: g };
  });
  attachChunkMesh(cx, cz, geos, e.stats, wasCovered, mk);
  cachedInstalls++;
  installedIndex += geos.reduce((n, { geometry }) => n + (geometry.index ? 1 : 0), 0);
  parkedAt.set(`${cx},${cz}`, performance.now());
  return true;
}

/** Dispose one chunk and report whether it was there. `stash` parks the bytes for cheap re-entry. */
function dropChunkMesh(cx, cz, stash = false) {
  const key = `${cx},${cz}`;
  const old = meshes.get(key);
  if (!old) return false;
  meshes.delete(key);
  meshDone.delete(key);
  if (stash) stashMeshBytes(key, old);
  for (const { pass, mesh } of old.list) { groups[pass].remove(mesh); mesh.geometry.dispose(); }
  return true;
}

// The skin has to stop drawing under anything the detail pass picks up, otherwise two surfaces sit
// at the same height and z-fight. `wasCovered` is the state before this mesh landed.
function attachChunkMesh(cx, cz, geos, stats, wasCovered, mk = null) {
  // A worker can finish a chunk after the ring has already moved past it. Installing that result would
  // put full-res geometry back exactly where the far grid is supposed to paint it (the demote pass had
  // already run), so the work is thrown away rather than drawn.
  if (S.shellOn && S.detailLod && !inDetailRing(cx, cz, 1)) {
    for (const { geometry } of geos) geometry.dispose();
    return;
  }
  // How many detail chunks THIS playhead rebuilt, counted where a mesh is actually installed rather than
  // derived afterwards from a global build counter (which also counts streaming, far re-cuts and every
  // other reason a chunk gets meshed). A chunk the undo empties still counts: it was rebuilt.
  if (HIST.on && histSuffix(cx, cz)) { HIST.builds++; HIST.buildTotal++; }
  // Replace whatever is here, in this call. The worker path leaves the previous mesh drawing while it
  // computes, so this is the one moment the two can be swapped without a frame in between; parking the
  // old bytes (only while the time machine runs) is what makes the move back cheap instead of another cut.
  // This line used to read `if (HIST.on && S.keepMesh) dropChunkMesh(`${cx},${cz}`, true)`, and it was
  // wrong twice over. The guard made the swap conditional on the time machine running, and - worse - the
  // call handed `dropChunkMesh` a COMPOSED "cx,cz" STRING where it wants two numbers, so the key it
  // looked up was `"-4,-9,undefined"`: it found nothing, removed nothing, and the `meshes.set` below
  // then overwrote the record of the mesh that was on screen. Every re-cut left its predecessor drawing
  // underneath it. Measured at the house in the user's screenshot: two identical 8 032-vertex `detail0`
  // meshes over chunk -4,-9, 70 drawn vertices inside a block the replay had turned to air, and 0 changed
  // pixels. So the corrected wall did get built and installed, and the wall from before the playhead kept
  // painting it from the same spot forever - which is exactly "the house doesn't disappear". It is also
  // why the keep-mesh flicker fix measured `dipFrames 0`: nothing was ever taken away, so nothing could
  // dip. The swap is unconditional now, and parking stays a time-machine affordance.
  dropChunkMesh(cx, cz, !!(HIST.on && S.keepMesh));
  // An empty answer is still an answer, so it is recorded: `meshes.has` is what `detailHere` asks, and
  // the mk short-circuit in the mesh drain is what stops the next dirty mark from meshing it again.
  // Six chunks in a void column (surface sentinel -2048, air top to bottom) were the whole of the
  // `ringStuck [6,0]` settle failure: no triangles to install, no entry, so every arrive/evict/ring mark
  // re-ran the mesher over them and every settle re-counted them as unfinished work.
  // The skin-coverage mark is only for a chunk that actually picked something up - there is no surface
  // to stop drawing under when the answer is nothing, and a patch re-cut costs ~11 ms.
  if (!geos.length && !wasCovered) {
    meshes.set(`${cx},${cz}`, { list: [], stats, mk });
    meshDone.set(`${cx},${cz}`, mk);
    return;
  }
  // The skin has to stop drawing under anything the detail pass picks up, otherwise two surfaces sit at
  // the same height and z-fight. And a coarse patch cut *before* this chunk landed still has a cell
  // standing where the fine geometry now is: a 16-block plate parked on the roof of the house you are
  // looking at, which used to never go away because nothing asked for the patch to be re-cut. The mesher
  // skips chunks the detail owns, so re-cutting the patch removes it.
  if (!wasCovered) markPatch(cx, cz, 'cover');
  else if (S.patchDetail && shellMeshes.has(patchKey(cx, cz))) { markPatch(cx, cz, 'detail'); patchDetailMarks++; }
  const list = geos.map(({ pass, geometry }) => {
    const mesh = new THREE.Mesh(geometry, materials[pass]);
    mesh.name = `detail${pass}`;
    mesh.renderOrder = pass;
    mesh.frustumCulled = true;
    // A chunk mesh never moves: its vertices are already in world coordinates.
    pinStatic(mesh);
    groups[pass].add(mesh);
    return { pass, mesh };
  });
  meshes.set(`${cx},${cz}`, { list, stats, mk });
  meshDone.set(`${cx},${cz}`, mk);
}

function rebuild(cx, cz, mk) {
  const wasCovered = dropChunkMesh(cx, cz, HIST.on);
  const chunk = store.get(cx, cz);
  if (!chunk) return;
  if (!mk) mk = meshKeyFor(cx, cz);
  countMesh(`${cx},${cz}`);
  const t0 = performance.now();
  // Tier 2: mesh the world as of the playhead. `over` holds patched COPIES; the store keeps the real
  // payload, and these patches are dropped when the mesh is built.
  const over = histOverlayChunks(cx, cz);
  const { geos, stats } = buildChunkGeometries(over.get(`${cx},${cz}`)?.ch ?? chunk, over);
  meshStat(performance.now() - t0);
  attachChunkMesh(cx, cz, geos, stats, wasCovered, mk);
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
  // One generation number for the whole pool. It used to be one number per worker (`w.seq = ++workerSeq`),
  // and the two places that ask "is this worker still current?" compare a worker's seq against the
  // running counter - so for a pool of eight, exactly the last worker ever matched. workerReady stuck at
  // 1, workersUsable() was false forever, and every chunk mesh ran on the render thread at 30-40 ms a
  // frame while the HUD cheerfully reported 8 workers. The pool was never the fix; it was the bug.
  const gen = ++workerSeq;
  for (let i = 0; i < n; i++) {
    // type: 'module' because the worker imports the same ESM modules the page and the tests use.
    const w = new Worker('/js/mesh-worker.js', { type: 'module' });
    w.busy = false;
    w.seq = gen;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.patch) { patchResult(w, m); pumpMeshes(1, performance.now() + MIDPUMP_MS); return; }
      if (m.ready) { workerReadyMsgs++; if (w.seq === workerSeq) workerReady++; return; }
      w.busy = false;
      const job = jobs.get(m.seq);
      jobs.delete(m.seq);
      jobForKey.delete(m.key);
      // The chunk may have been evicted, replaced, or switched dimension while its mesh was being
      // built; a stale skin over new voxels is worse than one more frame of shell.
      // A result built at an older playhead is stale even when its key still matches: the key carries the
  // history stamp, so this is belt-and-braces against a job posted before a sync and answered after.
  if (!job || job.gen !== dimGen || job.histGen !== HIST.gen || !store.get(m.cx, m.cz)) {
        meshResultsDropped.count++;
        // Discarding the triangles is right; discarding the *work order* along with them is what left a
        // hole. Put the order back if the chunk is still something the sharp layer owns.
        if (store && store.has(m.cx, m.cz) && inDetailRing(m.cx, m.cz, 1) &&
            !meshes.has(`${m.cx},${m.cz}`)) markChunk(m.key ?? `${m.cx},${m.cz}`, 'worker-dropped');
        return;
      }
      const geos = m.passes.map(({ pass, position, uv, color, index }) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(position, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setAttribute('color', new THREE.Uint8BufferAttribute(color, 4, true));
        if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
        g.computeBoundingSphere();
        return { pass, geometry: g };
      });
      meshStat(m.ms ?? 0);
      // The patch bill is kept apart from this thread's, because the panel sentence says where the
      // correcting happened: a scrub meshed mostly by workers should read that way.
      if (m.patched) { HIST.workerPatches += m.patched; HIST.workerPatchMs += m.patchMs ?? 0; HIST.workerPatchTotalMs += m.patchMs ?? 0; }
      meshWait = Math.max(meshWait, performance.now() - job.t0);
      attachChunkMesh(m.cx, m.cz, geos, m.stats, job.wasCovered, job.mk);
      // This thread is free now. Ask for the next chunk instead of waiting for the next frame: at 6 fps
      // a once-a-frame drain feeds eight workers six times a second, which is how a full detail ring
      // took 15 s to paint after a pan.
      pumpMeshes(1, performance.now() + MIDPUMP_MS);
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
    if (store) markChunk(job.key, 'worker-reset');
  }
  for (const [seq, job] of [...patchJobs]) { patchJobs.delete(seq); patchJobForKey.delete(job.pk); }
  patchInflight = 0;
  waveDrop(true);                       // the wave's keys go back to the dirty set, not into the void
  startWorkers();
}

function meshAsync(cx, cz, mk) {
  const key = `${cx},${cz}`;
  if (jobForKey.has(key)) return true;
  if (!mk) mk = meshKeyFor(cx, cz);
  // A pan wants two kinds of work at once: chunk meshes for the middle of the view, and far patch
  // cuts for everything around it. Reserving threads for the cuts is what stopped a 20 ms cut falling
  // back onto the render thread - but the reservation was `min(patchCap, pool-1)`, which with 6 cut
  // threads on an 8-thread pool left chunk meshing 2 workers, and the detail layer stopped coming
  // back after a pan: 15 s out it had painted 380 chunk meshes with 855 keys still queued, where 2
  // cut threads reached 530 meshes and an empty queue in 4.5 s. Detail is the layer the user is
  // looking at, so the cut queue only holds back what it can actually start, and never more than two.
  const reserve = cutReserve({ patchCap: patchCap(), dirtyPatches: dirtyPatches.size,
    patchInflight, poolSize: pool.length });
  let free = 0;
  for (const x of pool) if (!x.busy) free++;
  if (free <= reserve) return false;
  const w = pool.find((x) => !x.busy);
  const chunk = store.get(cx, cz);
  if (!w || !chunk) return false;
  // NOT dropChunkMesh: the old triangles stay on screen while this job runs. Dropping at post time is what
  // made a time-machine scrub blink - one playhead move marks up to 192 chunks, and every one of them went
  // blank (far layer showing through) for the length of a worker round trip. The swap now happens in
  // attachChunkMesh, at the moment the replacement actually exists.
  const wasCovered = S.keepMesh ? meshes.has(key) : dropChunkMesh(cx, cz);
  const chunks = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = store.get(cx + dx, cz + dz);
      if (c) chunks.push(plainChunk(c));
    }
  }
  const seq = ++meshSeq;
  countMesh(key);
  jobs.set(seq, { cx, cz, key, wasCovered, t0: performance.now(), gen: dimGen, mk, histGen: HIST.gen });
  jobForKey.set(key, seq);
  w.busy = true;
  w.postMessage({
    key, cx, cz, seq, chunks, opts: meshOpts(), covered: coveredNeighbours(cx, cz),
    // Only the EDITS cross the boundary, not patched payloads: the worker applies them to the copies
    // it already decoded, which is a few hundred writes instead of a second chunk upload.
    hist: histOverlays(cx, cz), airId: HIST.airId || 1, histGen: HIST.gen,
  });
  return true;
}

// Drain the dirty set: hand work to free workers when they are up, otherwise pay for it here so the
// page still renders on browsers or probes that forced ?workers=0.
//
// The queue is drained by whoever frees a thread, not once per frame. Posting used to be a once-per-
// frame event: at 6 fps the pool got six chances a second to be fed, and eight threads that can each
// finish a chunk in 26 ms managed 35 chunk meshes a second between them. A 10-chunk detail ring then
// took 15 s to paint after a pan with every payload already in memory (inflight 0, queue 0, and a
// `budget` of 8, 24 or 48 making no difference at all) - which is exactly what "detailed chunks are not
// loading after panning around" looks like. `pumpMeshes` now runs from the frame **and** from a worker's
// result handler, so a thread that goes idle asks for work immediately instead of at the next frame.
let wave = [], waveAt = 0, waveCx = 1e9, waveCz = 1e9;

// A key taken out of `store.dirty` is the wave's responsibility until it is handled: dropping the wave
// without putting the rest back loses those chunks.
function waveDrop(requeue) {
  if (requeue && store) for (let i = waveAt; i < wave.length; i++) store.dirty.add(wave[i]);
  wave = []; waveAt = 0;
}

/**
 * Walk the nearest-first list and finish at most `maxJobs` of it, stopping at `deadline`.
 * The deadline bounds *inline* meshing (no worker pool); with a pool the stop condition is "no thread
 * free", and whatever is left keeps its order in the wave for the next pump.
 */
// A worker that just freed up is fed straight away rather than at the next frame - that is what took
// a detail ring from 15 s to 4 s after a pan - but the feed is cost-bounded, because eight results
// can land in one task and each one posts another job on the way out.
const MIDPUMP_MS = 2;

function pumpMeshes(maxJobs, deadline) {
  if (!store) return 0;
  const inline = !workersUsable();
  let done = 0;
  for (;;) {
    if (done >= maxJobs) return done;
    if (waveAt >= wave.length) { wave = store.takeDirty(Infinity); waveAt = 0; }
    if (waveAt >= wave.length) return done;
    const k = wave[waveAt++];
    const [cx, cz] = k.split(',').map(Number);
    // A dirty key whose chunk is gone must be dropped, not put back. It used to go back, and since
    // the loop stops on the first refusal, one stale key throttled the whole mesh queue: 35 of them
    // sat in the set and every frame burned its one allowed take on a chunk that no longer existed.
    if (!store.has(cx, cz)) { dirtyTag.delete(k); continue; }
    if (!inDetailRing(cx, cz, 1)) { dirtyTag.delete(k); continue; }
    const mk = meshKeyFor(cx, cz);
    // The triangles on screen already answer this payload and this border, so there is nothing to do.
    // Measured honestly: this fires 0 times on a pan (every dirty mark at a 5-chunk ring really did have
    // a changed border), and it is the guard that makes the parked bytes below safe to install.
    if (S.meshKey) {
      const have = meshes.get(k);
      if (have && have.mk === mk) { meshUnchanged.count++; dirtyTag.delete(k); continue; }
    }
    const parked = meshBytes.get(k);
    if (parked && parked.mk === mk) { installCached(cx, cz, mk); done++; dirtyTag.delete(k); continue; }
    // Meshing against a border that is not settled is the expensive case in theory: whatever is
    // built now has a wall against the unknown in it, and the arrival forces a second mesh of the
    // same chunk. Counted (`meshUnsettled`) because it is the number that says whether the payload
    // ring is wide enough - and waited out twice, both times for nothing. The first try measured 0
    // deferrals across four A/B runs and eight pan legs. The second (radius 8, dist 1200, ten pan
    // legs, `?deferms` bounded wait): 60 waits, unsettled meshes 102 -> 60, `arrive`-marked builds
    // 198 -> 181, and the pan's total builds unchanged at 738 vs 734. The reason is the shape of a
    // pan: a 17x17 ring sliding 4.8 chunks per leg sweeps ~990 chunk positions that were never
    // meshed, so nearly every arrival is a *new* chunk rather than the neighbour of one already
    // meshed, and there is no second mesh to avoid.
    if (S.meshKey && !settledNeighbours(cx, cz)) meshUnsettled.count++;
    if (inline) {
      rebuild(cx, cz, mk);
      done++;
      if (performance.now() > deadline) return done;   // over budget: the wave keeps the rest
      continue;
    }
    if (meshAsync(cx, cz, mk)) {
      done++;
      // The deadline used to be paid only on the inline path. With workers, one frame's drain posted
      // job after job - each one a copy of the chunk's voxel arrays plus the structured clone on the way
      // out - and a frame in the middle of a pan paid 27-40 ms without ever meshing anything itself.
      if (performance.now() > deadline) return done;
      continue;
    }
    waveAt--;                                // no thread free: this key waits, and keeps its place
    markChunk(k, 'no-worker', true);
    return done;
  }
}

function drainMeshes(now) {
  // Re-order the queue when the view centre moved: nearest-first was computed when the wave was taken,
  // and after a pan the middle of the new view has to jump the old view's leftovers. Putting the tail
  // back in the dirty set is what keeps that from dropping chunks.
  const [cx, cz] = centerChunk();
  if (cx !== waveCx || cz !== waveCz) { waveDrop(true); waveCx = cx; waveCz = cz; }
  pumpMeshes(Infinity, now + S.budget);
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
  // The payload trails the *mesh ring*, not the user's ceiling. It used to be
  // min(S.radius, detailR + lead), and since the mesh ring is at or under that ceiling, the lead was
  // clamped to nothing exactly when it mattered: panning 25 chunks at a 1.2 km pull-back pushed a
  // chunk's voxels out of the store in the same instant its mesh was demoted, the parked triangles were
  // swept with them, and coming back cost a full re-mesh. Measured: 60 detail builds per warm pan leg,
  // meshReused 0, meshCacheDropped 275.
  payloadR = detailR + S.payloadLead;
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
    if (inDetailRing(c.cx, c.cz, 1) && !meshes.has(`${c.cx},${c.cz}`)) markChunk(`${c.cx},${c.cz}`, 'ring');
  }
}

// Demote: dispose the geometry (that is the VRAM and the draw cost), keep the payload. The patches
// the skin skipped because detail owned them have to be re-meshed, or dropping detail punches a hole
// - the same failure class as an overview cell that nothing paints.
function demoteOutsideRing(now, budget = 64) {
  let n = 0;
  // The headcount bound was the only bound, and it is not a measure of work: what a demotion costs is
  // the parked-byte copies and the buffer deletes, and 64 chunks of them landed 45 ms on one frame.
  const deadline = now + S.demoteBudget;
  for (const k of [...meshes.keys()]) {
    if (n >= budget || performance.now() > deadline) return n;
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
const tiers = () => (S.forceCell
  ? [S.forceCell]
  : CELLS16.filter((c) => c <= Math.min(S.cellMax, S.lodMaxCell)));   // the quality slider clamps both
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
  const nearBlocks = tierDistance(dTarget, rig.dist / CH, S.lodAnchor) * CH;
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

// A far patch cut used to happen on the render thread. It is 20-25 ms of mesher work - more than a
// frame - and a pan asks for sixty of them (measured: 64-82 cuts per leg at 19-25 ms each, so 1.3-1.8 s
// of main-thread work for a gesture that should cost nothing). The cut now runs on the mesh workers,
// which already hold the atlas and the same DOM-free mesher module.
//
// What crosses the boundary is data, never policy: the patch's shell frames as packed bytes, plus the
// per-chunk answers only the page can give (cell size, and which cells the voxel detail owns). Coming
// back it is the vertex streams. The packing is pinned byte-identical to a live cut by
// tests/web-shellbatch.test.mjs, and `PATCH_REACH` is measured rather than guessed
// (tools/dbg-patchreach.mjs), because a frame that reads null where the page found one opens a hole at
// a patch border.
const patchJobs = new Map();          // seq -> {pk, gen, tier, mode, sig, t0}
const patchJobForKey = new Map();     // patch key -> seq: one cut per patch at a time
let patchSeq = 0, patchInflight = 0, patchPosted = 0, patchDropped = 0, patchOutside = 0, patchWide = 0;
// How many of the mesh threads may take a far patch cut. Measured across a 5 s drag, peak frame cost:
// 0 threads 60 ms, 2 threads 29 ms, 4 threads 22 ms, 6 threads 15.7 ms (dist 400) and 23 -> 14.5 ms
// (dist 150). But the same threads are the only thing meshing chunk detail, so the pool keeps two:
// asking for 6 on a machine that started 4 workers gets 2, and a 2-worker pool cuts its own patches.
const patchCap = () => patchThreadCap({ poolSize: pool.length, want: S.patchWorkers });
// Chunk detail waiting or running: the only reason the cap on far cuts exists.
const detailWaiting = () => Math.max(0, wave.length - waveAt) + jobs.size;
/**
 * How many far cuts this patch may have in flight. Normally the pool cap; past it when the cap is
 * full, a thread is idle, nothing is waiting for detail, and this cut is expensive enough that the
 * render thread paying for it is the worse answer (`mayTakeThread`, shared/cutpolicy.mjs). The gate in
 * drainShellPatches and the path in rebuildPatch ask through this one helper, so they cannot disagree
 * about whether a thread exists - which is how a deferred 27 ms cut and an idle worker kept missing
 * each other (97 idle-cap-full samples, one steal).
 */
const threadCapFor = (price, inflight = patchInflight) =>
  mayTakeThread({ inflight, cap: patchCap(), poolSize: pool.length, priceMs: price,
    stealMs: S.patchStealMs, workerFree: pool.some((w) => !w.busy), detailWaiting: detailWaiting() })
    ? pool.length : patchCap();

/**
 * Decide a patch cut without paying for it: tier, paint mode, the frames, and the two per-chunk
 * answers. Returns {skip: true} when the patch should not be drawn at all, which also drops whatever
 * mesh it had.
 */
function planPatch(pk) {
  const [px, pz] = pk.split(',').map(Number);
  const x0 = px * S.patch, z0 = pz * S.patch;
  let held = 0;
  for (let dz = 0; dz < S.patch; dz++) for (let dx = 0; dx < S.patch; dx++) if (shellAt(x0 + dx, z0 + dz)) held++;
  if (!held) return { skip: true };
  // A patch takes its ground away from the baked tiles only when it is whole: frames are still
  // arriving mid-load and the save really does have holes, and half a live patch over a discarded
  // tile is a hole in the view - which is what "the far LODs never load" looked like. With no baked
  // layer standing behind it there is nothing to hand the ground back to, so cut it anyway.
  if (held < S.patch * S.patch && lodPainting()) return { skip: true };
  const tier = patchTierFor(pk, patchTier.get(pk) ?? 0);
  // The baked tiles already paint this patch. The live skin stops where the tile grid takes over, so
  // the coarse ring is not meshed anywhere - that is the frame cost the bake was for.
  if (lodActive() && S.lodCap > 0 && cellOfTier(tier) > S.lodCap) return { skip: true };
  patchTier.set(pk, tier);
  const mode = patchTexMode(px, pz, tier);
  const cell = cellOfTier(tier);
  const opts = {
    cell, cellFor: cellForChunk, maxSkirt: S.skirt, skip: detailHere,
    blend: S.blend, trackStates: true, groundFar: S.groundFar, waterOpacity: S.water,
    aoFar: S.aoFar, tex: mode === 1, ...farLightOpts(),
    caps: S.caps, capDrop: S.capDrop, capCell: S.capCell,
  };
  // One chunk of border, because that is exactly how far the mesher reaches (measured at every cell
  // size); the walls along a shared patch edge are drawn from the neighbour's columns.
  const r = PATCH_REACH;
  const fw = S.patch + 2 * r, fh = S.patch + 2 * r;
  const pack = packPatchFrames(shellAt, x0 - r, z0 - r, fw, fh);
  const pol = packPatchPolicy(cellForChunk, detailHere, x0 - r, z0 - r, fw, fh);
  // The signature is taken here, at the moment the decision was made, so a cut that lands after the
  // settings or the tier moved under it can be recognised as stale instead of painted.
  return { tier, mode, cell, x0, z0, w: S.patch, h: S.patch, opts, pack, cells: pol.cells, skips: pol.skips, sig: patchSig(pk) };
}

/** Hand the cut to a free worker. False when none is free, in which case the caller pays for it here. */
function postPatchJob(pk, plan) {
  const w = pool.find((x) => !x.busy);
  if (!w) return false;
  const seq = ++patchSeq;
  patchJobs.set(seq, { pk, gen: dimGen, tier: plan.tier, mode: plan.mode, sig: plan.sig,
    cell: plan.cell, t0: performance.now() });
  patchJobForKey.set(pk, seq);
  const opts = { ...plan.opts };
  delete opts.cellFor; delete opts.skip;          // closures cannot travel; their answers are the arrays
  const { pack, cells, skips } = plan;
  w.busy = true; patchInflight++; patchPosted++;
  w.postMessage({
    seq,
    patch: {
      key: pk, x0: plan.x0, z0: plan.z0, w: plan.w, h: plan.h, cell: plan.cell, opts,
      fx0: pack.x0, fz0: pack.z0, fw: pack.w, fh: pack.h, offs: pack.offs, bytes: pack.bytes,
      cells, skips,
    },
  }, [pack.bytes, pack.offs.buffer, cells.buffer, skips.buffer]);
  return true;
}

/** Put a finished cut on screen: the old mesh goes, the new one arrives, the vertex count is recounted. */
function installPatch(pk, plan, stream, stats, ms) {
  shellN++;
  shellMs += (ms - shellMs) / shellN;
  if (ms > shellMsMax) shellMsMax = ms;
  const old = shellMeshes.get(pk);
  if (old) {
    for (const m of [old.mesh, old.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
    shellMeshes.delete(pk);
  }
  if (!stream.count) { patchTier.delete(pk); recountShellVerts(); return; }
  const mode = plan.mode;
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
    shellGroup.add(pinStatic(m));          // world-coordinate geometry; it does not move
    return m;
  };
  shellMeshes.set(pk, {
    mesh: build(stream, mode === 1 ? shellTexMat : shellMat),
    verts: stream.count,
    tier: plan.tier, mode, caps: stats.caps || 0, sig: plan.sig,
  });
  recountShellVerts();
}

/** A worker's answer for a patch. It may be about a view that no longer exists, so it is checked. */
function patchResult(w, m) {
  w.busy = false;
  if (patchInflight > 0) patchInflight--;
  const job = patchJobs.get(m.seq);
  patchJobs.delete(m.seq);
  patchJobForKey.delete(m.patch.key);
  const hadMesh = shellMeshes.has(m.patch.key);
  if (!job || job.gen !== dimGen || job.pk !== m.patch.key) { patchDropped++; return; }
  patchOutside += m.outside || 0;
  // The patch left the skin square while its cut was running. Installing it would be the old carpet
  // of far terrain standing where the pan has already moved on - the "LODs don't disappear" bug.
  const side = Math.max(1, S.patch);
  const [px, pz] = job.pk.split(',').map(Number);
  const [ccx, ccz] = centerChunk();
  if (Math.abs(px * side + (side >> 1) - ccx) > skinR + side
    || Math.abs(pz * side + (side >> 1) - ccz) > skinR + side) { patchDropped++; return; }
  // Or the tier / far settings moved under it. Keep the mesh that is on screen and re-cut: a patch
  // built for a superseded decision must not be stamped with the current signature, because the settle
  // test would then believe it is finished.
  if (patchSig(job.pk) !== job.sig) { dirtyAdd(job.pk, 'stale'); patchDropped++; return; }
  installPatch(job.pk, job, m.stream, m.stats, m.ms ?? 0);
  // A worker's cut is the same meshing work, so it prices the same cell table - the render thread
  // just does not pay for it. Without these samples the table would only ever see the cheap patches
  // that stayed inline, which is the mistake that produced the 47 ms frame in the first place.
  recordCut(cutByCell, job.cell, m.ms ?? 0);
  cutLog(job.pk, job.cell, m.ms ?? 0, 'worker', !hadMesh);
}

function rebuildPatch(pk) {
  if (patchJobForKey.has(pk)) return 'dup';    // a cut is already running for this patch
  // Whether this cut replaces a patch that is already drawn, or fills a hole. Ask BEFORE installing:
  // installPatch overwrites the store entry. The worker path asks the same question (`hadMesh`).
  const had = shellMeshes.has(pk);
  const tJob = performance.now();             // the whole job: plan, pack, and mesh if it stays here
  const plan = planPatch(pk);
  if (plan.skip) {
    const old = shellMeshes.get(pk);
    if (old) {
      for (const m of [old.mesh, old.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
      shellMeshes.delete(pk);
      recountShellVerts();
    }
    patchTier.delete(pk);
    return 'skip';
  }
  // The cut goes to a worker when one is free, and the previous mesh stays on screen until the new one
  // arrives: that is also what stops a re-cut from blanking a patch for a frame, which is what far
  // terrain flickering during a drag used to mean.
  //
  // The cap on far cuts in flight holds threads back for chunk detail. When it is already full and a
  // thread is idle anyway, refusing it does not save a thread - it moves a 30-50 ms mesh onto the
  // render thread. So an expensive cut may go past the cap; a cheap one stays inside it.
  const hardCap = patchCap();
  const cap = threadCapFor(cutPrice(cutByCell, plan.cell, shellCutAvg));
  const free = pool.some((w) => !w.busy);
  if (patchInflight >= hardCap && free) patchCappedIdle++;
  if (patchInflight < cap && postPatchJob(pk, plan)) {
    if (patchInflight > hardCap) patchStolen++;
    const ms = performance.now() - tJob;
    patchJobAvg += (ms - patchJobAvg) / ++patchJobN;
    return 'worker';
  }
  // No worker free, so this one is cut here - but with the same packed answers the worker gets, not the
  // live closures. `cellForChunk`/`detailHere` are asked once per column, which at cell 1 is 4096 asks
  // per patch, each building a chunk key string and walking two Maps and the tier table: 14% of a drag's
  // sampled main-thread time was that, and the frame-cost profile named meshColumns, tiers, cellOfTier
  // and patchKey as its callers. The arrays planPatch already built answer all of it by index.
  const t0 = performance.now();
  const get = patchFrameGetter(plan.pack);
  const pol = patchPolicy(plan.pack, plan.cells, plan.skips);
  const { stream, stats } = meshShellPatch(assets, get, plan.x0, plan.z0, plan.w, plan.h,
    { ...plan.opts, cellFor: pol.cellFor, skip: pol.skip });
  // A cut that asked for a chunk outside the packed window would be missing its border wall, and the
  // mesher is allowed to reach further than PATCH_REACH at tiers we have not sampled. Re-cut it against
  // the store: rare, and the only way this can be wrong is a way we would otherwise never see.
  if (get.outside) {
    patchWide++;
    const t1 = performance.now();
    const again = meshShellPatch(assets, shellAt, plan.x0, plan.z0, plan.w, plan.h, plan.opts);
    installPatch(pk, plan, again.stream, again.stats, performance.now() - t1);
    const ms2 = performance.now() - tJob;
    shellCutAvg += (ms2 - shellCutAvg) / ++shellCuts;
    recordCut(cutByCell, plan.cell, ms2);
    cutLog(pk, plan.cell, ms2, 'inline', !had);
    return 'inline';
  }
  installPatch(pk, plan, stream, stats, performance.now() - t0);
  const ms = performance.now() - tJob;
  shellCutAvg += (ms - shellCutAvg) / ++shellCuts;
  recordCut(cutByCell, plan.cell, ms);
  cutLog(pk, plan.cell, ms, 'inline', !had);
  return 'inline';
}

// Counted from the live meshes rather than the mesher stats: a patch that was skipped (detail owns
// it) contributes nothing, and stats would double-count after a rebuild.
function recountShellVerts() {
  shellVerts = 0;
  for (const { verts } of shellMeshes.values()) shellVerts += verts;
}

let shellCutAvg = 0, shellCuts = 0, PATCH_CUT_MAX = 64;
// Cut cost per cell size, blended over *both* paths (see shared/cutpolicy.mjs). A cell-1 patch is
// 4 096 block columns; a cell-8 patch is 64. Pricing them with one blended average is what left a
// 47 ms cut starting 9 ms into a 10 ms frame.
const cutByCell = new Map();
let patchDeferredBig = 0, patchForced = 0, patchCutMax = 0, patchCutMaxCell = 0, patchCutMaxPk = '';
// How often the cap on far cuts was full while a thread sat idle, and how often an expensive cut then
// took it. Both name the same thing from either side: the reservation was holding a thread nobody used.
let patchCappedIdle = 0, patchStolen = 0;
// The last cuts, named: cell, ms, path, first-mesh. A "shell 47 ms" frame has to be answerable.
const cutLog = (pk, cell, ms, path, first) => {
  patchCutLog.push({ pk, cell, ms: +ms.toFixed(1), path, first });
  if (patchCutLog.length > 24) patchCutLog.shift();
  if (ms > patchCutMax) { patchCutMax = ms; patchCutMaxCell = cell; patchCutMaxPk = pk; }
};
const patchCutLog = [];
// Three different pieces of work live in this pass and they cost three different things: a signature
// test (walks a patch's tier, its eight neighbours' tiers and 64 chunk keys), an inline cut (meshing
// up to 65 536 columns), and a worker job build (collecting the patch's shell frames to send away).
// Budgeting them with one blended average is how a frame ended up 30 ms: the blend said ~6 ms, the
// inline cut was 25.
let patchJobAvg = 0, patchJobN = 0, sigAvg = 0, sigN = 0;
// How many signature tests the pass ran, and how many dirty patches it left marked because its
// budget ran out. Without these two, "the far layer is slow to settle" cannot be told apart from
// "the far layer settled and nothing was left to do".
let patchTestedN = 0, patchDeferredN = 0, patchCursor = 0;
// A cut is either a first mesh (nothing on screen yet, so no test was possible) or a re-cut after the
// signature said the inputs changed. Without the split, "1 000 cuts in a pan" cannot be judged: a pan
// marks a patch for every chunk that arrives or is evicted, and it is the second kind that is worth
// hunting.
let patchCutsNew = 0, patchCutsChanged = 0;
// (There used to be a `SETTLE_TESTS = 24` count here. A signature test measured 0.03 ms, so a *count*
// was the wrong unit: it left 150+ dirty patches untested per frame, and the code answered "untested"
// by cutting the patch anyway - 2 901 inline cuts of 11 ms in one pan. The tests now share the pass's
// wall-clock deadline instead, and an untested patch stays marked.)

function drainShellPatches(now) {
  let n = 0;
  // One wall-clock deadline for the *whole* pass. The cut branch respected `shellBudget`; the
  // signature tests did not, and on a wide skin square the tests are the expensive part - 24 walks of
  // nine neighbour tiers plus 64 chunk keys each measured 20-45 ms. A frame could therefore spend
  // 46 ms in this bucket and cut nothing at all, which is the stutter in the middle of a pan.
  const deadline = now + S.shellBudget;
  // Round-robin from a cursor: the dirty set is insertion-ordered, and a pass that always starts at
  // the front starves whatever sits at the back while the front keeps getting re-marked by the pan.
  const all = [...dirtyPatches];
  patchCursor %= Math.max(1, all.length);
  const ordered = patchCursor ? all.slice(patchCursor).concat(all.slice(0, patchCursor)) : all;
  for (const pk of ordered) {
    const t0 = performance.now();
    // A test is the cheapest thing this loop can do, so if even a test does not fit, stop. A cut is
    // gated after it runs, by the average of the path that cut actually took (see rebuildPatch).
    if (t0 + Math.max(0.3, sigAvg) > deadline) return;
    patchCursor = (patchCursor + 1) % Math.max(1, all.length);
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
    if (live) {
      // Out of time for a test: leave it marked. Cutting it anyway is not a cheaper answer, it is the
      // very work the signature exists to skip - and it throws away a mesh that is on screen.
      //
      // This used to be a flat count (24 tests a frame). A test measured 0.03 ms, so the count let 150+
      // dirty patches go untested each frame, and untested used to mean "cut it": 2 901 inline cuts in
      // one pan, 11 ms each. Budget the tests with the same clock the cuts obey.
      if (performance.now() + Math.max(0.3, sigAvg) > deadline) { patchDeferredN++; continue; }
      patchTestedN++;
      const ts = performance.now();
      const same = live.sig === patchSig(pk);
      const sms = performance.now() - ts;
      sigAvg += (sms - sigAvg) / ++sigN;
      if (same) { dirtyPatches.delete(pk); dirtySince.delete(pk); continue; }
    }
    // A cut has to fit the budget it is started in, priced by *this* patch's cell. The old gate asked
    // whether the average measured cut fit, and since most cuts go to a thread (0.15 ms of main-thread
    // work) that average was set by the cheap patches: a cell-1 patch started 1 ms into a 10 ms frame
    // and the frame paid 47 ms. It also allowed the first cut of a frame unconditionally.
    const pcell = cellOfTier(patchTier.get(pk) ?? patchTierFor(pk, 0));
    const price = cutPrice(cutByCell, pcell, shellCutAvg);
    const pcap = threadCapFor(price);
    if (!S.cutCellPrice) {
      // The old rule, kept for A/B: one blended average for every patch, and the first cut of a frame
      // free. It stopped the pass instead of skipping just the unaffordable patch, which starved the
      // cheap ones behind it.
      if (n && patchInflight >= patchCap() &&
          performance.now() + Math.max(2, shellCutAvg) > deadline) {
        dirtyAdd(pk, 'budget'); patchDeferredN++;
        return;
      }
    } else {
      const act = decideCut({ cell: pcell, priceMs: price, remainingMs: deadline - performance.now(),
        inflight: patchInflight, cap: pcap, waitedMs: now - (dirtySince.get(pk) ?? now),
        starveMs: S.patchStarve, hasMesh: !!live });
      if (act === 'defer') {
        dirtyAdd(pk, 'budget'); patchDeferredN++;
        if (price > Math.max(2, shellCutAvg)) patchDeferredBig++;
        // Leave it marked and keep going: this patch is the expensive one, and a cheaper patch later in
        // the same frame is still worth serving. Returning here starved them for a whole frame.
        continue;
      }
      if (act === 'force') patchForced++;
    }
    dirtyPatches.delete(pk); dirtySince.delete(pk);
    // Pay for the patch, then decide with the cost of *that* patch in hand. A 16x16 patch is 65 536
    // heightmap columns, and its cut measured 5.5 ms; a flat count of four per frame therefore cost
    // 22 ms of a 10 ms budget and put the whole page at 23 fps while the far grid stood up. Patches
    // vary several-fold, so the last cut is the only honest estimate of the next one - and the path
    // matters: a cut handed to a thread costs the job build, an inline one costs the whole mesh.
    const path = rebuildPatch(pk);
    if (path === 'skip' || path === 'dup') continue;
    if (live) patchCutsChanged++; else patchCutsNew++;
    const est = path === 'worker' ? Math.max(0.5, patchJobAvg)
      : Math.max(2, S.cutCellPrice ? cutPrice(cutByCell, pcell, shellCutAvg) : shellCutAvg);
    if (++n >= PATCH_CUT_MAX || performance.now() + est > deadline) return;
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
  s += `|g${S.groundFar}w${S.water.toFixed(2)}t${patchTexMode(px, pz, patchTier.get(pk) ?? patchTierFor(pk, 0))}a${S.aoFar}c${S.caps}d${S.capDrop}C${S.capCell}${lightSigBit()}`;
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
      ovGroup.add(pinStatic(mesh));        // world-coordinate geometry; it does not move
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
let lodClipOn = 0, lodClipRect = [1e9, 1e9, -1e9, -1e9], lodCovPatches = 0, lodCovDetail = 0, lodCovHeld = 0;
let patchDetailMarks = 0;
let covForce = 0;                                // debug: 1 = everything covered, -1 = nothing, 0 = normal
let lodKill = 0;                                 // debug: unconditional discard, to prove the patch is live

/**
 * Is the eye inside the rock? The test is skylight, not depth: a ravine floor 40 blocks under the rim
 * is open to the sky and must keep the walls painted around it, a lava cavern is not. Measured in the
 * cavern at (40, 20, 8): the far layers there are 1.66 M shell verts plus 0.92 M baked-tile verts of
 * geometry nobody can use, and 16 fps against 30 with them off.
 *
 * When the eye sits over ground nothing is held for, the answer is *not* underground. Holding the last
 * answer was a bug with teeth: fly up out of a cave and far away, the chunk under the eye is no longer
 * held, `top` is null, and the flag stayed true - the surface layer stayed invisible until a zoom
 * gesture happened to put a chunk back under the lens. Hiding the surface layer is the destructive
 * direction, so it needs evidence, and losing the evidence means putting it back.
 */
let underFar = false, underUnknownAt = 0;
function updateUnderground() {
  if (!S.underFar) { underFar = false; underUnknownAt = 0; return; }
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
  if (top === null) {
    // Nothing held under the eye: no evidence either way. Do not decide instantly - a chunk that is
    // simply mid-flight would blink the whole surface layer in and out - but do not hold the old
    // answer forever either, which is what left the surface invisible after coming up out of a cave.
    if (!underFar) return;
    const now = performance.now();
    if (!underUnknownAt) underUnknownAt = now;
    else if (now - underUnknownAt > 400) underFar = false;
    return;
  }
  underUnknownAt = 0;
  underFar = p.y < top - S.underDepth && (sky < 0 ? true : sky <= S.underSky);
}

/** Does the heightmap layer hold every chunk of this patch? Early exit: a patch that is not held
 *  usually fails on its first chunk. */
function patchHeld(px, pz, SP) {
  if (!shellStore) return false;
  const bx = px * SP, bz = pz * SP;
  for (let i = 0; i < SP; i++) {
    for (let j = 0; j < SP; j++) if (!shellStore.has(bx + i, bz + j)) return false;
  }
  return true;
}

function updateLodClip() {
  const on = lodActive() && S.shellOn && S.lodClip !== 0;
  const PB = uCovBlk.value = S.patch * CH;
  covData.fill(0);
  lodCovPatches = 0;
  lodCovDetail = 0;
  lodCovHeld = 0;
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
    // Full-resolution chunks own ground too, and the far grid deliberately leaves their patches
    // unmeshed. Marking only live shell patches meant a baked 16-block plate sat on top of the house
    // you were looking at - the clip had nothing to say about a square the detail pass was painting.
    for (const k of meshes.keys()) {
      const c = k.indexOf(',');
      const px = Math.floor(+k.slice(0, c) / S.patch), pz = Math.floor(+k.slice(c + 1) / S.patch);
      const tx = ((px - acx) % COV_N + COV_N) % COV_N, tz = ((pz - acz) % COV_N + COV_N) % COV_N;
      const ci = (tz * COV_N + tx) << 2;
      if (covData[ci]) continue;
      covData[ci] = 255;
      lodCovPatches++;
      lodCovDetail++;
    }
    // A patch the live layer owns but has not re-cut *yet* - retired on a pan, waiting out the quiesce
    // window before it is cut again - still owns that ground. Leaving its texel clear is how a baked
    // slab flashed through in the middle of a pan over terrain the detail pass had already painted.
    // The heightmap is asked whether it holds the patch, a few patches per frame, and the answer is
    // only allowed to hide a tile when all SPxSP frames are in hand.
    const half = Math.ceil(skinR / S.patch) + 1;
    let need = 12;
    for (let px = acx - half; px <= acx + half && need > 0; px++) {
      for (let pz = acz - half; pz <= acz + half && need > 0; pz++) {
        const tx = ((px - acx) % COV_N + COV_N) % COV_N, tz = ((pz - acz) % COV_N + COV_N) % COV_N;
        const ci = (tz * COV_N + tx) << 2;
        if (covData[ci]) continue;
        need--;
        if (!patchHeld(px, pz, S.patch)) continue;
        covData[ci] = 255;
        lodCovPatches++;
        lodCovHeld++;
        if (px < x0) x0 = px;
        if (pz < z0) z0 = pz;
        if (px + 1 > x1) x1 = px + 1;
        if (pz + 1 > z1) z1 = pz + 1;
      }
    }
    lodClipRect = lodCovPatches ? [x0 * PB, z0 * PB, x1 * PB, z1 * PB] : [1e9, 1e9, -1e9, -1e9];
  } else lodClipRect = [1e9, 1e9, -1e9, -1e9];
  lodClipOn = lodCovPatches ? 1 : 0;
  covTex.needsUpdate = true;
}

const lodMatFor = () => {
  if (lodMat) return lodMat;
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  m.side = S.flatBack ? THREE.DoubleSide : THREE.FrontSide;
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
  caps: S.caps, capDrop: S.capDrop, capCell: S.capCell,

  darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale,

});

const lodActive = () => !!lodStore && !!S.lod && !!S.shellOn && !lodPolicyBad;



function makeLodStore(dim) {

  lodSticky.clear();          // rungs belong to a dimension, and to the tiles this session asked for
  lodRelease = 0;             // so does the vertex budget
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
    // The listing is the authority. /meta's count is a startup convenience and it can be wrong in
    // exactly the silent way that matters: if it under-reads the layout, the browser would sit on the
    // live far mesh forever with nothing on screen to say so.
    if (j.tiles.length) lodAvail = true;
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



/** What a **single** tile costs, in vertices. The server's /lodindex carries this per tile, read out of
 *  the baked file's own header, and the rung decision has to use that and not an average: an average
 *  over the held tiles is computed from the tiles the decision put there, so the decision moves the
 *  ruler it measures with. Measured (build/q_lodflip.js): 89 rung flips while the camera stood still,
 *  123 at a closer view - each one a fetch, an upload, a dispose and ground that changed shape.
 *
 *  lodCost is the fallback for tiles the index does not describe (a blind request before the index
 *  arrived). The rungs differ 16x in columns but only ~13x in vertices, because a flat field merges
 *  into fewer quads when the columns are wide - so guessing from columns over-bills the fine rung. */
const lodCost = new Map();                       // cell -> {n, v}, fallback only
// What the rung chooser decided per tile on the last pass, for probes only: the flip this records
// is the flip the eye sees, so print it instead of inferring it from rung totals.
const lodPicks = [];
// Last rung asked for at each region slot. Only ever read as `held` by pickLodCell, so a tile that
// has not arrived yet still gets a sticky answer instead of whatever the pass happened to afford.
const lodSticky = new Map();
// Did the rung asked for one region slot change between two passes while the camera stood
// still? That is the flash: a fetch, an upload, a dispose, and the ground changing shape.
// Logged with the numbers the decision saw, because "it flashed" cannot be fixed from a
// rung histogram - only from which slot changed, when, and against which bill.
const lodLastAsk = new Map();
let lodFlips = 0;
const lodFlipLog = [];
const lodAvg = (cell) => { const s = lodCost.get(cell); return s && s.n ? s.v / s.n : 0; };
const lodCostFor = (cell, rx, rz) => (cell >= 1 && lodStore ? lodStore.costOf(cell, rx, rz) : 0)
  || lodAvg(cell)
  || (lodAvg(LOD_CELL) || 7300) * (LOD_CELL / cell) ** 1.15;   // last fallback: 2.4 M verts / 327 tiles

// Is the baked layer as a whole over its vertex budget? One latch for the pass, not a per-tile
// argument, and it reads what is **drawn** rather than what this pass is billing. Deciding release per
// tile from this pass's arithmetic made the answer depend on which tiles had happened to load, so a
// fine tile that finished loading was the very thing that pushed the running bill past the line and
// got it released, and then the bill fell back and it was fetched again.
let lodRelease = 0;

let lodPasses = 0, lodPassRuns = 0, lodSkipRect = 0;
let passCand = 0, passZero = 0, passPick = 0;
function requestLod() {
  lodPasses++;
  if (!lodActive() || lodIndexPending) return;
  lodPassRuns++;
  const r = lodRequestRect();
  if (!r) { lodSkipRect++; return; }

  // Enter release above 1.5x the budget, leave it below 1.2x: with a single line, a layer sitting
  // exactly on the budget would toggle every pass.
  if (S.lodVerts > 0) {
    if (lodVerts > S.lodVerts * 1.5) lodRelease = 1;
    else if (lodVerts < S.lodVerts * 1.2) lodRelease = 0;
  }

  const [tcx, tcz] = centerChunk();

  // Which rung each tile asks for, decided nearest-first so a budget is spent on the part of the frame
  // the eye is looking at. pickLodCell answers "what would a column of this rung measure on screen";
  // the budget is what stops a world-sized view from taking the fine rung everywhere, which would be
  // 13x the geometry of the coarse one for pixels the eye cannot tell apart.
  // Bill the decision set, not the decision set plus what is already on hand. Seeding with the held total
  // double-counted every held tile, so the vertex budget appeared spent about half-way through the
  // pass - and the seed moves every time a tile streams in or retires. That slid the point where the
  // budget starts refusing the fine rung back and forth between passes, and a handful of tiles near
  // it swapped rungs (fetch the fine one, retire the coarse one, ask for the coarse one again) while
  // the camera stood still: the flash reported at far detail 6.
  let spent = 0;
  lodPicks.length = 0;
  passCand = 0; passZero = 0; passPick = 0;
  lodStore.request(r[0], r[1], r[2], r[3], [tcx >> 5, tcz >> 5], (rx, rz, held, have) => {
    passCand++;
    if (!have.length) { passZero++; return 0; }
    const bx = rx * 32 + 16, bz = rz * 32 + 16;      // chunk coordinates, like the centre above
    // Keyed on the orbit target, not the eye, for the same reason the live far grid is (see
    // `tierDistance`): at a 1200-block pull-back the eye sweeps ~1200 blocks sideways during a drag,
    // so with the eye as the reference every tile's pixel size moved with the gesture and the rungs
    // re-decided mid-pan - the "the far layer where the detail used to be takes a while to come back"
    // report, because the pass kept re-asking for rungs it had just dropped.
    const d = Math.max(64, tierDistance(Math.hypot(bx - tcx, bz - tcz), rig.dist / CH, S.lodAnchor) * CH);
    const px1 = pxPerRad() / d;
    // A rung change costs a fetch, an upload and a dispose, and the answer for a given region slot only
    // has to be good, not newly optimal: remember what was asked here last time and hand that to the
    // chooser as `held`, so a slot whose tile has not arrived yet still gets a sticky answer. The clamp,
    // the blob rule and the vertex budget live in pickLodRung, whose comment explains why the bill must
    // not start from what happens to be on screen right now.
    const pk = `${rx},${rz}`;
    const prevAsk = lodLastAsk.get(pk) ?? 0;
    const rung = pickLodRung(have, px1, {
      minPx: S.lodCellPx, maxPx: S.lodCellMaxPx, maxCell: S.lodMaxCell,
      held: held || lodSticky.get(pk) || 0, spent, budget: S.lodVerts, costFor: lodCostFor,
      rx, rz, release: lodRelease,
    });
    const want = rung.cell;
    spent = rung.spent;
    if (prevAsk && want && prevAsk !== want) {
      lodFlips++;
      if (lodFlipLog.length < 400) lodFlipLog.push({ rx, rz, from: prevAsk, to: want,
        px: +px1.toFixed(3), spent: spent | 0, budget: S.lodVerts | 0, held: held || 0,
        rel: lodRelease, cost: lodStore ? lodStore.costOf(want, rx, rz) | 0 : 0 });
    }
    if (want) lodLastAsk.set(pk, want);
    lodSticky.set(pk, want);
    if (lodSticky.size > 20000) lodSticky.clear();   // a world-sized sweep; keep the map to one screenful
    if (lodPicks.length < 40) lodPicks.push({ rx, rz, px: +px1.toFixed(3), held, want, avail: have.join('/'), spent: spent | 0 });
    passPick++;
    return want;
  });
  for (const t of lodStore.tiles.values()) {
    const s = lodCost.get(t.cell) ?? { n: 0, v: 0 };
    s.n++; s.v += t.verts; lodCost.set(t.cell, s);
  }

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

  let n = 0, made = 0;

  for (const [k, t] of lodStore.tiles) {

    if (lodMeshes.has(k)) continue;

    // Not a tile count but a vertex count: a fine tile is ~15x the upload of a coarse one, so a cap of
    // "eight tiles" used to mean eight coarse tiles or half a fine one.
    if (n >= 8 || made + t.verts > 3e6 || performance.now() > now + 6) break;

    const g = new THREE.BufferGeometry();

    g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));

    g.setAttribute('color', new THREE.Uint8BufferAttribute(t.col, 4, true));

    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, lodMatFor());

    mesh.name = 'lod';
    mesh.userData.tile = k;                  // so a ray can say which baked tile painted this pixel

    mesh.position.y = LOD_Y_BIAS;
    pinStatic(mesh);                       // the bias is written once, not recomputed per frame
    mesh.renderOrder = -1;

    lodGroup.add(mesh);

    lodMeshes.set(k, { mesh, verts: t.verts });
    made += t.verts;

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

  return { rx, rz, held: !!t, cell: t ? t.cell : 0,
    drawn: !!(t && lodMeshes.has(lodStore.key(rx, rz))), verts: t ? t.verts : 0,

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
// How many frames threw since boot. The catch in `frame()` keeps the viewer alive, but the rest of that
// frame - the render included - is gone, and since M13 hid the HUD nothing on screen says so. A pan
// measurement on a page throwing every inline patch cut looked healthy and was not: `frameError` was set
// and nobody read it. Probes assert this is 0.
let frameErrors = 0;
const frameErrorKinds = new Set();   // console.error per frame floods the CDP console and buries the probe
function frame(now) {
  try { frameBody(now); }
  catch (e) {
    frameErrors++;
    frameError = String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 400);
    if (frameErrorKinds.size < 8 && !frameErrorKinds.has(frameError.slice(0, 120))) {
      frameErrorKinds.add(frameError.slice(0, 120));
      console.error(e);
    }
    if (hud) hud.msg.textContent = 'frame error: ' + e;
    // The pill is the only readout that is always on screen, so a broken frame has to be visible there.
    if (hud && hud.fps) hud.fps.textContent = `!${frameErrors}`;
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
  // Above the camera and above the layer policy, because both measure the picture in pixels: a new
  // drawing buffer has to be the size the rest of this frame believes it is.
  takeRes();
  pT = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // A clamped frame time: tabbing back in after a two minute pause must not throw a body through the
  // floor. The integration itself runs at a fixed substep inside shared/player.mjs.
  stepKeys(walk.on ? Math.min(dt, walk.fly ? 0.25 : 0.05) : dt);
  // A body that cannot see its own column waits rather than guesses, and that is worth a line on
  // screen, because it looks exactly like a stuck game until the bytes arrive.
  if (walk.on && !walk.fly) {
    if (walk.frozenFrames > 20) hud.msg.textContent = 'waiting for the world under your feet to load, rather than falling through it';
    else if (hud.msg.textContent.startsWith('waiting for the world')) hud.msg.textContent = '';
  }
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
  hoverPass(now);
  lap('hover');
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
  // The coverage listing ages on both ends: the server re-reads its directory after 30 s, and a
  // region file that appears later has to stop being a hole in the page's answer too.
  groundMaybeRefresh(now);
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

  if (S.shellOn) demoteOutsideRing(now);
  // The store evicts on its own schedule; once a second is often enough to notice that a parked
  // mesh's payload has gone away, and rarely enough that walking the map is free.
  if (now - lastBytesSweep > 1000) { lastBytesSweep = now; sweepMeshBytes(); }
  lap('demote');

  // M12b: playing moves the calendar, and the mesh follows with a draw range. This is the only
  // per-frame work the time machine does - one binary search over the filtered seconds and one
  // setDrawRange. Re-cutting the mesh is a filter change, never a frame.
  if (S.timePlay) { timeStep(dt); if (S.timePlay && panel && !panel.busy()) panel.refresh(); } lap('time');
  verts = 0; tris = 0; drawn = 0; detailVerts = 0;
  recomputeAgg();
  for (const list of meshLists()) {
    for (const { mesh } of list) {
      const a = mesh.geometry.attributes.position, ix = mesh.geometry.index;
      verts += a.count; tris += (ix ? ix.count : a.count) / 3; drawn++; detailVerts += a.count;
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
    hud.fps.textContent = lastFps.toFixed(0) + (frameErrors ? ` !${frameErrors}` : '');
    // A blurry picture is usually a resolution decision rather than a rendering decision, so the
    // pill says when the picture is not the screen's own pixels.
    if (hud.scale) {
      const k = resWanted() / DPR_CAP;
      hud.scale.textContent = Math.abs(k - 1) < 0.02 ? '' : '\u00d7' + (+k.toFixed(2));
    }
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

// Who owns the drawing-buffer key: the two places that can change the buffer's size (takeRes, through
// setPixelRatio, and resize, through setSize) both consult it, so a change that ends in the same buffer
// is not counted and not paid for.
let lastResKey = '', resDir = 0, resChanges = 0;
// And *when* it reallocates. `setSize` throws away the drawing buffer along with what is in it, so a
// change made after this frame has been drawn leaves an empty buffer to be composited: a black frame,
// once per decision, and at the old controller's rate that is what "my screen flashes black every few
// seconds" is. A wanted size is therefore a request, and the top of `frameBody` pays for it before
// anything is drawn - so the frame a viewer ever sees is a painted one.
let resDue = false;

// The governor's output is a reallocating change, and a realloc empties the drawing buffer: one frame
// of black. The old controller walked a continuous multiplier (x0.9 down, x1.06 up) as often as every
// 2.5 s, and a load that sits near the target band walks it down and then straight back up - which is
// a black flash every few seconds, each one followed by the tens of milliseconds the realloc costs.
// Three changes: a short ladder instead of a continuous multiplier, a wider dead band, and a lock - if
// it is caught undoing itself twice, it stops moving and says so. A stopped picture beats a marginally
// better target that flickers.
const RES_LADDER = [1, 0.85, 0.72, 0.61, 0.5];
const RES_GAP_MS = 2500;         // least time between two decisions
const RES_UP_HOLD_MS = 8000;     // a shrink may be undone this soon at the earliest
const RES_FLIP_MS = 30000;       // two shrink-after-climb events in this window = it cannot settle
let resRung = 0, resDroppedAt = 0, resClimbedAt = 0, resFlips = 0, resLocked = false;
// Anyone who changes the picture by hand (the draw-resolution row, setRes) owns the ladder now, so the
// governor starts over: leaving rung 3 armed while the user put the multiplier back to 1 is how a
// manual change ends up undone by the next automatic step.
function resetResGovernor() {
  resRung = 0; resAuto = RES_LADDER[0]; resDroppedAt = resClimbedAt = 0;
  resFlips = 0; resLocked = false; resDir = 0;
}

function applyRes() { resDue = true; }

// Only `frameBody` calls this. Everything else asks for a new picture and lets the frame boundary
// decide when it is paid for.
function takeRes() {
  if (!resDue) return false;
  resDue = false;
  const pr = resWanted();
  // `setPixelRatio` reallocates the buffer by itself (three.js calls setSize inside it), and the old
  // path then called setSize a second time for the same CSS size: two emptied buffers and two
  // reallocations per decision, the second one buying nothing at all. Ask once, and write down the
  // size that ask produced, so `resize` below sees it as already paid for.
  if (Math.abs(renderer.getPixelRatio() - pr) > 1e-4) {
    renderer.setPixelRatio(pr);
    lastResKey = `${Math.floor(innerWidth * pr)}x${Math.floor(innerHeight * pr)}`;
    resChanges++;
  }
  resize();                       // camera and projection follow; a window move still reallocates
  return true;
}

function tuneRes(now, force = false) {
  if (!S.resAuto || !timerExt || params.get('view') === 'flat') return;
  // Waiting on the network or on meshing threads is not the graphics card's fault, and shrinking the
  // picture would not help. The far grid counts too: while patches are waiting or being cut, the frame
  // is spent building terrain, and a resolution change in the middle of that is a buffer reallocation
  // on top of the work that was already late.
  if (!force && (store.inflight || store.queue.length || store.dirty.size || jobs.size
    || dirtyPatches.size || patchInflight)) return;
  // Neither is being CPU-bound: `total - render` is our own work, and while it is large the frame is
  // spent meshing, not drawing.
  const w = profWindow();
  if (!force && w.total - w.render > (1000 / S.targetFps) * 0.5) return;
  if (gpuSamples === 0 || now - resTuneAt < RES_GAP_MS) return;
  if (resLocked) return;
  const want = 1000 / S.targetFps;
  // Two readings in the same direction, and at least 2.5 s apart. A single noisy sample used to be
  // enough to resize the picture, and the resize is the expensive part, not the decision. The dead band
  // is wide on purpose: 0.85/0.55 let a frame time that simply oscillates around one rung walk the
  // resolution down and back up forever.
  const dir = gpuMs > want * 0.85 ? -1 : (gpuMs < want * 0.45 ? 1 : 0);
  if (dir !== resDir) { resDir = dir; return; }
  if (dir === 0) return;
  resTuneAt = now;
  if (dir < 0) {
    if (resRung >= RES_LADDER.length - 1) { resDir = 0; return; }
    // Shrinking again shortly after a climb is the flap itself, not two separate corrections.
    if (resClimbedAt && now - resClimbedAt < RES_FLIP_MS && ++resFlips >= 2) {
      resLocked = true; resDir = 0; return;
    }
    resRung++;
    resDroppedAt = now;
  } else {
    if (resRung <= 0) { resDir = 0; return; }
    // The frame that looks cheap right after a shrink is the shrink. Give it time to be the fix.
    if (now - resDroppedAt < RES_UP_HOLD_MS) return;
    resRung--;
    resClimbedAt = now;
  }
  resAuto = RES_LADDER[resRung];
  applyRes();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  // setSize reallocates the drawing buffer, the depth buffer and the mip tree - tens of milliseconds on
  // a software GL, and a CPU profile of a pan showed WebGLRenderer.setSize at 29% of the render
  // thread's busy samples while auto-res re-decided the picture every second. Only pay for a change.
  // The key is the buffer this call would ask for, in device pixels - not the CSS size and not the
  // ratio string. Two ratios that floor to the same buffer are the same picture, and a key that
  // mentions the ratio counts them as two changes: two reallocations, two emptied buffers.
  const pr = renderer.getPixelRatio();
  const key = `${Math.floor(w * pr)}x${Math.floor(h * pr)}`;
  if (key !== lastResKey) { lastResKey = key; resChanges++; renderer.setSize(w, h, false); }
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


// ---- M12: the ledger - who placed this, and can I find it ---------------------------------------
// Three questions, three different costs:
//   "where has anyone built?"   one request for the dimension's sparse cell table, then a decal mesh
//   "who touched this block?"   one request for that chunk's rows, narrowed to the clicked block here
//   "where should I go?"        a ranked tour of those cells, one stop per press
// None of them ships the 30 MB log to the browser, and none of them runs per frame: the overlay is
// static geometry that only the filters re-cut. The server side of it is tools/ledger-export.py,
// server/bake-ledger.mjs and server/ledger-service.mjs; the format is shared/ledger-pack.mjs.
const LEDGER = {
  meta: null,            // /ledger/meta, or { available: false, why } - the panel says which
  pack: null,            // this dimension's cell table: readPack() of /ledger/cells
  gen: 0,                // bumped on a dimension change, so a late answer is dropped, not installed
  mesh: null, pin: null,
  cells: [], max: 0, quads: 0, noHeight: 0, dropped: 0,
  bytes: 0, fetchMs: 0, buildMs: 0,
  top: null, topIdx: 0,  // the "find the bases" tour
  card: null, cardRows: 0, cardTotal: 0,
  err: '', asks: 0, askWhy: '',
  // What the LAST click query got back from the wire, so a probe can check the answer rather than the
  // sentence drawn over it: `nearAt` is the number that says "this voxel really is in the log".
  last: null,
};

// Deliberately not inside `groups`: pickState raycasts those to answer "what block is under the
// cursor", and an overlay that answered that question would replace the world under the cursor.
const ledgerGroup = new THREE.Group();
ledgerGroup.name = 'ledger';
scene.add(ledgerGroup);

// One material for the whole heat layer, because the colour lives per corner: 20,322 decal quads stay
// one draw call. depthTest is the X-ray switch - paint through the world, or sit on the ground and be
// hidden by the hill in front of it.
let ledgerHeatMat = null, ledgerPinMat = null;
function ledgerMat() {
  if (!ledgerHeatMat) {
    ledgerHeatMat = new THREE.MeshBasicMaterial({
      // FrontSide, not DoubleSide: the decals face up, and 20,322 of them painted twice over a
      // whole-world frame is a fill bill the overlay does not need.
      vertexColors: true, transparent: true, opacity: S.decalOp, side: THREE.FrontSide,
      depthWrite: false, fog: false,
    });
  }
  // Strength is a setting, not a constant: a 20,322-tile sheet at 0.55 is a floor of paint over the
  // world it describes, and the complaint from anyone who turned it on was that they could not see.
  ledgerHeatMat.opacity = S.decalOp;
  ledgerHeatMat.depthTest = !S.ledgerXray;
  return ledgerHeatMat;
}
function pinMat() {
  if (!ledgerPinMat) {
    ledgerPinMat = new THREE.LineBasicMaterial({
      color: new THREE.Color().setRGB(1, 0.82, 0.4, THREE.SRGBColorSpace),
      transparent: true, opacity: 0.85, depthTest: false, fog: false,
    });
  }
  return ledgerPinMat;
}

// The small JSON that says whether this world has a ledger at all - and the player list the panel's
// "who" menu is built from. Asked at boot even when the overlay is off, because a control whose choices
// arrive later is a control that silently offers one choice.
async function ledgerMetaLoad() {
  try {
    LEDGER.meta = await fetch('/ledger/meta').then((r) => r.json());
  } catch (e) {
    LEDGER.meta = { available: false, why: `/ledger/meta: ${e.message}` };
  }
  return LEDGER.meta;
}

const ledgerDimInfo = (dim) => (LEDGER.meta?.dims ?? [])
  .find((d) => d.dimId === dim || d.dimKey === dim) ?? null;

/** Fetch this dimension's cell table. Once per dimension: the filters never need another request. */
async function ledgerLoad() {
  const gen = ++LEDGER.gen;
  LEDGER.pack = null; LEDGER.cells = []; LEDGER.max = 0; LEDGER.quads = 0;
  LEDGER.top = null; LEDGER.topIdx = 0; LEDGER.err = '';
  clearLedgerMesh();
  if (!LEDGER.meta) await ledgerMetaLoad();
  if (gen !== LEDGER.gen) return null;                     // the dimension changed under this request
  if (!LEDGER.meta?.available) { LEDGER.err = LEDGER.meta?.why ?? 'no ledger'; return null; }
  const dim = currentDim();
  if (!ledgerDimInfo(dim)) { LEDGER.err = 'the ledger has no rows for this dimension'; return null; }
  const t0 = performance.now();
  let buf;
  try {
    const res = await fetch(`/ledger/cells?dim=${encodeURIComponent(dim)}`);
    if (!res.ok) { LEDGER.err = `/ledger/cells: HTTP ${res.status}`; return null; }
    buf = await res.arrayBuffer();
  } catch (e) { LEDGER.err = `/ledger/cells: ${e.message}`; return null; }
  if (gen !== LEDGER.gen) return null;
  try {
    LEDGER.pack = readPack(new Uint8Array(buf));   // readPack wants a byte view, not a fetched ArrayBuffer
  } catch (e) {
    // A pack this reader cannot parse is a re-bake, not an empty world: say which.
    LEDGER.err = `ledger index: ${e.message} (re-run node server/bake-ledger.mjs)`;
    return null;
  }
  LEDGER.bytes = buf.byteLength;
  LEDGER.fetchMs = performance.now() - t0;
  ledgerRebuild();
  return LEDGER.pack;
}

function clearLedgerMesh() {
  for (const k of ['mesh', 'pin']) {
    const m = LEDGER[k];
    if (m) { ledgerGroup.remove(m); m.geometry.dispose(); LEDGER[k] = null; }
  }
  LEDGER.quads = 0;
}

/** Re-cut the overlay from the table already in memory: a filter change is a rebuild, not a download. */
function ledgerRebuild() {
  clearLedgerMesh();
  if (S.ledger && LEDGER.pack) {
    const t0 = performance.now();
    const got = collectCells(LEDGER.pack, { cls: S.ledgerCls, player: S.ledgerWho, minN: S.ledgerMin });
    LEDGER.cells = got.cells; LEDGER.max = got.max;
    LEDGER.noHeight = got.noHeight; LEDGER.dropped = got.dropped;
    const g = buildHeatQuads(got.cells, { inset: heatInset() });
    if (g.quads) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(g.col, 3));
      // Four corners and six indices a chunk, the same layout as the detail meshes - and the index goes
      // on the geometry, never as an attribute (9.8a: `geometry.attributes.index` is undefined in
      // three.js, and an unindexed four-corners-a-quad buffer is drawn as a strip).
      geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
      const mesh = new THREE.Mesh(geo, ledgerMat());
      mesh.name = 'ledger-heat';
      mesh.renderOrder = 900;
      // One mesh spanning a whole dimension: its own bounding sphere is the world, so per-object
      // frustum culling here could only be wrong.
      mesh.frustumCulled = false;
      ledgerGroup.add(mesh);
      LEDGER.mesh = mesh;
      LEDGER.quads = g.quads;
    }
    LEDGER.buildMs = performance.now() - t0;
  }
  // Markers are ranked from the same cells the picture is painted from, so a filter change re-cuts
  // them with it and the two cannot disagree. Switching the heat layer off leaves them standing:
  // "markers only" is a state the panel offers on purpose, and Escape is what dismisses them.
  ledgerDrawPins();
  if (panel) panel.refresh();
}

// Cages over the chunks the tour picked. Lines, not boxes: a marker has to survive 10 km of distance
// without costing fill, and four corner lines still read as a column where one centre line does not.
function ledgerDrawPins() {
  if (LEDGER.pin) { ledgerGroup.remove(LEDGER.pin); LEDGER.pin.geometry.dispose(); LEDGER.pin = null; }
  if (!LEDGER.top) return;
  // 28 blocks, not 64: measured against the frame, a 64-block cage is a maypole that reads as taller
  // than the trees around it and hides the chunk it is marking. 28 still clears a canopy.
  const b = buildPins(LEDGER.top, { height: 28 });
  if (!b.verts) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
  const seg = new THREE.LineSegments(geo, pinMat());
  seg.name = 'ledger-pins';
  seg.renderOrder = 901;
  seg.frustumCulled = false;
  ledgerGroup.add(seg);
  LEDGER.pin = seg;
}

/**
 * "Can I find it": rank the chunks the log touched and start a tour.
 *
 * Ranked from the cells already painted rather than from GET /ledger/top, so the tour cannot disagree
 * with the picture on screen - and the endpoint stays what it is: the same query for a page (or a
 * probe) that does not hold the table.
 */
function ledgerFind() {
  if (!LEDGER.pack) return null;
  if (!LEDGER.cells.length) {
    const got = collectCells(LEDGER.pack, { cls: S.ledgerCls, player: S.ledgerWho, minN: S.ledgerMin });
    LEDGER.cells = got.cells; LEDGER.max = got.max;
  }
  LEDGER.top = rankCells(LEDGER.cells, 12);
  LEDGER.topIdx = 0;
  ledgerDrawPins();
  if (!LEDGER.top.length) { showLedger('nothing in this dimension matches those filters'); return null; }
  showHotspotCard(LEDGER.top, LEDGER.cells.length);
  ledgerJump();
  return { total: LEDGER.cells.length, cells: LEDGER.top };
}

/**
 * The panel buttons. The index is a request, and a button that reads `LEDGER.pack` before it has
 * arrived answers nothing at all - which is exactly how the first version of these two buttons failed.
 */
async function ledgerTour(withHeat) {
  if (withHeat) S.ledger = 1;
  if (!LEDGER.pack) await ledgerLoad();
  if (!LEDGER.pack) { showLedger(`no ledger index for this dimension: ${LEDGER.err || LEDGER.meta?.why || 'unknown'}`); return null; }
  return ledgerFind();
}

/** How many players are in a cell's bit mask - the card says "all six", not "mask 63". */
const maskCount = (m) => { let n = 0; for (let v = m | 0; v; v &= v - 1) n++; return n; };

/** One tour stop: fly to the loudest chunk left, and say what it is. */
function ledgerJump() {
  const c = LEDGER.top?.[LEDGER.topIdx];
  if (!c) return null;
  LEDGER.topIdx = (LEDGER.topIdx + 1) % LEDGER.top.length;
  const x = c.cx * 16 + 8, z = c.cz * 16 + 8;
  gotoLedger(x, (c.y ?? 64) + 3, z, 110);
  showLedger(`hotspot ${LEDGER.topIdx}/${LEDGER.top.length}: chunk ${c.cx},${c.cz} - ${c.n.toLocaleString()} actions`);
  return c;
}

/**
 * Move the view - or the body, when walking - to a place the ledger named. In walk mode the body owns
 * position, so the answer is to drop the body there and let the voxels put its feet on ground, exactly
 * as `?goto=` does.
 */
function gotoLedger(x, y, z, dist = 48) {
  if (walk.on) {
    player.x = x; player.z = z; player.y = y; player.vy = 0;
    walk.placed = 0; walk.embedded = 0;
    dropToClear(cellAt, player);
    syncEye();
    standPlayer(8);
  } else {
    rig.target.set(x, y, z);
    rig.dist = Math.max(8, Math.min(S.maxZoom, dist));
  }
  lastCx = null; lastCz = null; lastDb = -1;
  updateCamera(); updateView(); requestAround();
}

/**
 * "Who placed this." The chunk is the unit the index is built around, so a block question is answered
 * by fetching that chunk's rows (oldest first, capped) and picking the block out of them here - which
 * is one binary search and a couple of kilobytes, not a scan of 424,599 rows.
 */
function ledgerAsk(x, y, z) {
  if (!LEDGER.meta?.available) { showLedger(`no ledger: ${LEDGER.meta?.why ?? 'not asked for'}`); return null; }
  const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4;
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  // `near` is the whole point of this query: a chunk can hold thousands of rows, and asking for the
  // chunk's first 200 used to answer a click on row 2,000 with "no row touches here".
  const url = `/ledger/rows?dim=${encodeURIComponent(currentDim())}&cx=${cx}&cz=${cz}`
    + `&cls=${S.ledgerCls}&player=${S.ledgerWho}&limit=${S.ledgerRows}&near=${bx},${by},${bz}`;
  LEDGER.asks++;
  return fetch(url).then((r) => {
    if (!r.ok) { showLedger(`/ledger/rows: HTTP ${r.status}`); return null; }
    return r.json();
  }).then((out) => {
    if (!out) return null;
    LEDGER.last = {
      voxel: [bx, by, bz], chunk: [cx, cz],
      total: out.total ?? 0, shown: (out.rows ?? []).length, scanned: out.scanned ?? null,
      nearAt: out.nearAt ?? null, nearMax: out.nearMax ?? null, truncated: !!out.truncated,
    };
    const here = nearRows(out.rows ?? [], bx, by, bz, S.ledgerNear);
    showLedgerCard({ block: [bx, by, bz], rows: here, out });
    return { here: here.length, shown: (out.rows ?? []).length, total: out.total };
  }).catch((e) => { showLedger(`/ledger/rows: ${e.message}`); return null; });
}

/**
 * The voxel a timeline row describes. A row carries a chunk INDEX plus a packed local coordinate, so
 * answering "where is this change" needs the pack's chunk table - and it must NOT be answered by looking
 * at what stands there today: a break marks a voxel that is empty now, and a place under a playhead that
 * has taken the block back is empty too.
 */
function timeRowWorld(row) {
  const tl = TLAYER.tl;
  const c = LEDGER.pack?.cell?.(tl.cellOf(row));
  if (!c) return null;
  return [c.cx * 16 + tl.x(row), tl.y(row), c.cz * 16 + tl.z(row)];
}

/**
 * Does the pixel land on the time layer, and on which logged change?
 *
 * The time layer is deliberately not in `groups` (nothing else should raycast the overlay), which is why
 * a click on a marker used to fall straight through to the terrain behind it and ask about a voxel the
 * pointer was never on. three honours `geometry.drawRange` in its raycast, so a marker the playhead has
 * not reached yet cannot be hit - the answer is about what is on screen, not about the whole buffer.
 */
function timeHitAt(x, y) {
  if (!TLAYER.mesh || !TLAYER.mesh.visible || !TLAYER.tl) return null;
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  rc.far = Math.max(64, scene.fog ? scene.fog.far : Infinity);
  const t0 = performance.now();
  const hit = rc.intersectObject(TLAYER.mesh, false)[0];
  TLAYER.hitMs = performance.now() - t0;          // 42 ms on a whole-dimension buffer: a click's cost
  if (!hit) return null;
  // One triangle per face of a marker: the geometry is indexed, and a flat tile is one quad = 6 indices.
  const q = hit.faceIndex;
  let row = -1, item = -1;
  // `quadRow` is the row mapping for BOTH looks, and `markerEnd` only exists when an item is bigger than
  // one quad. Naming them separately (markerRow) once made this read an undefined array.
  if (TLAYER.markerEnd) {
    // A triangle is 3 indices and a quad is 2 triangles, so a hit triangle sits at quad*6 = floor(q/2)*6
    // in the index buffer. Asking with q*6 asks at twice the offset and returns a marker further along
    // the buffer: the probe saw a ray aimed at row 350222 answer row 301547.
    item = markerOfIndex(TLAYER.markerEnd, Math.floor(q / 2) * 6);
    if (item >= 0) row = TLAYER.quadRow?.[item] ?? -1;
  } else {
    row = TLAYER.quadRow?.[Math.floor(q / 2)] ?? -1;   // a flat tile is 2 triangles, so halve the triangle
  }
  if (row < 0) return null;
  const xyz = timeRowWorld(row);
  if (!xyz) return null;
  return { row, item, xy: [x, y], voxel: xyz, sec: TLAYER.tl.sec[row], action: TLAYER.tl.action[row],
    look: TLAYER.look, point: [+hit.point.x.toFixed(2), +hit.point.y.toFixed(2), +hit.point.z.toFixed(2)] };
}

/**
 * What a click (or T) should ask about at a screen point. A marker wins over the terrain behind it,
 * because the thing a person pointed at is the thing they can see.
 *
 * The `/ledger/meta` fetch happens here rather than behind the overlay checkbox: clicking a block is an
 * entry point of its own, and a page that never turned on an overlay used to answer the click with
 * nothing at all - which is exactly the report this replaces.
 */
async function askAt(x, y) {
  if (!LEDGER.meta) await ledgerMetaLoad();
  if (!LEDGER.meta?.available) {
    LEDGER.askWhy = `no ledger: ${LEDGER.meta?.why ?? 'this world has no log'}`;
    showLedger(`no ledger: ${LEDGER.meta?.why ?? 'this world has no log'}`);
    return null;
  }
  const t = timeHitAt(x, y);
  if (t) { LEDGER.askWhy = `the ${TLAYER.look} marker for row ${t.row}`; return ledgerAsk(t.voxel[0], t.voxel[1], t.voxel[2]); }
  const p = pickState(x, y);
  if (!p || !p.block) { LEDGER.askWhy = 'the pixel hit no drawn block'; closeLedgerCard(); return null; }
  LEDGER.askWhy = `${p.drawn ?? 'detail'} block ${p.block.join(', ')}`;
  return ledgerAsk(p.block[0], p.block[1], p.block[2]);
}

/** T: ask about the middle of the screen - the crosshair when walking, the orbit target otherwise. */
function ledgerAskCentre() { return askAt(innerWidth / 2, innerHeight / 2); }

/**
 * Debug/probe: find a pixel that IS a drawn marker, without guessing at coordinates. Projects the most
 * recently drawn changes into the viewport, takes the one nearest the middle, and confirms it with the
 * same raycast a click uses. Cheap on purpose: a screen-grid sweep would ray-scan a 3.3 M-index buffer
 * hundreds of times.
 */
function timeHitProbe(limit = 600) {
  if (!TLAYER.mesh || !TLAYER.mesh.visible || !TLAYER.tl) return { ok: 0, why: 'no time layer on screen' };
  const items = TLAYER.quadRow;
  const n = Math.min(items?.length ?? 0, TLAYER.drawn);
  if (!n) return { ok: 0, why: 'the playhead has drawn nothing' };
  updateCamera();
  const v = new THREE.Vector3();
  // A candidate must be somewhere a CLICK could actually land. `project()` happily hands back an on-screen
  // pixel for a point BEHIND the eye (the perspective divide flips both signs), and this timeline spans
  // 19 km of world, so the first version of this probe "found" a change 12 km the wrong way round and
  // then reported the honest marker under that pixel as a mismatch.
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const far = Math.max(64, scene.fog ? scene.fog.far : Infinity);
  let best = null;
  for (let k = n - 1; k >= (limit > 0 ? Math.max(0, n - limit) : 0); k--) {
    const row = items[k];
    const xyz = timeRowWorld(row);
    if (!xyz) continue;
    v.set(xyz[0] + 0.5, xyz[1] + 0.5, xyz[2] + 0.5);
    const off = v.clone().sub(eye);
    if (off.dot(fwd) < 4 || off.lengthSq() > far * far) continue;
    v.project(camera);
    if (v.z > 1 || v.z < -1) continue;
    const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
    if (sx < 8 || sy < 8 || sx > innerWidth - 8 || sy > innerHeight - 8) continue;
    const d = (sx - innerWidth / 2) ** 2 + (sy - innerHeight / 2) ** 2;
    if (d > 90 * 90) continue;      // somewhere a person would plausibly click
    const dist = off.length();
    // Prefer the CLOSEST such marker. Among tens of thousands of drawn changes the middle of the view can
    // hold a change 12 km away as easily as one 20 blocks away, and a ray at that pixel answers with
    // whatever is nearest the eye - so aim where the ray and the expectation agree.
    if (!best || dist < best.dist) best = { dist, d, xy: [Math.round(sx), Math.round(sy)], row, xyz };
  }
  if (!best) return { ok: 0, why: 'no drawn marker projects inside the viewport', drawn: n };
  const t = timeHitAt(best.xy[0], best.xy[1]);
  if (!t) return { ok: 0, why: 'no marker under that pixel', drawn: n, probe: best.xy, expects: best.row };
  // The property worth asserting is NOT "the ray found the item whose CENTRE we projected": with tens of
  // thousands of markers drawn, whatever owns a pixel is the one closest to the eye, and the centre of a
  // further marker can land on the same pixel. It is that the answer a click got describes the pixel it
  // was aimed at - so project the ANSWER's voxel and see where it lands.
  v.set(t.voxel[0] + 0.5, t.voxel[1] + 0.5, t.voxel[2] + 0.5).project(camera);
  const hx = (v.x * 0.5 + 0.5) * innerWidth, hy = (-v.y * 0.5 + 0.5) * innerHeight;
  return { ok: 1, drawn: n, probe: best.xy, expects: best.row, voxel: best.xyz, distance: Math.round(Math.hypot(
    best.xyz[0] - eye.x, best.xyz[1] - eye.y, best.xyz[2] - eye.z)),
    hit: { row: t.row, item: t.item, voxel: t.voxel, sec: t.sec, action: t.action, point: t.point },
    hitPixel: [Math.round(hx), Math.round(hy)],
    offPx: Math.round(Math.hypot(hx - best.xy[0], hy - best.xy[1])),
    hitDrawn: t.item < n, same: t.row === best.row };
}

// ---- the cursor's outline ------------------------------------------------------------------------
// "Which block am I pointing at?" needs an edge, not a colour: tint the block and you have hidden the
// block. So this is a wire box around the one voxel the cursor is on, drawn twice - a pale outer edge
// and a dark inner one - because a single-colour outline disappears on either bright grass or dark
// deepslate. One geometry, two LineSegments, reused every pass: a highlight that allocates per hover is
// a hitch per hover, and this viewer has already been told about those.
let hoverBox = null;
const HOVER = { at: null, from: '', changes: 0, why: '', ms: 0, last: 0, passes: 0, skips: 0, boxMs: 0 };
let pointerXY = null, pointerOut = false, pointerDown = false;
let hoverSig = '', hoverDirty = true;
canvas.addEventListener('pointermove', (e) => { pointerXY = [e.clientX, e.clientY]; pointerOut = false; hoverDirty = true; });
canvas.addEventListener('pointerleave', () => { pointerOut = true; });
canvas.addEventListener('pointerdown', () => { pointerDown = true; });
addEventListener('pointerup', () => { pointerDown = false; hoverDirty = true; });

/** Cheap stand-in for "did the picture change": the camera's own pose, to two decimal places. */
function camSig() {
  const p = camera.position, q = camera.quaternion;
  return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}|${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}`;
}

function hoverBoxOf() {
  if (hoverBox) return hoverBox;
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));   // 12 edges, once
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(edges.attributes.position.array, 3));
  edges.dispose();
  const grp = new THREE.Group();
  const pale = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0xf4f7fa, transparent: true, opacity: 0.7, depthTest: true, fog: false }));
  const dark = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0x0a0b0d, depthTest: true, fog: false }));
  // Inflated a hair rather than exactly on the voxel: coplanar lines over coplanar faces z-fight, and
  // this is the same contest the marker layer's polygonOffset exists to settle.
  pale.scale.setScalar(1.024);
  dark.scale.setScalar(1.006);
  pale.renderOrder = 948; dark.renderOrder = 949;                          // over every world layer
  pale.frustumCulled = dark.frustumCulled = false;
  grp.add(pale); grp.add(dark);
  grp.name = 'hover';
  grp.visible = false;
  scene.add(grp);
  hoverBox = grp;
  return grp;
}

/**
 * Does the drawn change set touch this voxel, and how many times?
 *
 * The other way to answer that is a raycast against the marker buffer, and that buffer can hold 3.3 M
 * indices: measured 42 ms a hit, which a click can afford and a hover loop running ten times a second
 * cannot. Two Map lookups answer the same question, and they are exact, because rows are stored in time
 * order so a row is on screen exactly when its quad position sits below TLAYER.drawn.
 */
function timeDrawnAt(x, y, z) {
  if (!TLAYER.tl || !TLAYER.drawn) return null;
  const ci = HIST.cellsAt?.get(`${Math.floor(x) >> 4},${Math.floor(z) >> 4}`);
  if (ci === undefined) return null;
  const g = timeVoxelIndex();
  if (!g) return null;
  const list = g.get(voxelKey(ci, tlPackCoord(Math.floor(x) & 15, Math.floor(y), Math.floor(z) & 15)));
  if (!list) return null;
  let n = 0, last = -1;
  for (const q of list) if (q < TLAYER.drawn) { n++; last = q; }
  return n ? { n, row: TLAYER.quadRow?.[last] ?? -1, sec: TLAYER.quadSec?.[last] ?? 0 } : null;
}

/**
 * The voxel under a screen point, and how many drawn changes sit on it.
 *
 * The outline follows the drawn world rather than the marker buffer on purpose: the marker raycast costs
 * 42 ms, and an outline that hitches the frame every 90 ms is a worse highlight than no outline. A click
 * still asks the marker buffer, because one 42 ms click is nothing next to an answer the user asked for.
 */
function hoverVoxel(x, y) {
  const p = pickState(x, y);
  if (!p || !p.block) return null;
  const t = S.time ? timeDrawnAt(p.block[0], p.block[1], p.block[2]) : null;
  return { voxel: p.block, from: p.drawn ?? 'detail', changes: t ? t.n : 0, row: t ? t.row : -1 };
}

/** One pass per `hoverMs`, from the frame loop. Cheap when the cursor has not moved and nothing moved. */
function hoverPass(now) {
  const g = hoverBoxOf();
  if (!S.hover) { g.visible = false; HOVER.at = null; HOVER.why = 'off'; return; }
  // Walking keeps the question at the crosshair, because that is where the cursor is locked.
  const xy = walk.on ? [Math.round(innerWidth / 2), Math.round(innerHeight / 2)] : pointerXY;
  if (!xy || (pointerOut && !walk.on)) { g.visible = false; HOVER.at = null; HOVER.why = 'no cursor'; return; }
  if (now - HOVER.last < S.hoverMs) return;
  // A pick costs what a pick costs: measured 17.5 ms at the house framing with 11 M vertices of world
  // geometry under the ray. Running that every 90 ms while nobody and nothing moved is how a highlight
  // turns into the stutter this viewer exists to avoid, and during an orbit drag the cursor is not
  // pointing at anything. So re-pick on movement only - cursor, camera, or the playhead.
  if (pointerDown) { HOVER.skips++; HOVER.why = 'dragging'; return; }
  const sig = camSig();
  // A skip is a decision, so it gets a reason: a stale 'off' left over from the last time the highlight
  // was switched off reads as a setting the viewer never made.
  if (!hoverDirty && sig === hoverSig) { HOVER.skips++; HOVER.why = 'nothing moved'; return; }
  hoverDirty = false; hoverSig = sig;
  HOVER.last = now;
  HOVER.passes++;
  const t0 = performance.now();
  const h = hoverVoxel(xy[0], xy[1]);
  HOVER.ms = performance.now() - t0;
  if (!h) { g.visible = false; HOVER.at = null; HOVER.why = 'nothing under the cursor'; return; }
  HOVER.at = h.voxel;
  HOVER.from = h.from;
  HOVER.changes = h.changes || 0;
  HOVER.why = '';
  g.visible = true;
  g.position.set(h.voxel[0] + 0.5, h.voxel[1] + 0.5, h.voxel[2] + 0.5);
  // The outline takes the place-green of the change layer when a drawn change sits on this voxel, so the
  // wire box and the block it describes read as one thing rather than two coincidences.
  g.children[0].material.color.setHex(h.changes ? 0x6fe08a : 0xf4f7fa);
}

/**
 * Debug: put the outline on a pixel and report what it found, ignoring the throttle. A probe that has to
 * synthesize a pointermove to test a highlight is testing the wrong thing, and the pixel it wants is one
 * a marker happens to be drawn on, which `timeHitProbe` already knows.
 */
function hoverAtPixel(x, y) {
  pointerXY = [x, y]; pointerOut = false; hoverDirty = true; HOVER.last = 0;
  hoverPass(performance.now());
  return { at: HOVER.at, from: HOVER.from, changes: HOVER.changes, ms: +HOVER.ms.toFixed(2),
    visible: !!(hoverBoxOf().visible && S.hover) };
}

function setLedger(on) {
  S.ledger = on ? 1 : 0;
  if (S.ledger && !LEDGER.pack) ledgerLoad();
  else ledgerRebuild();
  if (panel) panel.refresh();
  return !!S.ledger;
}

// ---- the card -----------------------------------------------------------------------------------
// The answer first ("playerA placed this, 2.1 years ago"), the evidence under it. Every evidence line
// is a button, because the next thing a person does after reading who placed a chest is want to stand
// in front of it.
function ledgerCardEl() {
  if (LEDGER.card) return LEDGER.card;
  const el = document.createElement('div');
  el.className = 'lcard';
  document.body.append(el);
  LEDGER.card = el;
  return el;
}

/** Escape: stop drawing what the ledger put there. The ranking stays, so F resumes the same tour. */
function clearLedgerPins() {
  if (!LEDGER.pin) return false;
  ledgerGroup.remove(LEDGER.pin); LEDGER.pin.geometry.dispose(); LEDGER.pin = null;
  return true;
}

function closeLedgerCard() {
  if (!LEDGER.card) return;
  LEDGER.card.remove();
  LEDGER.card = null;
  LEDGER.cardRows = 0; LEDGER.cardTotal = 0;
}

function showLedger(text) {
  hud.msg.textContent = text;
  hud.msg.classList.remove('err');
}

function showLedgerCard({ block, rows, out }) {
  const el = ledgerCardEl();
  el.textContent = '';
  LEDGER.cardRows = rows.length; LEDGER.cardTotal = out.total ?? 0;
  const head = document.createElement('div');
  head.className = 'lcard-head';
  const at = block.join(', ');
  // `nearAt` counts rows sitting on THIS voxel, which is a different claim from the number of rows the
  // card chose to show: a busy chunk returns its nearest `limit` rows, not all of them.
  const exact = out.nearAt ? ` - ${out.nearAt} exactly here` : '';
  head.append(document.createTextNode(
    rows.length
      ? `${rows.length} of ${out.total} ledger rows in chunk ${block[0] >> 4},${block[2] >> 4} touched ${at}${exact}`
      : `no ledger row touches ${at}${out.total ? ` - this chunk holds ${out.total} rows, none within ${S.ledgerNear} blocks` : ''}`));
  const x = document.createElement('button');
  x.className = 'lcard-x'; x.textContent = '\u00d7'; x.title = 'close (Esc)';
  x.addEventListener('click', closeLedgerCard);
  head.append(x);
  el.append(head);
  if (!rows.length) return;
  const s = summarizeRows(rows);
  const sub = document.createElement('div');
  sub.className = 'lcard-sub';
  sub.textContent = `who: ${Object.entries(s.byPlayer).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`
    + `  |  kinds: ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`
    + `  |  ${fmtLedger(s.t0)} .. ${fmtLedger(s.t1)} (${timeAgo(s.t1)})`;
  el.append(sub);
  const note = document.createElement('div');
  note.className = 'lcard-note';
  for (const rw of rows.slice(0, 14)) {
    const line = document.createElement('div');
    line.className = 'lcard-line';
    const b = document.createElement('button');
    b.className = 'lcard-row';
    // Distance from the block that was asked about, not its absolute coordinates: every row here is
    // within a couple of blocks, and printing the same numbers 14 times is what overflows the card.
    b.textContent = rowLine(rw, Date.now(), block);
    b.title = 'go to that block';
    b.addEventListener('click', () => gotoLedger(rw.x + 0.5, rw.y + 1, rw.z + 0.5, 20));
    // The other half of the question. "Who broke this" is a fact about the world as it is; "when did it
    // happen" only means anything to the replay, so it goes to the playhead and the voxel undo, not to the
    // camera, and it stays a separate button because a viewer wants to pick one or the other.
    const s = document.createElement('button');
    s.className = 'lcard-seek';
    s.textContent = '\u23ea';                         // ⏪
    s.title = 'rewind the replay to this change, at this block';
    s.addEventListener('click', () => rewindTo(rw, s, note));
    line.append(b, s);
    el.append(line);
  }
  el.append(note);
  if (rows.length > 14) {
    const m = document.createElement('div');
    m.className = 'lcard-sub';
    m.textContent = `\u2026 ${rows.length - 14} more within ${S.ledgerNear} blocks (oldest first,`
      + ` ${out.total} rows in the chunk, ${S.ledgerRows} fetched)`;
    el.append(m);
  } else if (out.total > rows.length) {
    const m = document.createElement('div');
    m.className = 'lcard-sub';
    m.textContent = `${out.total - rows.length} other rows in this chunk are further away or filtered out`
      + ` (filters: ${S.ledgerCls ? `kind ${S.ledgerCls}` : 'any kind'}, ${S.ledgerWho ? `player ${S.ledgerWho}` : 'anybody'})`;
    el.append(m);
  }
}

/** The tour as a list you can click: the chunks this dimension's ledger touched hardest. */
function showHotspotCard(top, total) {
  const el = ledgerCardEl();
  el.textContent = '';
  LEDGER.cardRows = top.length; LEDGER.cardTotal = total;
  const head = document.createElement('div');
  head.className = 'lcard-head';
  head.append(document.createTextNode(`${top.length} loudest of ${total.toLocaleString()} chunks the ledger touched`));
  const x = document.createElement('button');
  x.className = 'lcard-x'; x.textContent = '\u00d7'; x.title = 'close (Esc)';
  x.addEventListener('click', closeLedgerCard);
  head.append(x);
  el.append(head);
  const sub = document.createElement('div');
  sub.className = 'lcard-sub';
  sub.textContent = `filtered to ${LEDGER_CLASSES.find((c) => c.id === S.ledgerCls)?.name ?? 'every kind'}`
    + ` and ${(LEDGER.meta?.players ?? []).find((p) => p.id === S.ledgerWho)?.name ?? 'anybody'},`
    + ` ${S.ledgerMin}+ rows per chunk - F jumps to the next one`;
  el.append(sub);
  top.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'lcard-row';
    b.textContent = `${String(i + 1).padStart(2)}  chunk ${String(c.cx).padStart(5)},${String(c.cz).padStart(5)}`
      + `  ${c.n.toLocaleString().padStart(6)} actions  ${fmtLedger(c.t0).slice(0, 10)}.. ${fmtLedger(c.t1).slice(0, 10)}`
      + `  ${maskCount(c.mask)} player(s)`;
    b.title = 'stand in front of that chunk';
    b.addEventListener('click', () => { LEDGER.topIdx = i; ledgerJump(); });
    el.append(b);
  });
}

// What the panel says about the ledger, in one line: whether there is one, how big it is, what this
// dimension contributes, and what the last fetch cost. The numbers are the ones the endpoint measured.
function ledgerNote() {
  if (!LEDGER.meta) return 'ledger: not asked for yet';
  if (!LEDGER.meta.available) return `ledger: ${LEDGER.meta.why}`;
  const d = ledgerDimInfo(currentDim());
  if (!d) return `ledger: rows for ${LEDGER.meta.dims.length} other dimensions, none for this one`;
  if (!LEDGER.pack) return `ledger: ${d.rows.toLocaleString()} rows over ${d.cells.toLocaleString()} chunks`
    + ` of this dimension, index not fetched`;
  return `${d.rows.toLocaleString()} rows over ${d.cells.toLocaleString()} touched chunks`
    + ` (${d.first.slice(0, 10)} .. ${d.last.slice(0, 10)})`
    + `  |  ${(LEDGER.bytes / 1024) | 0} KB in ${LEDGER.fetchMs.toFixed(0)} ms,`
    + ` ${LEDGER.cells.length.toLocaleString()} shown re-cut in ${LEDGER.buildMs.toFixed(1)} ms`
    + (LEDGER.dropped ? `, ${LEDGER.dropped} under the floor` : '')
    + (LEDGER.noHeight ? `, ${LEDGER.noHeight} with no baked ground` : '')
    + (LEDGER.err ? `  |  ${LEDGER.err}` : '');
}

const ledgerWhoOptions = () => [
  { value: '0', label: 'anybody (and fire, water, monsters)' },
  ...(LEDGER.meta?.players ?? []).map((p) => ({ value: String(p.id), label: p.name })),
];

// ---- M12b: the time machine -----------------------------------------------------------------------
//
// The heat layer answers "where did things happen". This answers "when". They stay separate layers with
// separate requests because their costs are different shapes: 674 KB of cells for this dimension's 20,322
// touched chunks, against 4.7 MB of rows for its 351,531 logged changes.
//
// The playhead is a DRAW RANGE, not a rebuild. The timeline arrives sorted by time and buildTimeQuads
// emits one quad per row in that order, so moving through two years of history is
// `setDrawRange(0, n * 6)` - measured at 0.3 ms for a thousand moves, against the ~100 ms a
// whole-dimension re-cut costs when a FILTER changes (tests/web-timemachine.test.mjs). Nothing here
// rebuilds geometry per frame, and that is what makes "30 fps through the whole history" a measurement
// rather than a hope.
const TLAYER = {
  tl: null,              // decodeTimeline() of /ledger/timeline for this dimension
  gen: 0,                // bumped on a dimension switch, so a late answer cannot install
  mesh: null,
  quadSec: null,         // the playhead index: one ascending second per drawn quad
  quads: 0, verts: 0, drawn: 0, sec: 0,
  cur: 0,                        // the playhead as a ROW INDEX into the current filter
  quadRow: null,         // which timeline row each drawn quad came from (buildTimeQuads)
  // Block-shaped markers (M12b tier 3) are not quads: a cube is 36 indices, a plant model 12 or 24.
  // itemEnd is the cumulative INDEX count per drawn item, which is what a draw range becomes then;
  // look says what was actually built, and lookWhy says why a requested look was refused.
  itemEnd: null, look: '', lookWhy: '', markerEnd: null,
  voxel: null,           // Map block -> its quads, built on the first click on a block card
  hitMs: 0,              // one raycast of the marker buffer, which is why a hover does not do it
  voxelFrom: null, voxelMs: 0, jumpMs: 0,
  cellsAt: null, cellsPack: null,   // "cx,cz" -> cell index, for a card that names a chunk
  activeDays: 0, busyDay: 0, busyN: 0,   // how much of the calendar the log actually covers
  rows: 0, other: 0, truncated: false,
  freshArm: 0,           // the tick that armed the machine, waiting for its first mesh
  bytes: 0, fetchMs: 0, filterMs: 0, buildMs: 0,
  err: '',
};

let timeDecalMat = null;
function timeMat() {
  if (!timeDecalMat) {
    timeDecalMat = new THREE.MeshBasicMaterial({
      // FrontSide, like the heat layer: these decals face up, and over a whole-dimension history the back
      // faces are pure overdraw - the place set alone is 90,045 quads, the whole log 351,531.
      // Both overlays answer to one strength (`S.decalOp`), because both are flat tiles over the ground
      // and a viewer tunes them together. Inset geometry (S.decalShrink) does the rest: an inset tile
      // leaves the block's own edge visible instead of welding the map into one quilt.
      vertexColors: true, transparent: true, opacity: S.decalOp, side: THREE.FrontSide,
      depthWrite: false, fog: false,
    });
  }
  timeDecalMat.opacity = S.decalOp;
  // Same X-ray switch as the heat layer. A marker standing on a block top is invisible from 3 km away
  // behind a hill, and the time machine is almost always watched from a long way up.
  timeDecalMat.depthTest = !S.ledgerXray;
  return timeDecalMat;
}

let timeBlockMat = null;
/**
 * A marker that is meant to look like the block it marks samples the same atlas the world's own meshes
 * sample. The vertex colour carries the action wash (green for a place, red for a break) times the face
 * shade, so a cube still reads as a solid object rather than a flat sticker; the sprite does the rest.
 *
 * polygonOffset is not decoration. A marker occupies the voxel it describes, so where that block is
 * still standing its faces are COPLANAR with the world's own faces, and coplanar geometry z-fights: the
 * block flickers between its own colour and the wash. A depth bias of a couple of units toward the
 * camera makes the marker win that contest everywhere, at every zoom, with no shadow acne behind it.
 */
function timeBlockMatOf() {
  if (!timeBlockMat) {
    timeBlockMat = new THREE.MeshBasicMaterial({
      map: atlasTex, vertexColors: true, side: THREE.DoubleSide,   // cross-model plants need both faces
      alphaTest: S.alphaTest,                                      // the atlas holds cutout sprites too
      fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
  }
  timeBlockMat.map = atlasTex;                                    // the atlas texture is rebuilt on reload
  timeBlockMat.alphaTest = S.alphaTest;
  // A marker wearing a block's face IS a block, so it obeys walls: a hill in front of it hides it. The
  // `see through terrain` switch is about flat map paint - the heat tiles and the plate/tile layer - and
  // applying it here is what turns a place filter into a wall of green seen through a house.
  timeBlockMat.depthTest = true;
  timeBlockMat.opacity = 1;                                       // opaque: shape carries the message
  return timeBlockMat;
}

function clearTimeMesh() {
  if (TLAYER.mesh) {
    ledgerGroup.remove(TLAYER.mesh);
    TLAYER.mesh.geometry.dispose();
    TLAYER.mesh = null;
  }
  TLAYER.quads = 0; TLAYER.verts = 0; TLAYER.drawn = 0; TLAYER.quadSec = null;
  TLAYER.quadRow = null; TLAYER.voxel = null; TLAYER.voxelFrom = null;
  TLAYER.itemEnd = null; TLAYER.markerEnd = null;
}

/**
 * This dimension's history, in time order: one request, and only when the layer is asked for. The whole
 * overworld table is 4.7 MB, so a map view that never scrubs must not pay for it.
 */
async function timeLoad() {
  const gen = ++TLAYER.gen;
  TLAYER.tl = null; TLAYER.err = '';
  // A fresh timeline is a fresh arm: the playhead decision (play from the first logged change, or show
  // the whole filter when paused was asked for) belongs to the moment rows first exist, and that is here
  // as much as in setTime - the boot path with ?time=1 never goes through setTime at all.
  TLAYER.freshArm = 1;
  clearTimeMesh();
  if (!LEDGER.meta) await ledgerMetaLoad();
  if (gen !== TLAYER.gen) return null;                     // the dimension changed under this request
  if (!LEDGER.meta?.available) { TLAYER.err = LEDGER.meta?.why ?? 'no ledger'; return null; }
  const dim = currentDim();
  if (!ledgerDimInfo(dim)) { TLAYER.err = 'this dimension has no ledger rows'; return null; }
  const t0 = performance.now();
  let buf;
  try {
    const res = await fetch(`/ledger/timeline?dim=${encodeURIComponent(dim)}`);
    if (!res.ok) { TLAYER.err = `/ledger/timeline: HTTP ${res.status}`; return null; }
    buf = await res.arrayBuffer();
  } catch (e) { TLAYER.err = `/ledger/timeline: ${e.message}`; return null; }
  if (gen !== TLAYER.gen) return null;
  try {
    TLAYER.tl = decodeTimeline(new Uint8Array(buf));       // a byte view, not a fetched ArrayBuffer
  } catch (e) {
    // A v2 pack has no timeline section at all. That reads as a decode error, and the fix is a re-bake.
    TLAYER.err = `timeline: ${e.message} - re-run node server/bake-ledger.mjs`;
    return null;
  }
  TLAYER.bytes = buf.byteLength;
  TLAYER.fetchMs = performance.now() - t0;
  HIST.packFrom = null; HIST.byCell = null;   // new dimension, new cell table: the undo must not keep the old one
  // How much of the CALENDAR this log has anything to say about. `sec` is ascending (the decoder checks
  // it), so this is one pass over runs rather than 351 531 Map inserts. Without the number on screen, a
  // scrub that races through empty months looks like a bug in the scrubber instead of a fact about the server.
  let days = 0, busy = -1, busyN = 0, day = -1, run = 0;
  for (let i = 0; i < TLAYER.tl.count; i++) {
    const d = (TLAYER.tl.sec[i] / 86400) | 0;
    if (d !== day) { if (run > busyN) { busyN = run; busy = day; } day = d; days++; run = 1; } else run++;
  }
  if (run > busyN) { busyN = run; busy = day; }
  TLAYER.activeDays = days;
  TLAYER.busyDay = Math.max(0, busy);
  TLAYER.busyN = busyN;
  // A timeline row carries a chunk INDEX, not a chunk coordinate: the cell table is what turns it into a
  // place in the world. So the time machine needs the other layer's table even when the heat overlay
  // itself is off. That is the one dependency between the two layers, and it is a request, not a merge.
  if (!LEDGER.pack) await ledgerLoad();
  if (gen !== TLAYER.gen) return null;
  if (!LEDGER.pack) { TLAYER.err = 'the timeline needs the cell table, and that failed to load'; return null; }
  timeRebuild();
  return TLAYER.tl;
}

/** Re-cut the decal mesh from rows already in memory. A filter change, never a per-frame cost. */
function timeRebuild() {
  clearTimeMesh();
  if (!S.time || !TLAYER.tl || !LEDGER.pack) { if (panel) panel.refresh(); return; }
  const t0 = performance.now();
  const got = filterRows(TLAYER.tl, { who: S.ledgerWho, cls: S.timeCls, limit: S.timeLimit });
  // The undo reads the SAME rows the decals do, grouped by chunk. Keeping the group order (the
  // decoder guarantees ascending time) is what lets editsForCell walk a chunk's rows newest-first.
  HIST.byCell = rowsByCell(TLAYER.tl, got.order);
  // A filter change is a different set of rows, so no held mark means anything any more - not even one
  // whose suffix count happens to match. The marks go with it.
  HIST.marks.clear();
  TLAYER.filterMs = performance.now() - t0;
  TLAYER.rows = got.n; TLAYER.other = got.other; TLAYER.truncated = got.truncated;
  if (!got.n) {
    TLAYER.err = got.other
      ? `no rows of that kind by that player - ${got.other.toLocaleString()} rows were filtered out`
      : 'this dimension has no rows at all';
    if (panel) panel.refresh();
    return;
  }
  TLAYER.err = '';
  // What the markers look like is a cost decision with measured numbers behind it (see S.timeLook).
  // The requested look is tried, and if the geometry it produces would not fit the ceiling the look steps
  // down - and says so in the panel, because a silently smaller claim is the failure this viewer keeps
  // having to correct.
  const t1 = performance.now();
  const budget = S.timeGeomMb * 1024 * 1024;
  let built = null, look = 'tiles', why = '';
  if (S.timeLook !== 'tiles' && assets) {
    const tries = S.timeLook === 'plates' ? ['plates'] : ['blocks', 'plates'];
    for (const lk of tries) {
      resetMarkerLift();
      const b = buildTimeBlocks(TLAYER.tl, LEDGER.pack, got.order, assets, blockNameIds(),
        { plates: lk === 'plates' });
      const lastTried = lk === tries[tries.length - 1];
      if (b.stats.bytes <= budget || lastTried) {
        built = b; look = lk;
        if (b.stats.bytes > budget) {
          why = `${lk} at this filter is ${Math.round(b.stats.bytes / 1048576)} MB, over the`
            + ` ?timegeommb= ${S.timeGeomMb} MB ceiling - drawing it anyway because you asked for it`;
        }
        break;
      }
    }
  }
  TLAYER.look = look;
  TLAYER.lookWhy = why;
  const geo = new THREE.BufferGeometry();
  if (built) {
    // One entry per DRAWABLE ITEM, whatever an item is: a marker, a plate or a tile. Everything that
    // speaks "how far through the filter is the playhead" (timeSeekRow, timeStep, the card's rewind)
    // reads quadSec/quadRow, so switching look must not change what a playhead means.
    TLAYER.quadSec = built.markerSec;
    TLAYER.quadRow = built.markerRow;
    TLAYER.itemEnd = TLAYER.markerEnd = built.markerEnd;
    TLAYER.quads = built.stats.markers; TLAYER.verts = built.stats.verts;
    if (built.stats.unknown) TLAYER.err = `${built.stats.unknown.toLocaleString()} changes name something this atlas has no model for`;
    geo.setAttribute('position', new THREE.BufferAttribute(built.pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(built.uv, 2));
    // The wash went in as normalized u8 with the face shade, exactly as the detail pass carries it.
    geo.setAttribute('color', new THREE.Uint8BufferAttribute(built.col, 4, true));
    geo.setIndex(new THREE.BufferAttribute(built.idx, 1));
  } else {
    const g = buildTimeQuads(TLAYER.tl, LEDGER.pack, got.order, { shrink: S.decalShrink });
    TLAYER.itemEnd = null; TLAYER.markerEnd = null;
    TLAYER.quadSec = g.quadSec;
    TLAYER.quadRow = g.quadRow;
    TLAYER.quads = g.quads; TLAYER.verts = g.verts;
    if (g.skipped) TLAYER.err = `${g.skipped.toLocaleString()} rows had no baked ground under them`;
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(g.col, 3));
    geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
  }
  TLAYER.buildMs = performance.now() - t1;
  // The index goes on the geometry, never as an attribute (gotcha 132-134), and it is 32-bit here: a
  // whole dimension of rows is 1.4M corners, over the 65 535 a Uint16 would reach.
  // One mesh spanning a whole dimension. Let three compute a sphere from 1.4M positions and it spends the
  // frame on it, so hand it a sphere that covers the map and turn culling off anyway.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);
  const mesh = new THREE.Mesh(geo, look === 'tiles' ? timeMat() : timeBlockMatOf());
  mesh.name = 'ledger-time';
  mesh.renderOrder = 902;                                   // over the heat layer (900) and pins (901)
  mesh.frustumCulled = false;
  ledgerGroup.add(mesh);
  TLAYER.mesh = mesh;
  // No mesh-park for this layer: it is one mesh, not 350, and its draw range IS the animation. A re-cut
  // happens on a filter change, which is a user action, not on streaming.
  timeApply();
  // The cursor follows the MOMENT, not the row number: switching from every change to one player mid-play
  // should keep showing the same point in the log and keep running forward from there.
  TLAYER.cur = Math.max(0, quadAt(TLAYER.quadSec, TLAYER.sec) - 1);
  // The first arm of the machine gets a playhead decision, and it is not "second 0". Second 0 is the oldest
  // calendar instant in the log, and this server logged NOTHING for the first 8.5 hours of it, so a viewer
  // who ticks the box sees an empty map and cannot tell that from a broken feature - which is the report
  // this replaces. Playing is the promised behaviour, so it starts at the first logged change; anyone who
  // asked for paused (?timeplay=0, or the play row) gets the other honest starting point: the END of the
  // filter, where every change it holds is drawn, and they scrub back from there.
  if (TLAYER.freshArm) {
    TLAYER.freshArm = 0;
    if (S.playTouched) timeSeekRow(TLAYER.quads - 1);
    else { S.timePlay = 1; timeSeekRow(0); }
  }
  histSync(true);
  if (panel) panel.refresh();
}

/** The rows and sentences a playhead move can change - the short list `timeApply` refreshes. */
const TIME_ROWS = ['timeAt', 'time', 'timeTiles', 'timePlay', 'timeTerrain', 'note_time', 'note_hist'];

/**
 * Move the playhead: one binary search and one draw range. `drawn` is what the readout and every probe
 * assert, because "the layer exists" is not evidence that the playhead moved anything.
 */
function timeApply() {
  if (!TLAYER.mesh || !TLAYER.quadSec) return 0;
  const ph = playhead(TLAYER.tl, S.timeAt);
  const n = quadAt(TLAYER.quadSec, ph.sec);
  // A flat tile layer is n items x 6 indices. A block-shaped layer is not: a cube is 36 indices and a
  // cross-model plant is 12, so the prefix comes out of the build as a per-item cumulative count.
  TLAYER.mesh.geometry.setDrawRange(0, TLAYER.itemEnd ? (n ? TLAYER.itemEnd[n - 1] : 0) : n * 6);
  // Tiles off is a real mode, not a cosmetic one: with the terrain undo on, the blocks themselves show
  // the playhead, and a tile per logged change over a canopy only hides that. The playhead, the date and
  // the voxel undo all keep working; only the decal mesh stops being drawn.
  TLAYER.mesh.visible = !!S.timeTiles && n > 0;
  TLAYER.drawn = n;
  TLAYER.sec = ph.sec;
  hoverDirty = true;          // the outline follows the playhead, so a moving playhead re-picks
  histSync();
  // A playhead move is the one thing in this viewer that happens every frame, and the panel's full sweep
  // runs once a second (and not at all while a thumb is held). So name the rows and sentences this move can
  // change: the date under the thumb has to move with the thumb.
  if (panel) panel.refreshRows(TIME_ROWS);
  return n;
}

/**
 * How far each heat tile is pulled in from its chunk's footprint, in blocks. `buildHeatQuads` draws one
 * tile per touched CHUNK, so at 16 x 16 with no inset the overlay is a continuous floor wherever the log
 * has rows; half a block of inset on each side is enough to open the seams and let the terrain read.
 */
const heatInset = () => Math.max(0, (16 * (1 - Math.max(0.02, Math.min(1, S.decalShrink)))) / 2);

/**
 * What a change looks like. Re-cutting the layer is the only way to change it: the shape, the texture
 * and the material all differ, and the cost ceiling decides what is affordable at this filter.
 */
function setTimeLook(v) {
  const want = ['blocks', 'plates', 'tiles'].includes(v) ? v : 'blocks';
  S.timeLook = want;
  if (S.time) timeRebuild();
  if (panel) panel.refresh();
  return S.timeLook;
}

/** Tiles on/off. The playhead, the date and the voxel undo are unaffected: this is the decal mesh only. */
function setTiles(on) {
  S.timeTiles = on ? 1 : 0;
  timeApply();
  if (panel) panel.refresh();
}

/** One number for both ledger overlays, so "I can't see anything" is one slider rather than two. */
function setDecalOp(v) {
  S.decalOp = Math.max(0, Math.min(1, +v || 0));
  if (ledgerHeatMat) ledgerHeatMat.opacity = S.decalOp;
  if (timeDecalMat) timeDecalMat.opacity = S.decalOp;
  if (panel) panel.refresh();
}

/** Resizing the tiles is geometry, so both overlay meshes have to be re-cut. */
function setDecalShrink(v) {
  S.decalShrink = Math.max(0.02, Math.min(1, +v || 1));
  if (S.ledger) ledgerRebuild();
  if (S.time) timeRebuild();
  if (panel) panel.refresh();
}

// ---- the world AS OF the playhead, in voxels (M12b Tier 2) ----------------------------------------
// Tier 1 paints a dot wherever the log says something happened. This answers the harder question out of
// the page's own voxels: stand at the playhead and the terrain is corrected BACKWARDS, so a block broken
// after T stands again and a block placed after T is gone. Only the sharp (detail) layer is corrected,
// because that is where one chunk mesh costs tens of milliseconds and there are only a few hundred of
// them; the baked LOD tiles and the heightmap skin keep showing the world as it is now, and the panel
// says so rather than letting the two layers disagree silently.
//
// Four rules keep it honest:
//   The store's payload is NEVER written. A patched copy is meshed and thrown away, so the pick probes,
//   the walker's collision, the mesher's neighbour reads and the far layers all still see the world as
//   it is. `__world.hist()` reports what was patched; nothing about the real data changes.
//   The log fills block_state for 2,828 of its 424,599 rows, so a restored block is chosen by NAME -
//   the plainest state the atlas holds for it. A torch comes back as a torch; a stair comes back facing
//   some default direction, because the log never recorded which way it faced.
//   Light is not re-simulated. A restored block borrows the light its cell carries today, which is
//   usually right at the surface and too dark inside a tunnel that has since been filled in.
//   The undo follows the row FILTER, because it is built from the same rows the decals are drawn from.
//   "Only playerA's places" then means "the world as playerA left it" - a different claim from the whole
//   log, and a smaller one, which is why the two layers share the who/what filters instead of each having
//   their own.
const HIST = {
  on: 0, gen: 0, sec: -1, cur: -1,
  packFrom: null, cellsAt: null,   // "cx,cz" -> cell index, rebuilt when the cell table changes
  byCell: null,                    // cell index -> this filter's rows, ascending in time
  marks: new Map(),                // "cx,cz" -> {gen, edits, unknown, truncated}, one per (chunk, playhead)
  stamps: new Map(),               // "cx,cz" -> history stamp, valid for HIST.gen
  ids: null, airId: 0,
  marked: 0, capped: 0, skipped: 0, workerPatches: 0, workerPatchMs: 0, builds: 0,
  syncMs: 0, patchMs: 0, patches: 0, err: '',
  // Lifetime counters. The ones above reset at every sync, which is right for the panel sentence
  // ("what did the last move cost") and wrong for a probe that scrubs faster than the mesh budget
  // drains: a scrub that syncs every frame never leaves a window long enough to install a mesh, and
  // reads zero. These only ever grow.
  buildTotal: 0, workerPatchTotalMs: 0,
};
const EMPTY_EDITS = new Int32Array(0);

/** Is the terrain time machine running at all? It needs the timeline, the cell table and the switch. */
const histWanted = () => !!(S.time && S.timeTerrain && TLAYER.tl && TLAYER.quadSec && LEDGER.pack);

/**
 * The history stamp of a chunk: how many of its logged rows are newer than the playhead, or '' when none
 * are. It goes into the mesh key, which is what makes a playhead move re-mesh exactly the touched chunks
 * and nothing else - a chunk the log never touched keeps the same key, and therefore its parked
 * triangles, for the whole of the scrub. Rows are time-ordered, so the rows newer than the playhead are
 * a SUFFIX of the chunk's list, and a suffix of the same length is the same suffix: the count is exact,
 * so a move that crosses no row of a chunk leaves that chunk's key, mesh and parked triangles alone.
 */
function histStampOf(cx, cz) {
  const k = `${cx},${cz}`;
  const hit = HIST.stamps.get(k);
  if (hit !== undefined) return hit;
  let s = '';
  if (HIST.on && TLAYER.tl) {
    const ci = HIST.cellsAt?.get(k);
    const rows = ci === undefined ? null : HIST.byCell?.get(ci) ?? null;
    s = histStamp(TLAYER.tl, rows, HIST.sec);
  }
  HIST.stamps.set(k, s);
  return s;
}

/** A border face has two owners, so a chunk's key changes when a NEIGHBOUR's history changes too. */
function histSuffix(cx, cz) {
  if (!HIST.on) return '';
  let s = '';
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) s += histStampOf(cx + dx, cz + dz);
  }
  return s;
}

/** The voxel edits of one chunk at this playhead, computed once per (chunk, playhead generation). */
function histEditsOf(cx, cz) {
  const k = `${cx},${cz}`;
  const stamp = histStampOf(cx, cz);
  const hit = HIST.marks.get(k);
  // A held mark is the SAME work when the set of rows newer than the playhead has not changed. The stamp
  // is exactly the count of those rows and they are time-ordered, so an equal count is an equal suffix -
  // re-running it would build identical edits, and worse, it would leave every chunk that the move did NOT
  // re-mesh stamped with an older gen, which is how a scrub came to report "0 chunks undone" while the
  // blocks on screen were still the undone ones.
  if (hit && (hit.gen === HIST.gen || hit.stamp === stamp)) {
    hit.gen = HIST.gen;
    return hit;
  }
  let e = { gen: HIST.gen, stamp, edits: EMPTY_EDITS, unknown: 0, truncated: 0, changes: 0 };
  if (HIST.on && HIST.ids && stamp) {
    const ci = HIST.cellsAt.get(k);
    const rows = ci === undefined ? null : HIST.byCell.get(ci) ?? null;
    const got = editsForCell(TLAYER.tl, rows, HIST.sec, (nm) => HIST.ids.get(nm) ?? 0, S.timeTerrainLimit);
    // `changes` is kept because the block-change class is invisible in the edit list: a path being put
    // back to grass looks exactly like a block being un-placed. Counting it is what makes the class,
    // and its cost, a number rather than an impression.
    e = { gen: HIST.gen, stamp, edits: got.edits, unknown: got.unknown, truncated: got.truncated,
      changes: got.changeRows };
    if (got.truncated) HIST.err = 'a chunk needed more than ' + S.timeTerrainLimit
      + ' voxel writes to reach that moment; the rest of it still shows today';
  }
  HIST.marks.set(k, e);
  if (HIST.marks.size > 8192) {
    for (const [kk, v] of HIST.marks) if (v.gen !== HIST.gen) HIST.marks.delete(kk);
  }
  return e;
}

/**
 * The edits to hand a mesh job: this chunk AND its eight neighbours. A wall on a chunk border is cut by
 * both sides, and a mesh that corrects its own chunk while its neighbour still shows the block as it is
 * today draws a seam - the same reason the mesh key already covers the 3x3.
 */
function histOverlays(cx, cz) {
  const out = [];
  if (!HIST.on) return out;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, nz = cz + dz;
      const e = histEditsOf(nx, nz);
      if (!e.edits.length) { if (histStampOf(nx, nz)) HIST.skipped++; continue; }
      out.push({ cx: nx, cz: nz, edits: e.edits });
    }
  }
  return out;
}

/** Same overlays for the in-thread path, which has no message to carry them. */
function histOverlayChunks(cx, cz) {
  const over = new Map();
  if (!HIST.on) return over;
  for (const o of histOverlays(cx, cz)) {
    const ch = store.get(o.cx, o.cz);
    if (!ch) continue;
    const t = performance.now();
    const pch = applyEdits(ch, o.edits, { withAccessors, airId: HIST.airId });
    HIST.patchMs += performance.now() - t;
    HIST.patches++;
    over.set(`${o.cx},${o.cz}`, { ch: pch, secOf: sectionIndex(pch) });
  }
  return over;
}

/**
 * Move the terrain playhead. The cursor advances by hundreds of rows a frame while playing and a chunk
 * mesh costs tens of milliseconds, so the terrain does NOT follow every row: it re-syncs once the cursor
 * has moved `S.timeTerrainStep` rows, and marks only chunks whose history changed or which carried
 * history at the previous playhead (that second half is how a block comes back).
 */
/**
 * The timeline names BLOCKS ("minecraft:deepslate_bricks"); the atlas holds STATES, and a block usually
 * has dozens. One map, kept for the life of the asset load, picks the plainest state for a name - which
 * is an honest answer to "what was there" when the log recorded block_state for 2,828 of its 424,599
 * rows. Both the voxel undo and the block-shaped markers ask the same question, so they share it.
 */
function blockNameIds() {
  if (!HIST.ids && assets) {
    HIST.ids = stateIdsByName(assets.states);
    HIST.airId = (assets.stateIndex.get('minecraft:air') ?? 0) + 1;
  }
  return HIST.ids;
}

function histSync(force = false) {
  const on = histWanted() ? 1 : 0;
  const wantCur = on ? Math.floor(TLAYER.cur) : -1;
  if (!force && on === HIST.on && Math.abs(wantCur - HIST.cur) < Math.max(1, S.timeTerrainStep)) return;
  const t0 = performance.now();
  const before = [...HIST.marks.keys()];
  HIST.on = on;
  HIST.sec = on ? Math.round(S.timeAt) : -1;
  HIST.cur = wantCur;
  HIST.gen++;
  HIST.stamps.clear();
  if (on) {
    if (HIST.packFrom !== LEDGER.pack) {
      HIST.packFrom = LEDGER.pack;
      HIST.cellsAt = new Map();
      for (let i = 0; i < LEDGER.pack.cellCount; i++) {
        const c = LEDGER.pack.cell(i);
        HIST.cellsAt.set(`${c.cx},${c.cz}`, i);
      }
    }
    if (!HIST.ids && assets) blockNameIds();
  }
  let marked = 0, capped = 0, restore = 0;
  const room = () => (marked - restore) < S.timeTerrainMax;
  const inRing = (cx, cz) => inDetailRing(cx, cz, 1) && store?.has(cx, cz);
  const did = new Set();
  // Chunks carrying history at the OLD playhead have to be re-marked even if they carry none at the new
  // one: undoing nothing is exactly the operation that makes a block stand again. This loop is NOT paid
  // out of the budget below, because a chunk it skips keeps showing a corrected block that no longer
  // belongs to the moment on screen - that is a lie, not a saving. Its size is bounded by the previous
  // sync's marks, so it cannot run away either.
  for (const k of before) {
    const comma = k.indexOf(',');
    const cx = +k.slice(0, comma), cz = +k.slice(comma + 1);
    if (!inRing(cx, cz)) continue;
    markChunk(k, 'history'); marked++; restore++; did.add(k);
  }
  if (on) {
    const [ccx, ccz] = centerChunk();
    // Ring order, not square order, and this is the whole point of the budget: it buys the nearest thing
    // first. The old walk ran a square from its far corner, and before that it spent the entire cap on
    // whatever the PREVIOUS syncs had marked, in insertion order. Measured at the framing in the user's
    // screenshot: 192 marks, capped, median distance 7 chunks, and the house under the eye (chunk -4,-9,
    // 2,180 of its 2,543 deepslate blocks placed AFTER this moment) never got a mesh job at this
    // playhead - so it stood exactly as it is today while the panel claimed thousands of blocks undone.
    scanFromCentre(ccx, ccz, Math.min(detailR + 1, 64), (cx, cz) => {
      // The cap is checked per chunk, not per ring: a cap that leaks is not a budget.
      if (!room()) { capped = 1; return false; }
      const k = `${cx},${cz}`;
      if (did.has(k)) return true;                       // the loop above already paid for it
      const stamp = histStampOf(cx, cz);
      if (!stamp && !HIST.marks.has(k)) return true;      // the log never touched it, and it never showed history
      if (!inRing(cx, cz)) return true;
      markChunk(k, 'history'); marked++;
      return true;
    });
  }
  HIST.marked = marked;
  HIST.restore = restore;
  HIST.capped = capped;
  HIST.syncMs = performance.now() - t0;
  HIST.patches = 0;
  HIST.patchMs = 0;
  HIST.workerPatches = 0;
  HIST.workerPatchMs = 0;
  HIST.builds = 0;
  HIST.skipped = 0;
}

/**
 * The undo totals, computed when asked rather than at sync time. A sync only MARKS chunks; the edits
 * themselves are built as each marked chunk reaches the mesher, so a summary taken inside histSync
 * would report zero blocks undone for a scrub that was about to undo thousands.
 */
function histTotals() {
  let chunks = 0, edits = 0, unknown = 0, truncated = 0, truncChunks = 0, changes = 0;
  // What makes a held mark still describe THIS playhead is its stamp - the count of rows newer than the
  // playhead - not the generation it happened to be computed in. Requiring `gen` equality threw those
  // marks away, and the panel then said "0 chunks, 0 blocks" over terrain that had plainly changed
  // (measured at the first row of the log: 361 chunks marked, 360 rebuilt, vertex count moved by 158 920,
  // and the sentence claimed nothing was undone). Same rule `histEditsOf` uses, so the number and the
  // mesh agree instead of the number lagging a generation behind the picture.
  for (const [k, e] of HIST.marks) {
    if (!e.edits.length) continue;
    if (e.gen !== HIST.gen) {
      const comma = k.indexOf(',');
      if (e.stamp !== histStampOf(+k.slice(0, comma), +k.slice(comma + 1))) continue;
    }
    chunks++; edits += e.edits.length >> 1; unknown += e.unknown; changes += e.changes || 0;
    // `truncated` counts VOXELS the per-chunk cap left showing today (an undo is one edit per voxel, so a
    // row count would overstate it); truncChunks says how many chunks hit the cap.
    if (e.truncated) { truncated += e.truncated; truncChunks++; }
  }
  return { chunks, edits, unknown, truncated, truncChunks, changes };
}

/** What the terrain time machine costs and claims, in one object a probe can diff. */
const histStats = () => ({
  on: !!HIST.on, wanted: histWanted(), sec: HIST.sec, cur: HIST.cur, gen: HIST.gen,
  touched: HIST.cellsAt ? HIST.cellsAt.size : 0, marked: HIST.marked, capped: !!HIST.capped,
  restore: HIST.restore || 0,
  ...histTotals(), workerPatches: HIST.workerPatches, workerPatchMs: +HIST.workerPatchMs.toFixed(1),
  workerPatchTotalMs: +HIST.workerPatchTotalMs.toFixed(1),
  builds: HIST.builds, buildTotal: HIST.buildTotal, skipped: HIST.skipped,
  patches: HIST.patches, syncMs: +HIST.syncMs.toFixed(1), patchMs: +HIST.patchMs.toFixed(1),
  step: S.timeTerrainStep, cap: S.timeTerrainMax, limit: S.timeTerrainLimit, err: HIST.err,
});

function histNote() {
  if (!S.time) return '';
  if (!S.timeTerrain) return 'the blocks themselves still show today - tick "undo the log in the blocks too" to put them back';
  if (!HIST.on) return 'the terrain undo needs the timeline and the cell table, and one of them did not load';
  const t = histTotals();
  return 'the blocks in view are as they were: '
    + `${t.chunks.toLocaleString()} chunk${t.chunks === 1 ? '' : 's'} re-cut, `
    + `${t.edits.toLocaleString()} block${t.edits === 1 ? '' : 's'} undone, `
    + `${t.changes.toLocaleString()} of them a logged block change (a path back to grass, a stripped log)`
    + `, ${t.unknown.toLocaleString()} row${t.unknown === 1 ? '' : 's'} naming nothing the atlas can draw`
    + (t.truncated ? ` (${t.truncated.toLocaleString()} voxel${t.truncated === 1 ? '' : 's'} in ${t.truncChunks}`
      + ` chunk${t.truncChunks === 1 ? '' : 's'} still showing today, past the per-chunk cap)` : '')
    + ` - ${HIST.marked.toLocaleString()} chunk${HIST.marked === 1 ? '' : 's'} marked, `
    + `${HIST.syncMs.toFixed(1)} ms to mark, ${HIST.patchMs.toFixed(1)} ms patched on this thread`
    + (HIST.workerPatches ? `, ${HIST.workerPatches} patched in workers` : '');
}

/**
 * Playing. The cursor is a ROW INDEX and it advances by `S.timeSpeed` logged changes per wall-clock second,
 * so a slow machine shows less history per frame rather than wrong history, and the number the viewer sets
 * is a rate of EVENTS - the only unit that means anything for a log that put 99 % of its rows in one week.
 */
function timeStep(dt) {
  if (!S.timePlay || !TLAYER.quadSec || !TLAYER.quads) return;
  const last = TLAYER.quads - 1;
  TLAYER.cur = Math.min(last, TLAYER.cur + dt * S.timeSpeed);
  S.timeAt = TLAYER.quadSec[Math.floor(TLAYER.cur)];
  timeApply();
  if (TLAYER.cur >= last) {
    S.timePlay = 0;
    showLedger('the log ends at ' + fmtLedger(playhead(TLAYER.tl, S.timeAt).ms)
      + ` - ${TLAYER.quads.toLocaleString()} ${timeClsName()} changes, on ${TLAYER.activeDays} of the`
      + ` ${(TLAYER.tl.spanSec / 86400).toFixed(0)} days this log spans`);
  }
}

/** The slider speaks in permille of the CURRENT filter's rows, so its thumb is as smooth as the history is dense. */
// Permille of the CURRENT FILTER's rows, read from the cursor rather than the drawn count. Many logged
// changes share one second, so the drawn count climbs in steps while the cursor moves smoothly.
const timePermille = () => (TLAYER.quads > 1
  ? Math.round((Math.min(TLAYER.quads - 1, TLAYER.cur) / (TLAYER.quads - 1)) * 1000) : 0);
const timeRowAt = (p) => (TLAYER.quads
  ? Math.max(0, Math.min(TLAYER.quads - 1, Math.round((p / 1000) * (TLAYER.quads - 1)))) : 0);

/** Put the cursor on a row of the current filter and draw it. This is what the slider does. */
function timeSeekRow(i) {
  if (!TLAYER.quadSec || !TLAYER.quads) return 0;
  TLAYER.cur = Math.max(0, Math.min(TLAYER.quads - 1, +i || 0));
  S.timeAt = TLAYER.quadSec[Math.floor(TLAYER.cur)];
  timeApply();
  return TLAYER.drawn;
}

/** Jump to a moment: `sec` is seconds since the first logged row in this dimension. */
function timeGoto(sec) {
  S.timeAt = Math.max(0, Math.round(+sec || 0));
  TLAYER.cur = Math.max(0, quadAt(TLAYER.quadSec ?? new Uint32Array(0), S.timeAt) - 1);
  timeApply();
  if (panel) panel.refresh();
  return TLAYER.drawn;
}

/**
 * The block index behind "when did THIS block happen?" - built on the first click, not on every filter
 * change. 351,531 rows is a few ms and one small array per block, and a viewer who never clicks a block
 * should not pay that each time they switch player or kind. It is keyed on the `quadRow` array itself, so
 * any re-cut (filter, dimension, inset) drops it without a counter to remember to bump.
 */
function timeVoxelIndex() {
  if (!TLAYER.quadRow) return null;
  if (TLAYER.voxel && TLAYER.voxelFrom === TLAYER.quadRow) return TLAYER.voxel;
  const t0 = performance.now();
  TLAYER.voxel = voxelRows(TLAYER.tl, TLAYER.quadRow);
  TLAYER.voxelFrom = TLAYER.quadRow;
  TLAYER.voxelMs = performance.now() - t0;
  return TLAYER.voxel;
}

/**
 * "cx,cz" -> the cell index a timeline row carries. The pack keeps its cells sorted, but a Map costs less
 * per click than a binary search and it is 20,322 entries, not 284,239.
 */
function ledgerCellAt() {
  if (TLAYER.cellsPack === LEDGER.pack && TLAYER.cellsAt) return TLAYER.cellsAt;
  const m = new Map();
  if (LEDGER.pack) {
    for (let i = 0; i < LEDGER.pack.cellCount; i++) {
      const c = LEDGER.pack.cell(i);
      m.set(`${c.cx},${c.cz}`, i);
    }
  }
  TLAYER.cellsAt = m; TLAYER.cellsPack = LEDGER.pack;
  return m;
}

/**
 * Rewind the replay to one exact change - the row a card line names.
 *
 * A card answers a question about the world as it is ("what happened to this block?"); the replay answers
 * "when?". The offset between the two is one second and it is not arbitrary: a break is a block LEAVING,
 * so the moment that still shows it standing is one second BEFORE the break, while a place is a block
 * ARRIVING and its own second is the one that shows it. That is the same rule the voxel undo works by -
 * rows strictly newer than the playhead are the ones taken back - so the block is standing in the picture,
 * not just in the date.
 *
 * A row the current player/kind filter excludes is not hidden: the playhead still goes to that moment, and
 * the answer says the block itself was not in the replay set.
 */
async function ledgerRewind(rw) {
  if (!LEDGER.meta?.available) return { ok: 0, why: LEDGER.meta?.why ?? 'no ledger in this world' };
  if (!rw || rw.t === undefined) return { ok: 0, why: 'that card line does not name a moment' };
  if (!TLAYER.tl) {
    if (!S.time) setTime(true);
    await timeLoad();
    if (!TLAYER.tl) return { ok: 0, why: TLAYER.err || 'the timeline for this dimension did not load' };
  }
  const cx = rw.x >> 4, cz = rw.z >> 4;
  const cell = ledgerCellAt().get(`${cx},${cz}`);
  if (cell === undefined) return { ok: 0, why: `chunk ${cx},${cz} is not in this dimension's replay index` };
  const packed = tlPackCoord(rw.x & 15, rw.y, rw.z & 15);
  const want = Math.floor(rw.t / 1000) - TLAYER.tl.timeBaseSec - (rw.cls === 3 ? 1 : 0);
  const t0 = performance.now();
  const hit = rowForBlock(timeVoxelIndex() ?? new Map(), TLAYER.quadSec ?? new Uint32Array(0),
    cell, packed, want);
  TLAYER.jumpMs = performance.now() - t0;
  if (!hit) {
    timeGoto(want);
    return { ok: 0, why: `the replay holds no ${actionName(rw.cls)} row for that block under the current filter`,
      at: want, sec: TLAYER.sec };
  }
  S.timePlay = 0;
  timeSeekRow(hit.quad);
  return { ok: 1, at: hit.sec, sec: TLAYER.sec, n: hit.n, later: hit.later, before: hit.before,
    ms: (TLAYER.tl.timeBaseSec + hit.sec) * 1000, quad: hit.quad, drawMs: +TLAYER.jumpMs.toFixed(2) };
}

/** What the card says after a rewind: the moment, and how much more that block has. */
function rewindNote(rw, out, baseSec = 0) {
  if (!out.ok) {
    return `not in the replay set: ${out.why}`
      + ` - the playhead went to ${fmtLedger((baseSec + (out.at ?? 0)) * 1000)} UTC anyway`;
  }
  const more = out.n > 1 ? `, ${out.later} more change${out.later === 1 ? '' : 's'} after this one` : '';
  const early = out.before ? '' : ' - the replay holds nothing older for that block';
  const blocks = S.timeTerrain ? '' : ' - the blocks themselves still show today until "undo the log in the blocks too" is on';
  return `the replay now sits at ${fmtLedger((baseSec + out.at) * 1000)} UTC: that block's ${actionName(rw.cls)} row,`
    + ` ${out.n} change${out.n === 1 ? '' : 's'} to it in the replay${more}${early}${blocks}`;
}

/** A card line's rewind button: jump the playhead, then say in the card what actually moved. */
function rewindTo(rw, btn, noteEl) {
  btn.classList.add('busy');
  noteEl.textContent = 'rewinding\u2026';
  ledgerRewind(rw).then((out) => {
    btn.classList.remove('busy');
    noteEl.textContent = rewindNote(rw, out, TLAYER.tl?.timeBaseSec ?? 0);
    noteEl.classList.remove('bad');
    if (!out.ok) noteEl.classList.add('bad');
    if (panel) panel.refresh();
    return out;
  });
}

function setTimePlay(on) {
  if (!TLAYER.tl) { showLedger('the timeline is still loading, or this dimension has none'); return false; }
  S.playTouched = 1;
  S.timePlay = on ? 1 : 0;
  // Playing again after the end restarts at the first logged change, not at the first calendar second:
  // the log's oldest instant may precede anything being built by weeks.
  if (S.timePlay && TLAYER.cur >= Math.max(0, TLAYER.quads - 1)) timeSeekRow(0);
  if (panel) panel.refresh();
  return !!S.timePlay;
}

function setTime(on) {
  S.time = on ? 1 : 0;
  TLAYER.err = '';
  TLAYER.freshArm = 1;
  if (!S.time) { S.timePlay = 0; clearTimeMesh(); if (panel) panel.refresh(); return false; }
  // Ticking "time machine" is one decision, and what a viewer expects from it is the world at that moment,
  // not tiles painted over today. `?time=1` already armed the voxel undo; the panel path used to leave it
  // off, so the same feature looked broken from the URL and working from the checkbox. An explicit choice
  // (URL `?timeterrain=` or the checkbox) still wins and is never re-armed.
  if (!S.timeTouched && !S.timeTerrain) S.timeTerrain = 1;
  if (!LEDGER.meta?.available) {
    TLAYER.err = LEDGER.meta?.why ?? 'no ledger in this world';
    if (panel) panel.refresh();
    return false;
  }
  if (!TLAYER.tl) timeLoad(); else timeRebuild();
  if (panel) panel.refresh();
  return true;
}

// The same six classes as the heat layer, plus "any other action the log records": a timeline row stores
// the six as indices 0..5 and reserves 6 for an action id outside them, which needs its own filter value
// rather than falling through to "everything" (see filterRows).
const timeClassOptions = () => [
  { value: '0', label: 'any change at all' },
  ...LEDGER_CLASSES.map((c) => ({ value: String(c.id), label: c.name })),
  { value: String(LEDGER_CLASSES.length + 1), label: 'any other logged action' },
];
const timeClsName = () => (S.timeCls > LEDGER_CLASSES.length ? 'other action' : actionName(S.timeCls));


/** The one sentence that answers "am I watching a bug, or an empty decade?". */
function timeNote() {
  if (!S.time) {
    return 'M replays this dimension\'s ledger: 351,531 rows over 820 days here, but only 9 of those days\n'
      + 'hold a change. It starts at the end and takes changes back as you pull left. One 5.4 MB request,\n'
      + 'one mesh; the scrubber costs a draw range, so a filter change is the only rebuild.';
  }
  if (TLAYER.err) return `time machine: ${TLAYER.err}`;
  if (!TLAYER.tl) return 'time machine: loading the timeline...';
  const ph = playhead(TLAYER.tl, S.timeAt);
  if (ph.permille >= 1000) {
    return `the log as it stands today: all ${TLAYER.quads.toLocaleString()} ${timeClsName()} rows by `
      + `${S.ledgerWho ? (LEDGER.meta?.players?.find((p) => p.id === S.ledgerWho)?.name ?? 'that player') : 'anybody'}`
      + ` are in the picture, and nothing is taken back`;
  }
  const who = S.ledgerWho
    ? (LEDGER.meta?.players?.find((p) => p.id === S.ledgerWho)?.name ?? `player ${S.ledgerWho}`) : 'anybody';
  const span = TLAYER.tl.spanSec;
  const playSecs = TLAYER.quads / Math.max(1, S.timeSpeed);
  const built = TLAYER.look
    ? `
${TLAYER.look === 'blocks' ? 'drawn as the blocks themselves'
      : TLAYER.look === 'plates' ? 'drawn as one textured plate per block' : 'drawn as flat tiles'}`
      + `, ${Math.round((TLAYER.verts ?? 0) / 1000)}k corners`
    : '';
  const refused = TLAYER.lookWhy ? `
(${TLAYER.lookWhy})` : '';
  return `${fmtLedger(ph.ms)} - ${(TLAYER.drawn ?? 0).toLocaleString()} of ${TLAYER.quads.toLocaleString()}${built}${refused}`
    + ` ${timeClsName()} rows by ${who}, of ${TLAYER.tl.count.toLocaleString()} in the log`
    + ` (${(TLAYER.filterMs).toFixed(0)}/${(TLAYER.buildMs).toFixed(0)} ms to re-cut, ${(TLAYER.bytes / 1048576).toFixed(1)} MB in ${(TLAYER.fetchMs / 1000).toFixed(2)} s)`
    + `\nthe log spans ${fmtLedger(ph.firstMs)} to ${fmtLedger(ph.lastMs)}, but only ${TLAYER.activeDays}`
    + ` of those ${(span / 86400).toFixed(0)} days hold any change at all, and day ${TLAYER.busyDay + 1}`
    + ` alone holds ${TLAYER.busyN.toLocaleString()} of them: at ${S.timeSpeed.toLocaleString()} changes/s`
    + ` this filter plays in ${playSecs.toFixed(1)} s${TLAYER.truncated ? ', and this view is capped short of the end' : ''}`
    // The date in the box is the filter's clock, not the log's. A place-only filter over a log that runs to
    // 2026 stops at its last placement, and that is the kind of thing that looks like a broken clock.
    + (TLAYER.quads && TLAYER.quadSec?.length
      ? `\nthese rows themselves run ${fmtLedger((TLAYER.tl.timeBaseSec + TLAYER.quadSec[0]) * 1000)} to`
        + ` ${fmtLedger((TLAYER.tl.timeBaseSec + TLAYER.quadSec[TLAYER.quadSec.length - 1]) * 1000)}`
      : '\nthis filter keeps no rows, so there is nothing to scrub');
}

/** Short wall clock for the slider's value column, scaled to what the history actually spans. */
function timeStamp(ms) {
  const d = new Date(ms);
  const p = (v, n = 2) => String(v).padStart(n, '0');
  // Month-day and clock, not the year: the log spans 27 months and the interesting motion is inside a
  // day. The full span is spelled out in the sentence under the controls.
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const ledgerClassOptions = () => [
  { value: '0', label: 'any kind of action' },
  ...LEDGER_CLASSES.map((c) => ({ value: String(c.id), label: c.name })),
];

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

// The sharp ring's unfilled orders: held, inside the ring, no mesh. Counted separately from
// `dirty` because the interesting case is one without the other.
function ringStuck() {
  if (!store) return [0, 0];
  let n = 0, q = 0;
  ringStuck.rows = [];
  for (const c of store.chunks.values()) {
    if (!inDetailRing(c.cx, c.cz, 1)) continue;
    const k = `${c.cx},${c.cz}`;
    if (meshes.has(k)) continue;
    n++;
    if (store.dirty.has(k)) q++;
    else if (ringStuck.rows.length < 8) {
      const [tcx, tcz] = centerChunk();
      ringStuck.rows.push({ k, dist: Math.max(Math.abs(c.cx - tcx), Math.abs(c.cz - tcz)),
        queued: store.queue.has?.(k) ?? null, sections: c.sections?.length ?? -1, mk: meshKeyFor(c.cx, c.cz) });
    }
  }
  return [n, q];
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
      fps: lastFps, frameError, frameErrors, loopFrames, verts, tris, drawn, bootError: bootError && bootError.message,
      chunks: store ? store.loaded : 0, inflight: store ? store.inflight : -1,
      queued: store ? store.queue.length : -1, missing: store ? store.missing.size : -1,
      dirty: store ? store.dirty.size : -1, dist: rig.dist, dim: hud.dim.value,
      // M11/M14: the walking body, in the readout, because "is the eye really standing on something,
      // and is it standing because of a collision or because it is waiting on bytes?" is the first
      // thing a walk measurement has to be able to prove.
      walkOn: walk.on, walkFly: walk.fly, walkReach: walk.reach, walkSpeed: S.walkSpeed,
      walkSprint: S.walkSprint, walkGravity: S.walkGravity, walkJump: S.walkJump, walkSneak: S.walkSneak,
      eye: [rig.target.x, rig.target.y, rig.target.z],
      feet: +player.y.toFixed(3), onGround: player.onGround ? 1 : 0, vy: +player.vy.toFixed(3),
      fell: +(player.fell ?? 0).toFixed(2), lastFall: +walk.landed.toFixed(2), frozenFrames: walk.frozenFrames,
      embeddedFrames: walk.embedded, unstuck: walk.unstuck,
      floorY: playerFloorTop(cellAt, player.x, player.y, player.z),
      yaw: +rig.yaw.toFixed(4), pitch: +rig.pitch.toFixed(4),
      // [held chunks inside the sharp ring with no mesh, how many of those are queued].
      // `ringStuck[0] > 0 && ringStuck[1] === 0` is the failure, not a slow queue: work that
      // nobody will ever ask for again.
      ringStuck: ringStuck(), ringStuckRows: ringStuck.rows ?? [],
      mesh: aggTotal, meshMs: +meshAvg.toFixed(2), meshMax: +meshMax.toFixed(2), meshed: meshN,
      // What the player actually waits for: request-accepted to mesh-landed, which includes queueing.
      meshWait: +meshWait.toFixed(2), workers: pool.length, workerReady, workerError, workerReadyMsgs, meshQueued: jobs.size,
      lodOn: lodActive() ? 1 : 0, lodTiles, lodVerts, lodAvail: lodAvail ? 1 : 0,
  lodGaps: lodStore ? lodStore.gaps() : 0, lodError, lodCap: S.lodCap,
  shellPatches: shellMeshes.size, shellVerts, retired: retireN, shellHeld: shellStore ? shellStore.loaded : 0,
      shellTextured: [...shellMeshes.values()].filter((e) => e.mode === 1).length,
      // Sweeps of the far skin's held set (one per box change, used to be one per arriving batch).
      shellEvSweeps: shellStore ? shellStore.evSweeps : 0,
      shellEvSkipped: shellStore ? shellStore.evSkipped : 0,
      shellEvVisited: shellStore ? shellStore.evVisited : 0,
      ovCells, ovVerts, ovSkipped, ovMs: +ovMs.toFixed(1), ovReady: !!overview, ovOn: ovActive() ? 1 : 0,
      ovMeshes: ovGroup.children.length,   // must equal ovBands: more means ghost bands still drawing
      ovBands: ovBands.size, ovBandsTotal: ovBandTotal(), ovBandRows: ovBandRows(),
      shellMissing: shellStore ? shellStore.missing.size : 0,
      shellMs: +shellMs.toFixed(2), shellMsMax: +shellMsMax.toFixed(2),
      shellJobs: patchJobs.size, patchOutside, patchWide, patchPosted, patchDropped,
      shellCells: tiers().slice(), shellTiers: tierLabel(),
      shellTiersLive: [...patchTier.values()],
      skinRadius: skinR, skinCap: S.skinCap, skinFloor: S.skinFloor,
      // The three radii of PLAN 7.2, plus what each layer actually costs. `detailVerts` is the number
      // that was invisible before: `verts - shellVerts - ovVerts` used to be the only way to get it.
      detailRadius: detailR, detailCeiling: S.radius, payloadRadius: payloadR, detailPx: S.detailPx,
      detailMeshes: meshes.size, detailVerts, demoted, dirtyPatches: dirtyPatches.size, bytesHeld: store ? store.bytesHeld : 0,
      underFar: underFar ? 1 : 0,
      cullDark: aggTotal.darkCulled, cullBuried: aggTotal.buried, cullCoveredFaces: aggTotal.covered,
      detailLod: S.detailLod, detailPixels: S.detailPixels, detailReachBlocks: Math.round(detailReach(pxPerRad(), S.detailPx)),
      lightOn: S.light ? 1 : 0, darkFloor: S.darkFloor, darkGamma: S.darkGamma, skyScale: S.skyScale, ao: S.ao ? 1 : 0,
      cavesOn: S.caves, darkcut: S.caves ? -1 : S.darkcut,
      surfaceOn: S.caves ? 0 : S.surface,
      // The zoom-back budget: what is parked, what it costs, how often it was reused.
      meshCacheMB: +(meshBytesTotal / 1048576).toFixed(1), meshCachedChunks: meshBytes.size,
      meshReused: cachedInstalls, meshCacheDropped: meshBytesDropped,
      meshBuilds, meshKeyOn: S.meshKey, meshUnchanged: meshUnchanged.count,
      meshUnsettled: meshUnsettled.count, meshResultsDropped: meshResultsDropped.count, meshBytesGhost, parkThenBuild,
      parkedIndex, installedIndex, cachedInstalls, parkIndexLost: parkIndexLost.count,
      parkedWaiting: parkedAt.size,
      payloadLead: S.payloadLead, bytesKeep: S.bytesKeep,
      // The mesh queue's own depth: keys waiting in the wave (taken from the dirty set) and jobs the
      // pool has not answered yet. Without these, "chunks" and "dirty" cannot say whether the page is
      // waiting on the network, on the threads, or on its own bookkeeping.
      meshWave: wave.length - waveAt, meshJobs: jobs.size,
      // Far-patch pass progress: signature tests run, and dirty patches left marked because the pass
      // ran out of budget. `patchDeferred` climbing while `retired`/`shellPatches` stall means the
      // far layer is starving, not settling.
      patchTested: patchTestedN, patchDeferred: patchDeferredN, patchCuts: shellCuts,
      patchCutsNew, patchCutsChanged,
      // Cuts that went to a thread versus cuts the render thread had to do itself.
      patchWorkerJobs: patchPosted, patchWorkerDropped: patchDropped, patchInflightNow: patchInflight,
      // Measured cost per piece of far-patch work, so a budget number means something.
      patchCutMsAvg: +shellCutAvg.toFixed(2), patchJobMsAvg: +patchJobAvg.toFixed(2),
      patchSigMsAvg: +sigAvg.toFixed(2),
      // The far pass priced each cut by its own cell, and what that said:
      patchCutMsByCell: Object.fromEntries([...cutByCell].map(([c, e]) => [c, +e.ms.toFixed(2)])),
      patchDeferredBig, patchForced, patchStarveMs: S.patchStarve, patchCutLog,
      patchCappedIdle, patchStolen, patchStealMs: S.patchStealMs,
      patchCellPrice: S.cutCellPrice ? 1 : 0,
      patchCutMax: +patchCutMax.toFixed(2), patchCutMaxCell, patchCutMaxPk,
      shellBudgetMs: S.shellBudget, demoteBudgetMs: S.demoteBudget,
      dirtyWhy: Object.fromEntries(dirtyWhy), meshByWhy: Object.fromEntries(meshWhy),
      farCostScale: +costScale.toFixed(2), farFloorBoost: floorBoost, cpuRenderMs: +cpuRenderMs.toFixed(2),
      shellPatch: S.patch, maxZoom: S.maxZoom, worldSpan: S.worldSpan,
      // What the page actually parsed for the detail layer. Every A/B of meshing policy has to echo
      // its own inputs or a URL typo reads like a measured difference.
      radius: S.radius, detailPx: S.detailPx, detailPixels: S.detailPixels,
      meshIndex: S.meshIndex, aa: S.aa, caves: S.caves ? 1 : 0, staticMatrix: STATIC_MATRIX ? 1 : 0,
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
  // One chunk's whole mesh decision, in one object: what the triangles on screen answer, what the
  // dirty set and the wave think, what a mesh WOULD answer now, and what the time machine asks of it.
  // A "marked but not re-cut" bug has exactly these suspects and no others.
  meshDiag: (cx, cz) => {
    const k = `${cx},${cz}`;
    const seq = jobForKey.get(k);
    return {
      mk: meshKeyFor(cx, cz),
      installed: meshes.get(k)?.mk ?? null,
      empty: meshes.has(k) && !meshes.get(k).list.length,
      done: meshDone.get(k) ?? null,
      parked: meshBytes.get(k)?.mk ?? null,
      dirty: store?.dirty.has(k) ?? null,
      inWave: wave.indexOf(k) >= 0, waveAt,
      held: !!store?.get(cx, cz),
      inRing: inDetailRing(cx, cz, 1), ring: detailR,
      suffix: histSuffix(cx, cz), stamp: histStampOf(cx, cz),
      markGen: HIST.marks.get(k)?.gen ?? null, histGen: HIST.gen,
      jobLive: seq !== undefined, jobHistGen: seq === undefined ? null : jobs.get(seq)?.histGen ?? null,
      meshed: meshes.has(k),
    };
  },
  // The baked far layer: which tile covers a block, how many are held/drawn, and what was refused.
  lodDiag: () => ({
    on: lodActive() ? 1 : 0, avail: lodAvail ? 1 : 0, cap: S.lodCap,
    clipOn: lodClipOn, clip: lodClipRect.map((v) => (v > 1e8 ? 'off' : v)), cov: lodCovPatches,
    covDetail: lodCovDetail,
    held: lodStore ? lodStore.tiles.size : 0, drawn: lodTiles, verts: lodVerts,
    loaded: lodStore ? lodStore.loaded : 0, dropped: lodStore ? lodStore.dropped : 0, refused: lodStore ? lodStore.badTiles : 0,
    passes: [lodPasses, lodPassRuns, lodSkipRect], passInfo: [passCand, passZero, passPick], picks: lodPicks.slice(0, 14),
    flips: lodFlips, flipLog: lodFlipLog.slice(-10), release: lodRelease,
    // What the rung chooser is asking for right now, per rung. Held/drawn say what is on screen; these
    // say what the next download will be - and a gap between the two that keeps moving is the flash.
    ask: (() => { const o = {}; for (const c of lodSticky.values()) o[c] = (o[c] || 0) + 1; return o; })(),
    costFromIndex: lodStore ? lodStore.cost.size : 0,
    cells: lodStore ? lodStore.cells : [], cellPx: S.lodCellPx, cellMaxPx: S.lodCellMaxPx, budget: S.lodVerts,
    rung: lodStore ? Object.fromEntries(lodStore.cells.map((c) =>
      [c, [...lodStore.tiles.values()].filter((t) => t.cell === c).length])) : {},
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
  ledgerTour,
  ledger: () => ({
    meta: LEDGER.meta ? 'yes' : 'no', err: LEDGER.err, cells: LEDGER.cells.length, max: LEDGER.max, quads: LEDGER.quads,
    dropped: LEDGER.dropped, noHeight: LEDGER.noHeight, kb: (LEDGER.bytes / 1024) | 0,
    fetchMs: +LEDGER.fetchMs.toFixed(1), buildMs: +LEDGER.buildMs.toFixed(1),
    asks: LEDGER.asks, cardRows: LEDGER.cardRows, cardTotal: LEDGER.cardTotal, askWhy: LEDGER.askWhy,
    lastAsk: LEDGER.last,
    top: LEDGER.top?.map((c) => [c.cx, c.cz, c.n]) ?? null, topIdx: LEDGER.topIdx,
    drawn: !!LEDGER.mesh, pins: !!LEDGER.pin, cls: S.ledgerCls, who: S.ledgerWho, minN: S.ledgerMin,
  }),
  // M12b: the time machine's readout. `drawn` is the number that proves the playhead moved -
  // "the layer exists" is not evidence. `quads` is the size of the current filter, and the three ms
  // figures are the fetch, the filter and the mesh build, which are three different questions.
  hist: histStats,
  time: () => ({
    on: !!S.time, playing: !!S.timePlay, tl: !!TLAYER.tl, err: TLAYER.err,
    rows: TLAYER.rows, other: TLAYER.other, quads: TLAYER.quads, verts: TLAYER.verts,
    cur: TLAYER.cur, activeDays: TLAYER.activeDays, busyDay: TLAYER.busyDay, busyN: TLAYER.busyN,
    drawn: TLAYER.drawn, sec: TLAYER.sec, at: S.timeAt, speed: S.timeSpeed,
    cls: S.timeCls, who: S.ledgerWho, limit: S.timeLimit, truncated: TLAYER.truncated,
    span: TLAYER.tl?.spanSec ?? 0, base: TLAYER.tl?.timeBaseSec ?? 0,
    kb: (TLAYER.bytes / 1024) | 0, fetchMs: +TLAYER.fetchMs.toFixed(1),
    filterMs: +TLAYER.filterMs.toFixed(1), buildMs: +TLAYER.buildMs.toFixed(1),
    drawRange: TLAYER.mesh ? [TLAYER.mesh.geometry.drawRange.start, TLAYER.mesh.geometry.drawRange.count] : null,
    look: TLAYER.look, lookWhy: TLAYER.lookWhy, lookWant: S.timeLook, geomMbCap: S.timeGeomMb,
    markerGeoMb: TLAYER.mesh ? +(TLAYER.mesh.geometry.attributes.position.array.byteLength
      / 1048576).toFixed(1) : 0,
    // The ACTIVE material, not whichever one happens to exist: with look=blocks the tile material may
    // never have been made, and a null here once read as "the layer has no depth test".
    depthTest: TLAYER.mesh ? !!TLAYER.mesh.material.depthTest : null,
    opacity: TLAYER.mesh ? TLAYER.mesh.material.opacity : null,
    polyOffset: TLAYER.mesh ? !!TLAYER.mesh.material.polygonOffset : null,
    xray: !!S.ledgerXray,
    bytes: TLAYER.mesh ? TLAYER.mesh.geometry.attributes.position.array.byteLength + TLAYER.mesh.geometry.index.array.byteLength : 0,
  }),
  timeLoad, timeRebuild, timeApply, timeGoto, timePermille, timeSeekRow, timeRowAt, setTime, setTimePlay, timeNote,
  setTimeLook, blockNameIds, askAt, timeHitAt, timeHitProbe, timeRowWorld, timeDrawnAt,
  hover: () => ({ ...HOVER, setting: !!S.hover, everyMs: S.hoverMs, clickRayMs: TLAYER.hitMs }),
  // Counters are lifetime unless a probe zeroes them: "passes 1, skips 394" is only an IDLE measurement if
  // the window being measured starts at zero.
  hoverReset: () => { HOVER.passes = 0; HOVER.skips = 0; HOVER.ms = 0; HOVER.why = ''; return { ...HOVER }; },
  hoverAt: hoverAtPixel,
  setHover: (v) => {
    S.hover = v ? 1 : 0; if (!S.hover && hoverBox) hoverBox.visible = false; return !!S.hover;
  },
  // The card and the playhead: a probe has to be able to ask about a block and rewind to one of its rows
  // without owning the scene graph.
  ledgerAsk, ledgerAskCentre, ledgerRewind, rewindNote,
  histSync, histStats, histEditsOf, histNote, histTotals, histStampOf, histWanted, HIST,
  TLAYER,
  ledgerLoad, ledgerFind, ledgerJump, ledgerAsk, ledgerAskCentre, setLedger, clearLedgerPins,
  ledgerRewind, timeVoxelIndex, ledgerCellAt,
  ledgerNote, rankCells, collectCells, summarizeRows, readPack,
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
    changes: resChanges, pending: resDue, reallocAt: 'top of frameBody',
    ladder: RES_LADDER, rung: resRung, flips: resFlips, locked: resLocked,
    gpuTimer: !!timerExt, timerDead, gpuMs, cpuRenderMs, samples: gpuSamples }),
  // Drive the resolution governor from a probe: claim a GPU time and run one step of the control
  // loop. Without this the shrink path only shows up on a card that is actually slow, and a probe
  // cannot tell "the governor is off" from "the governor decided correctly". `now` lets a probe walk a
  // synthetic timeline, which is the only way to see the hold and the flap lock at all.
  tuneResNow: (ms, force = true, now = null) => {
    if (typeof ms === 'number' && ms > 0) { gpuMs = ms; gpuSamples = Math.max(1, gpuSamples); }
    const t = typeof now === 'number' ? now : performance.now();
    resTuneAt = t - RES_GAP_MS;
    tuneRes(t, !!force);
    // A probe asks a question and wants the answer in the same call, so this path takes the new buffer
    // immediately. The production path - every caller of applyRes - waits for the frame boundary.
    takeRes();
    return { auto: +resAuto.toFixed(3), rung: resRung, flips: resFlips, locked: resLocked,
      gpuMs: +gpuMs.toFixed(2), want: 1000 / S.targetFps,
      px: [renderer.getContext().drawingBufferWidth, renderer.getContext().drawingBufferHeight] };
  },
  resetRes: () => { resetResGovernor(); applyRes(); return { rung: resRung, auto: resAuto }; },
  setRes: (v) => { S.res = Math.max(0.4, Math.min(2, +v)); resetResGovernor(); applyRes(); },
  markCounts: () => ({ ...markWhy }),
  profAll: () => {
    const n = Math.max(1, prof.frames);
    const out = { frames: prof.frames };
    for (const k of PROF_KEYS) out[k] = +(prof[k] / n).toFixed(2);
    out.total = +(profSum(prof) / n).toFixed(2);
    return out;
  },
  // The raw sums. A per-frame cost derived by differencing two rounded *means* is off by
  // (0.005 ms x frames), which at a few thousand frames is several ms - enough to make a bucket look
  // negative and a frame look 85 ms fat. Any probe that wants one frame's cost must difference sums.
  profTotals: () => ({ ...prof }),
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
    cutByCell: Object.fromEntries([...cutByCell].map(([c, e]) => [c, +e.ms.toFixed(2)])),
    deferredBig: patchDeferredBig, forced: patchForced, cappedIdle: patchCappedIdle,
    stolen: patchStolen, stealMs: S.patchStealMs,
    jobs: patchJobs.size, outside: patchOutside, posted: patchPosted, dropped: patchDropped,
    detailMarks: patchDetailMarks,
    caps: [...shellMeshes.values()].reduce((s, e) => s + (e.caps || 0), 0),
    estVerts: Math.round(gridColumns() * vertsPerColumn()), budget: S.vertBudget,
    cellPx: S.cellPx * costScale,
    verts: [...shellMeshes.values()].reduce((a, e) => a + (e.verts || 0), 0),
    tiers: [...shellMeshes.values()].map((e) => e.tier).sort() }),
  tick: (n = 1, dt = 16) => { const t = performance.now(); for (let i = 0; i < n; i++) frameBody(t + (i + 1) * dt); return loopFrames; },
  // The panel owns the settings, but the camera is not a setting: the zoom slider was removed (the
  // wheel does it) so 'dist' has to be answered here or a probe asking for a zoom gets a shrug.
  // A probe must be able to check that a control survived a rewrite of the panel: the panel is DOM,
  // so no Node test can import it, and a silently missing control is the failure mode of every
  // find-and-replace over the settings list.
  panelKeys: () => (panel ? panel.keys() : []),
  panelWidth: () => (panel ? panel.widthPx() : 0),
  // The overlay's own facts, so a probe can check what a viewer would see rather than what the code
  // intends: material opacity read back off the material, tile visibility read back off the mesh.
  overlay: () => ({
    tiles: !!S.timeTiles, op: S.decalOp, shrink: S.decalShrink,
    heatOp: ledgerHeatMat ? +ledgerHeatMat.opacity.toFixed(3) : null,
    heatInset: +heatInset().toFixed(2),
    timeOp: timeDecalMat ? +timeDecalMat.opacity.toFixed(3) : null,
    timeVisible: TLAYER.mesh ? TLAYER.mesh.visible : false,
    setTiles, setDecalOp, setDecalShrink,
  }),
  // M11/M14 walk mode, in the shape a probe needs it: on/off, how far ahead the world is kept, where
  // the eye actually is, and a way to put the body somewhere without a keyboard.
  walk: (...a) => (a.length ? setWalk(!!a[0]) : walk.on),
  // Flight is not a second mover, so a probe switches the same flag the panel and ?view=fly set.
  fly: setFly,
  reach: (...a) => (a.length ? setReach(+a[0]) : walk.reach),
  eye: () => ({ x: rig.target.x, y: rig.target.y, z: rig.target.z, yaw: rig.yaw, pitch: rig.pitch,
    locked: document.pointerLockElement === canvas, reach: walk.reach, fly: walk.fly,
    // The body's own facts, asked of the voxels on demand rather than remembered from the last frame:
    // a column that was not held a frame ago answers differently now, and a probe reading a stale
    // answer is how working collision looks broken.
    feet: player.y, onGround: player.onGround, frozenFrames: walk.frozenFrames, vy: player.vy,
    cell: cellAt(Math.floor(player.x), Math.floor(player.y), Math.floor(player.z)),
    // 0 means the whole 0.6 x 1.8 box is clear of every solid voxel. Anything else says which kind of
    // cell the body is standing inside, and it is the invariant a walk measurement has to hold.
    clear: playerHits(cellAt, player.x, player.y, player.z),
    floor: playerFloorTop(cellAt, player.x, player.y, player.z) }),
  body: () => ({ x: player.x, y: player.y, z: player.z, vy: player.vy, onGround: player.onGround,
    frozen: player.frozen, climbing: player.climbing, inWater: player.inWater,
    // `fell` is how far this body has dropped since it last stood, so it reads 0 the moment it lands.
    // `lastFall` is the fall it just finished - the number a fall probe has to quote.
    fell: +(player.fell ?? 0).toFixed(2), lastFall: +walk.landed.toFixed(2),
    embeddedFrames: walk.embedded, unstuck: walk.unstuck }),
  stand: (drop = 8) => standPlayer(drop),
  // Put the body somewhere by its FEET and let go: no snapping to the floor, no guessing. This is how
  // a fall is measured - from a known height, with vy 0, and then frame by frame.
  drop: (x, feetY, z) => {
    if (!walk.on) setWalk(1);
    player.x = +x; player.y = +feetY; player.z = +z;
    player.vy = 0; player.onGround = 0; player.frozen = 0; player.fell = 0;
    walk.embedded = 0; walk.placed = 1;
    syncEye(); updateCamera(); updateView(); requestAround();
    return [player.x, player.y, player.z];
  },
  walkTo: (x, y, z) => {
    if (walk.on) {
      player.x = +x; player.z = +z; player.y = +y - BODY.eye; player.vy = 0;
      standPlayer();
    } else rig.target.set(+x, +y, +z);
    updateCamera(); updateView(); requestAround();
    return [rig.target.x, rig.target.y, rig.target.z];
  },
  look: (y, p) => {
    rig.yaw = +y; rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, +p));
    updateCamera(); updateView();
    return [rig.yaw, rig.pitch];
  },
  presets: () => Object.keys(PRESETS),
  presetKeys: () => Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, Object.keys(p.s)])),
  set: (k, v) => {
    if (k === 'dist') { rig.dist = Math.max(2, Math.min(S.maxZoom, +v)); updateView(); requestAround(); return rig.dist; }
    if (k === 'walk' || k === 'walkfly') { if (panel) panel.set(k === 'walk' ? 'walk' : 'wfly', v); return walk.on; }
    const key = { far: 'skinCap', detail: 'radius', world: 'dim' }[k] ?? k;
    return panel ? panel.set(key, v) : undefined;
  },
  fit: () => fitWorld(),
  switchDim,
  dims: () => (meta?.dims ?? []).map((d) => d.id),
  dim: () => currentDim(),
  ground: groundDiag,
  groundReload: () => groundLoad(currentDim()),
  groundAsk: (cx, cz) => ({ has: GROUND.has(cx, cz), known: !!GROUND.reader }),
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
  // Caps are geometry, not colour: the only way to change them is to re-cut. The baked tiles
  // take care of themselves at the top of this function, because caps are part of the policy a tile
  // has to agree with.
  if (what === 'caps') {
    for (const [pk] of shellMeshes) dirtyAdd(pk, 'apply');
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
    if (store) for (const k of [...meshes.keys()]) markChunk(k, 'settings');
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

// ---- region coverage -------------------------------------------------------
// Which (rx,rz) region files this save actually has.
//
// A save's bounding box is not its coverage: the overworld spans 1,734 region cells and holds 437
// files, so three quarters of the box is ground that was never written. The server already answers a
// tile inside such a rectangle with an all-empty batch, but the page still pays the request, the
// round trip and the queue slot - and for a camera parked over void that empty queue work is all it
// ever has. One 637-byte fetch lets the store answer "nothing can be here" locally.
//
// The rule that keeps this safe, same as the server's: absence here is an optimisation, never truth.
// While the listing is unknown - not fetched yet, a failed fetch, a dimension the server does not
// know - the answer is "ground" and the request goes out. So the listing also has to age: see
// groundMaybeRefresh, and note that a load clears the reader before it re-asks, because an answer
// for the dimension we just left is not an answer about this one.
const GROUND = {
  reader: null,          // makeReader() over the packed grid, or null while unknown
  dim: '', gen: 0, err: '', atMs: 0, ms: 0, cells: 0, w: 0, h: 0, x0: 0, z0: 0,
  inflight: 0, loads: 0,
  // The store asks through these two, so a dimension switch or a late answer needs no re-wiring.
  hasAny: (cx0, cz0, cw, ch) => (GROUND.reader ? GROUND.reader.hasAny(cx0, cz0, cw, ch) : true),
  has: (cx, cz) => (GROUND.reader ? GROUND.reader.has(cx, cz) : true),
};

async function groundLoad(id = currentDim()) {
  const gen = ++GROUND.gen;
  GROUND.reader = null;                    // fail open while asking, whatever it said before
  GROUND.inflight++;
  const t0 = performance.now();
  try {
    const r = await fetch(`/regions?dim=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const wire = await r.json();
    if (gen !== GROUND.gen) return null;   // an answer about a dimension we already left
    GROUND.reader = makeReader(fromWire(wire));
    GROUND.dim = id;
    GROUND.cells = wire.cells ?? 0;
    GROUND.w = wire.w ?? 0; GROUND.h = wire.h ?? 0;
    GROUND.x0 = wire.x0 ?? 0; GROUND.z0 = wire.z0 ?? 0;
    GROUND.err = '';
    GROUND.atMs = performance.now();
    GROUND.ms = GROUND.atMs - t0;
  } catch (e) {
    // Fail open: the reader stays null, every tile is ground, and the diagnostic says why.
    if (gen === GROUND.gen) { GROUND.reader = null; GROUND.err = String(e?.message ?? e); }
  } finally {
    GROUND.inflight--;
    GROUND.loads++;
  }
  return groundDiag();
}

function groundDiag() {
  return {
    dim: GROUND.dim, known: !!GROUND.reader, cells: GROUND.cells,
    grid: `${GROUND.w}x${GROUND.h}`, x0: GROUND.x0, z0: GROUND.z0,
    err: GROUND.err, fetchMs: +GROUND.ms.toFixed(1), loads: GROUND.loads,
    ageMs: GROUND.atMs ? Math.round(performance.now() - GROUND.atMs) : null,
    inflight: GROUND.inflight, setting: !!S.groundCov, ttlMs: S.groundTtlMs,
    // what the store did with the answer
    skipped: store?.covSkipped ?? 0, slots: store?.covSlots ?? 0,
    shellSkipped: shellStore?.covSkipped ?? 0, shellSlots: shellStore?.covSlots ?? 0,
  };
}

/** True when this call started a fetch. Never more than one in flight, and never before the TTL. */
function groundMaybeRefresh(now) {
  if (!S.groundCov || GROUND.inflight) return false;
  if (GROUND.atMs && now - GROUND.atMs < S.groundTtlMs) return false;
  groundLoad(currentDim());
  return true;
}

const storeOpts = () => ({
  tile: +(params.get('tile') ?? 6),
  // Evicting chunks the camera is about to look at again is how a view starts popping: keep
  // room for the whole requested radius plus a margin, and let ?maxchunks override for tests.
  maxChunks: +(params.get('maxchunks') ?? Math.max(400, (2 * S.radius + 5) ** 2)),
  // A dirty mark the store makes is a mesh job (tens of ms) waiting to happen, so the view box can
  // say which marks became work and which did not.
  onDirty: (k, why) => tagDirty(k, why),
  coverage: S.groundCov ? GROUND : null,
});

function makeShellStore(dim) {
  shellStore = new ShellStore(dim, {
    // Shells are 1 KB, so batches are much bigger than the voxel tiles; 16x16 is ~266 KB.
    tile: +(params.get('shelltile') ?? 16),
    keep: +(params.get('shellkeep') ?? Math.max(4, S.skinCap + 2)),
    maxConcurrent: +(params.get('shellconc') ?? 3),
    // The skin asks for a much wider square than the detail ring, so it is the layer that spends the
    // most requests on ground this save never had: 943 shell tiles for one 8-hop pan, against 65
    // voxel tiles. Same answer, same fail-open rule.
    coverage: S.groundCov ? GROUND : null,
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
  groundLoad(id);                          // the old answer describes the dimension we just left
  applyDetailBudget();

  for (const e of [...shellMeshes.values()]) for (const m of [e.mesh, e.mesh2]) if (m) { shellGroup.remove(m); m.geometry.dispose(); }
  shellMeshes.clear(); patchTier.clear(); dirtyPatches.clear(); cutByCell.clear(); recountShellVerts();
  if (shellStore && S.shellOn) makeShellStore(id);
  clearLodMeshes();
  if (lodStore) lodStore.clear();
  if (S.lod && S.shellOn) { makeLodStore(id); lodIndexLoad(lodStore); } else lodStore = null;
  if (S.overview) loadOverview(id); else clearOverview();
  // M12: the ledger index is per dimension, and so is the question being asked of it.
  LEDGER.gen++;
  LEDGER.pack = null; LEDGER.cells = []; LEDGER.max = 0; LEDGER.top = null;
  clearLedgerMesh();
  closeLedgerCard();
  if (S.ledger) ledgerLoad(); else panel?.refresh();
  // M12b: and so is its timeline. A stale timeline would animate another dimension's history over
  // this dimension's cell table, which is the one ledger bug that would look like a correct picture.
  TLAYER.gen++;
  TLAYER.tl = null; TLAYER.err = ''; TLAYER.bytes = 0; TLAYER.fetchMs = 0;
  clearTimeMesh();
  if (S.time) timeLoad();
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

// Four combinations, named the way people ask for them. Every key here is a control in the panel,
// and the panel is what applies them, so a preset cannot name a setting that no longer exists and
// quietly do nothing - it names a control, and the control knows what else has to be invalidated.
// `dist: 0` means "fit the world", which is a runtime number rather than a stored one.
const PRESETS = {
  'whole world': { dist: 0, s: { walk: false,
    radius: 8, farsharp: 1.5, lodtiles: true, lodquality: 100, shellon: true, overview: false,
    detailPixels: true, lodcap: 8, maxradius: 96, vertbudget: 12000000, fog: 0, caves: false } },
  'walk around': { s: { walk: true,
    radius: 10, farsharp: 1, lodtiles: true, lodquality: 50, lodcap: 8, caves: true,
    shadow: 0.58, cave: 0.32, daylight: 1, clarity: 0.5, fog: 0 } },
  'caves': { dist: 150, s: { walk: false,
    caves: true, darkcut: 0, buried: 0, surface: false, underfar: false, cave: 0.45,
    daylight: 0.6, radius: 12, farsharp: 1, lodtiles: true } },
  'fast': { s: { walk: false,
    radius: 6, farsharp: 2, lodquality: 100, lodtiles: true, res: 0.7, resAuto: 1,
    budget: 6, sbudget: 8, caves: false, fog: 0 } },
};

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
  // Nine controls are out in the open, because that is what people reach for: which world, how much
  // of it is built block by block, how far that reaches, how coarse the cheap world may get, whether
  // the unlit underground is drawn, and three numbers about how it is shaded. Everything else lives
  // in three closed groups - a group only shows its name until you open it - and a further twenty
  // tuning knobs left the panel altogether (see HANDOFF.md for their URL names). The zoom slider is
  // gone: the wheel, or a drag on empty sky, already does it.
  const items = [
      { key: 'dim', label: 'world', kind: 'select', options: dims,
        hint: 'Which world to look at. Switching keeps every setting and drops nothing but the loaded chunks.',
        get: () => currentDim(), set: (v) => switchDim(v) },
      { key: 'walk', label: 'walk around (V)', kind: 'check', live: false,
        fmt: (v) => (v ? `on - ${Math.round(walk.reach)} m` : 'off - orbit'),
        hint: `You walk in a body: 0.6 blocks wide, 1.8 tall, eye at 1.62, with weight and voxel
collision - a jump that clears one block, and a step that climbs a stair but not a fence. WASD walks,
Space jumps, held Ctrl sprints, Shift sneaks (down, and off a ledge). The wheel stops meaning zoom and
starts meaning how much world stays drawn ahead of you. Click the picture to look with the mouse
(Escape gives the cursor back) - or drag, which has always worked. Nothing is faked for this mode: the
block-by-block ring, the far grid's tier and the baked world all follow the eye instead of the orbit
point, which is what looking out over a valley costs. URL: ?view=walk, ?view=fly, ?reach=`,
        get: () => !!walk.on, set: (v) => setWalk(v) },
      { key: 'reach', label: 'walk view depth', min: 96, max: 1600, step: 32, live: false,
        fmt: (v) => `${v | 0} m`,
        hint: 'How far ahead of the eye the world is kept drawn: the heightmap skin, the far grid and\nthe baked tiles all stop reaching past it, and the ground beyond is simply not requested. The wheel\nsets the same number while walking. It cannot go below the skin floor (?minradius, 640 m by\ndefault) - that much heightmap is held around the eye at any setting. URL: ?reach=',
        get: () => S.walkReach, set: (v) => setReach(v) },
      // The useful range is small (a handful of chunks) and the reach is long (the whole view), which a
      // linear 0..24 bar cannot do: it crowded 4, 8, 12, 16 and 24 into a quarter of the track and made
      // 64 unreachable. The stops are the values the measurements actually land on.
      { key: 'radius', label: 'close detail', live: false,
        // The whole bar reaches 32 chunks (512 m). Not further: at a 300 m orbit the ring also
        // decides how much voxel data the tab holds, and 32 was already 5 076 chunks and 418 MB of
        // payload. Beyond that the URL (?radius) is the escape hatch, not the thumb.
        stops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 32],
        fmt: (v) => (!v ? 'off' : (S.detailPixels && detailR < v ? `now ${detailR}c of ${v}c` : `${v * CH} m - ${v}c`)),
        hint: 'The most terrain built block by block with real textures, around what you look at - a\nceiling, not a promise: zoom out and less of it is drawn, because far away those triangles are\nsmaller than a pixel, and the far view takes over. Priced at a 300 m orbit, whole frame:\n8 chunks = 12 M verts and 840 chunks of world data; 12 = 21 M, 1 400; 16 = 32 M, 2 000;\n24 = 58 M, 3 700 and 310 MB; 32 = 79 M, 5 000 and 420 MB, which stops being a frame rate. The\nwheel costs nothing, so pull in before raising this. URL: ?radius',
        get: () => S.radius, set: (v) => { S.radius = Math.max(0, v | 0); applySettings('radius'); } },
      { key: 'detailPixels', label: 'sharp far centre', kind: 'check', live: false,
        // The row says the distance the pixels allow, because that is the number a slider cannot
        // reach: past it, "close detail" is simply not honoured at that zoom.
        fmt: () => (S.detailPixels ? `on - to ${Math.round(detailReach(pxPerRad()))} m` : 'off - any zoom'),
        hint: `Whether the block-by-block ground is worth building where one block is smaller than a
pixel. On, the sharp ring stops at that point and the far world paints the rest: at a 1 200 m
orbit that is 727 chunk meshes and 19 s of worker CPU per pan becoming 102 and 2.7 s, settling in
1 s instead of 3, 57 fps after the pan becoming 240 - for 2.7 % of the pixels. Off, the sharp
island stays at whatever "close detail" says at any zoom. URL: ?detailpixels=0, ?nodetailpixels`,
        get: () => !!S.detailPixels,
        set: (v) => { S.detailPixels = v ? 1 : 0; applySettings('detailpx'); } },
      { key: 'farsharp', label: 'far detail', min: 1, max: 6, step: 0.25,
        fmt: (v) => `${v} px`,
        hint: 'How small a block may get in the cheap far terrain before it is merged with its\nneighbours. Lower is sharper and costs more. URL: ?cellpx',
        get: () => S.cellPx, set: (v) => { S.cellPx = Math.max(0.5, v); applySettings('lod'); } },
      { key: 'lodtiles', label: 'baked far world', kind: 'check', live: false,
        hint: 'The whole world below 16 blocks per column, pre-meshed on the server\n(npm run bake:lod) and streamed as region tiles, instead of being meshed in the browser on\nevery pan and zoom. Off restores live far meshing. URL: ?nolod',
        get: () => !!S.lod && lodAvail ? 1 : 0,
        set: (v) => {
          S.lod = v ? 1 : 0;
          if (S.lod && !lodStore && lodAvail) makeLodStore(currentDim());
          if (!S.lod) { clearLodMeshes(); }
          applySettings('lodtiles');
        } },
      { key: 'lodquality', label: 'far world quality', min: 0, max: 100, step: 5, live: false,
        fmt: (v) => `${[1, 1, 2, 2, 4, 4, 8, 8, 16, 16, 16][Math.round(v / 10)]} blk max`,
        hint: 'How far the LOD is allowed to drop in quality: the coarsest column the far view may use,\napplied where a coarse column would really be a blob on screen. 100 is today: 16-block columns at the\nhorizon, which is why a distant tree is one column and a distant house is a slab. Pull it in for shape\nand pay vertices: finer than the baked rungs (4 blocks) the live far grid has to draw that ground itself,\nand the baked tiles keep their rung instead of leaving a hole. URL: ?lodquality',
        get: () => S.lodQuality,
        set: (v) => { S.lodQuality = Math.max(0, Math.min(100, v | 0));
          S.lodMaxCell = [1, 1, 2, 2, 4, 4, 8, 8, 16, 16, 16][Math.round(S.lodQuality / 10)];
          applySettings('lod'); } },
      { key: 'caves', label: 'mesh unlit caves', kind: 'check', live: false,
        hint: 'Off (default) does not draw faces no light touches - the rock deep in a cave, the back of\n a tunnel. They were the majority of the vertex and mesh-time budget for something no\n camera can see. On draws every face, which is the old behaviour. URL: ?caves=1',
        get: () => S.caves, set: (v) => { S.caves = v ? 1 : 0; applySettings('light'); } },
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
      { key: 'clarity', label: 'water clarity', min: 0, max: 0.8, step: 0.02,
        fmt: (v) => `${Math.round(v * 100)}%`,
        hint: 'How much you can see through water and ice. URL: ?water',
        get: () => 1 - S.water, set: (v) => { S.water = 1 - v; applySettings('water'); } },
      { kind: 'note', key: 'note_zoom', text: () => (walk.on
        ? 'the wheel is how much world stays drawn ahead - click the picture to look with the mouse'
        : 'zoom with the mouse wheel - drag on empty sky to look around') },
      { kind: 'section', key: 'sec_walk', label: 'walking', open: false,
        hint: 'The body you walk in: how fast it moves, how heavy it is, and what it collides with.' },
      { key: 'wspeed', label: 'walk speed', min: 1, max: 24, step: 0.1, live: false,
        fmt: (v) => `${(+v).toFixed(1)} blocks/s`,
        hint: 'A player in the game walks 4.317 blocks/s and sprints 5.613, and that is the default.\nAbove about that a 0.6 block wide body stops feeling like it is walking. URL: ?wspeed=',
        get: () => S.walkSpeed, set: (v) => { S.walkSpeed = Math.max(0.5, +v); } },
      { key: 'wsprint', label: 'sprint multiplier (Ctrl)', min: 1, max: 3, step: 0.05, live: false,
        fmt: (v) => `${(+v).toFixed(2)}x`,
        hint: 'Held Ctrl. The game sprints at 5.613 / 4.317 = 1.30x. URL: ?wsprint=',
        get: () => S.walkSprint, set: (v) => { S.walkSprint = Math.max(1, +v); } },
      { key: 'wgravity', label: 'gravity', min: 0, max: 64, step: 1, live: false,
        fmt: (v) => `${v | 0} b/s\u00b2`,
        hint: 'The game falls at 0.08 blocks per tick per tick = 32 blocks/s\u00b2, which is the default.\nZero means you hover: no jump arc, no fall, and a floor stops meaning much. URL: ?gravity=',
        get: () => S.walkGravity, set: (v) => { S.walkGravity = Math.max(0, +v); } },
      { key: 'wjump', label: 'jump', min: 0, max: 16, step: 0.2, live: false,
        fmt: (v) => `${(+v).toFixed(1)} b/s up`,
        hint: 'Space. The game leaves the ground at 8.4 blocks/s, which with gravity 32 clears 1.25\nblocks - exactly one block of step, which is why a player can climb a stair and not a fence. URL: ?jump=',
        get: () => S.walkJump, set: (v) => { S.walkJump = Math.max(0, +v); } },
      { key: 'wsneak', label: 'sneak speed (Shift)', min: 0.2, max: 4.317, step: 0.05, live: false,
        fmt: (v) => `${(+v).toFixed(2)} blocks/s`,
        hint: 'Shift on foot: you crawl, and the body will not walk off the edge of a block. In the game\nthat is 1.3 blocks/s. In water, on a ladder or in flight, Shift means down instead. URL: ?wsneak=',
        get: () => S.walkSneak, set: (v) => { S.walkSneak = Math.max(0.2, +v); } },
      { key: 'wfly', label: 'free flight', kind: 'check', live: false,
        fmt: (v) => (v ? 'no gravity, no walls' : 'weight and collision'),
        hint: 'The same mover with the collision probes off: gravity is still there, walls are not. Good\nfor looking at a mountain from above without climbing it, and what ?view=fly / ?noclip start in.\nComing back out of flight lets the voxels place the body again. URL: ?view=fly',
        get: () => !!S.walkFly, set: (v) => setFly(v) },
      { key: 'wlook', label: 'mouse-look speed', min: 0.0005, max: 0.01, step: 0.0005, live: false,
        fmt: (v) => `${(+v).toFixed(4)} rad/px`,
        hint: 'Click-to-lock mouse-look only; a drag has always been 0.006 rad/px and still is.\nURL: ?look=',
        get: () => S.walkSens, set: (v) => { S.walkSens = Math.max(0.0004, +v); } },
      { kind: 'section', key: 'sec_ledger', label: 'who placed this, and when', open: false,
        hint: 'The world keeps a ledger of block actions - 424,599 of them here, 351,531 in this\n'
          + 'dimension across 20,322 chunks. It answers who touched a block, and where the map has\nhistory worth visiting.' },
      { key: 'ledger', label: 'activity overlay', kind: 'check',
        fmt: () => (S.ledger ? `on, ${LEDGER.quads.toLocaleString()} decals` : 'off'),
        get: () => !!S.ledger, set: (v) => setLedger(v),
        hint: 'paint every chunk the ledger has rows for, coloured by how much happened there:\nteal a handful, amber hundreds, red thousands. The loudest chunk here holds 4,254 rows and\nthe median touched chunk holds 3, so the colour scale is logarithmic. One 674 KB request per\ndimension, then a re-cut per filter change - never per frame. L.' },
      { key: 'ledgerCls', label: 'kind of action', kind: 'select', options: ledgerClassOptions(),
        get: () => S.ledgerCls, set: (v) => { S.ledgerCls = +v || 0; ledgerRebuild(); },
        hint: 'which kind of row to count. block-place and block-break are what a player building\nlooks like; any kind also counts fire spreading, water flowing, decay, trampling and kills,\nwhich is where the map turns red for no human reason.' },
      { key: 'ledgerWho', label: 'whose actions', kind: 'select', options: ledgerWhoOptions(),
        get: () => S.ledgerWho, set: (v) => { S.ledgerWho = +v || 0; ledgerRebuild(); if (S.time) timeRebuild(); },
        hint: 'attribute the overlay to one named player. anybody leaves in the 301,367 rows the log\ndoes not attribute to a player: fluid, fire, growth, mobs.' },
      { key: 'ledgerMin', label: 'quietest chunk', min: 0, max: 400, step: 1,
        stops: [1, 2, 4, 8, 16, 32, 64, 128, 256, 400], fmt: (v) => `${v} row${v === 1 ? '' : 's'}+`,
        get: () => S.ledgerMin, set: (v) => { S.ledgerMin = Math.max(0, +v || 0); ledgerRebuild(); },
        hint: 'throw away the quiet chunks. most touched chunks hold two or three rows of something\nfalling over, and they are the bulk of the 20,322 decals; the floor is how you find the few that\nmatter, and it costs fill rather than requests. Panel stops, URL exact (?ledgermin=).' },
      { key: 'ledgerXray', label: 'see through terrain', kind: 'check',
        fmt: () => (S.ledgerXray ? 'flat paint shows through - blocks still obey walls' : 'hills hide them'),
        get: () => !!S.ledgerXray,
        set: (v) => { S.ledgerXray = v ? 1 : 0;
          if (ledgerHeatMat) ledgerHeatMat.depthTest = !S.ledgerXray;
          if (timeDecalMat) timeDecalMat.depthTest = !S.ledgerXray; },
        hint: 'an overlay that sits on the ground is honest and unreadable at whole-world scale: the hill\nin front of the valley hides the valley. Painting through the terrain turns it into a map of the\nlog; turn it off to ask whether the activity is visible from where you are. This switch only moves\nthe FLAT layers (heat tiles, and change tiles if a change looks like a tile): a change drawn as its\nown block always obeys walls, because a block seen through a house is a lie. URL: ?noledgerxray' },
      { key: 'hoverOn', label: 'outline under the cursor', kind: 'check', live: false,
        fmt: () => (HOVER.at ? `${HOVER.at.join(', ')} - ${HOVER.from}` : (HOVER.why || 'off')),
        hint: 'A wire box around the one block the cursor is on, so "what did I just point at" has an\nanswer without clicking. It turns the change-layer green when the playhead has a logged change drawn on\nthat voxel, which is a Map lookup (0.0005 ms) rather than a ray against the marker buffer (42 ms).\nThe pick itself is 17.5 ms at the house framing, so it only runs when the cursor, the camera or the\nplayhead moved, and never during an orbit drag. Two colours (pale outside, dark inside) because a\nsingle-colour outline vanishes on either grass or deepslate. One box, reused.\nURL: ?nohover, ?hoverms=',
        get: () => !!S.hover, set: (v) => { S.hover = v ? 1 : 0; if (!S.hover && hoverBox) hoverBox.visible = false; if (panel) panel.refresh(); } },
      { key: 'time', label: 'time machine', kind: 'check',
        fmt: () => (S.time ? `on - ${(TLAYER.drawn ?? 0).toLocaleString()} / ${(TLAYER.quads || 0).toLocaleString()}` : 'off'),
        get: () => !!S.time, set: (v) => setTime(v),
        hint: 'The other ledger layer: this one is sorted by TIME, not by chunk, and it draws one marker per\nlogged change that has happened by the playhead. Costs one 6.4 MB request for this dimension\n(/ledger/timeline, 351,531 rows) and one mesh; moving the playhead is a draw range, not a rebuild, so two\nyears of history play at frame rate. A FILTER change is the only rebuild: about 100 ms for a whole\ndimension, 35 ms for one player. Ticking this also arms "undo the log in the blocks too" unless you have\ntoggled that yourself, and it starts PLAYING at the first logged change: second 0 of this log is the oldest\ncalendar instant, and the server logged nothing for its first 8.5 hours, so an empty map at second 0 is\nwhat a tick used to look like. Ask for paused (?timeplay=0) and it starts at the end instead, with every\nchange the filter holds drawn, and you scrub back. M. URL: ?time=1' },
      { key: 'timeLook', label: 'a change looks like', kind: 'select',
        options: [{ value: 'blocks', label: 'the block itself, tinted' },
          { value: 'plates', label: 'the top face of the block, tinted' },
          { value: 'tiles', label: 'a flat coloured tile' }],
        get: () => S.timeLook, set: (v) => setTimeLook(v),
        hint: 'The baked model of the block itself, tinted green for a place or red for a break, is what\nmakes a marker readable close in: a green square on a roof does not say deepslate brick. It is also\nfour times the geometry, and it costs frames. Measured in the page over the 89,613-marker place\nfilter of this dimension: blocks 2.21 M verts / 38 MB / 0.2 s to build / 74 fps, plates 0.47 M verts / 8.1 MB /\n0.05 s / 179 fps, flat tiles 0.36 M verts / 6.2 MB / 0.01 s / 216 fps. Past "overlay memory" below the\nlook steps down on its own, and the sentence under the playhead says which it chose and why.\nURL: ?timelook=plates' },
      { key: 'timeGeomMb', label: 'overlay memory', min: 4, max: 512, step: 4,
        fmt: (v) => `${Math.round(v)} MB max`, get: () => S.timeGeomMb,
        set: (v) => { S.timeGeomMb = Math.max(2, Math.min(2048, +v || 4)); if (S.time) timeRebuild(); },
        hint: 'The ceiling a block-shaped replay may reach, in the MB the marker builder counts (MiB). The\nplace filter fits at the 128 default: 66 MB allocated, 38 MB of it positions plus indices on the GPU,\n0.2 s to build, 74 fps over this 12.6 M-vert scene. The break filter does not fit either way (245 MB as\nblocks, 170 MB as plates), so it steps to plates, says so under the playhead, and draws anyway because\nthat is what was asked - 37 fps with all 202,376 of them up. Set it to what your machine will hold.\nURL: ?timegeommb=' },
      { key: 'timeTiles', label: 'draw the change markers', kind: 'check',
        fmt: () => (S.timeTiles ? `${(TLAYER.drawn ?? 0).toLocaleString()} tiles` : 'off - the blocks speak'),
        get: () => !!S.timeTiles, set: (v) => setTiles(v),
        hint: 'The time machine has two halves: flat tiles over every block the log touched, and the blocks\nthemselves corrected back to the playhead ("undo the log in the blocks too", below). Tiles are the cheap\nhalf - one mesh, a draw range per frame, 90,045 quads for this dimension\'s places - but a tile per\nlogged change over a canopy hides the very world it is describing. Off leaves the playhead, the date\nand the terrain undo working, which is the "watch the house get built" view with nothing in the way.\nM still brings the layer back. URL: ?timetiles=0' },
      { key: 'decalop', label: 'overlay strength', stops: [0.15, 0.3, 0.45, 0.6, 0.8, 1],
        fmt: (v) => `${Math.round(100 * v)}% solid`, get: () => S.decalOp, set: (v) => setDecalOp(v),
        hint: 'How solid both ledger overlays are - the per-chunk heat tiles and the per-change time tiles. They\nsit a fraction of a block above the ground, so at full strength they are a floor of paint over whatever\nthey describe; 45% is where 90,045 place tiles over a canopy still read as canopy. URL: ?decalop=' },
      { key: 'decalshrink', label: 'tile inset', stops: [0.4, 0.6, 0.7, 0.82, 0.92, 1],
        fmt: (v) => `${Math.round(100 * v)}% of the block`, get: () => S.decalShrink, set: (v) => setDecalShrink(v),
        hint: 'The cheaper fix, and the one that does not cost fill: each tile is drawn smaller than what it\ncovers, so the block\'s own edge and the seam between chunks stay open and the overlay stops welding\nitself into one sheet. A heat tile is 16 x 16 blocks, a time tile is one, so one number sizes both.\nRe-cuts the overlay meshes (about 100 ms for a dimension). URL: ?decalshrink=' },
      { key: 'timeAt', label: 'playhead', min: 0, max: 1000, step: 1, live: true, valw: 132,
        get: () => timePermille(), set: (v) => timeSeekRow(timeRowAt(+v)),
        // Dragging moves up to a thousand rows of the cursor; the voxel undo self-throttles to one sync per
        // 64 rows (0.1 ms to mark), so the tiles follow the thumb and the blocks land when the thumb stops.
        end: () => histSync(true),
        fmt: () => (TLAYER.tl ? timeStamp(playhead(TLAYER.tl, TLAYER.sec).ms) : '-'),
        hint: 'Permille of THIS FILTER\'s rows drawn, oldest first - deliberately not a date slider, because a\ndate slider shows nothing at all across the 813 of 822 days with no logged change. The value column is\nthe wall clock at the playhead. The tiles follow the thumb; the blocks re-cut when you let go\n(or every 64 rows while dragging). Drag to scrub, K to play. URL: ?timeat=<seconds since the first row>' },
      { key: 'timePlay', label: 'play (K)', kind: 'check',
        fmt: () => (S.timePlay ? `${S.timeSpeed.toLocaleString()}/s` : 'paused'),
        get: () => !!S.timePlay, set: (v) => setTimePlay(v),
        hint: 'The playhead, not the frame: a slow machine shows less history per frame rather than wrong\nhistory. Reaching the end of the log stops; K from the end restarts at the first logged change, not at\nthe oldest calendar second.' },
      { key: 'timeSpeed', label: 'changes per second', stops: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2500, 5000, 20000, 80000, 250000],
        typeable: true, numMin: 0.05, numMax: 500000, numStep: 1, valw: 96,
        fmt: (v) => `${(+v).toLocaleString()}/s`, get: () => S.timeSpeed,
        set: (v) => { S.timeSpeed = Math.max(0.05, Math.min(5e5, +v || 1)); },
        hint: 'Logged changes per wall-clock second, because that is the only rate that works here: this\nserver logged activity on 9 of the 822 days its log spans, and one of those days holds 83,101 rows. A\nplayhead driven by the calendar would sit still for a month and then blur. The thumb names 15 rates\nfrom 1/s to 250,000/s, and the box beside it takes any number you type: at 1/s you watch one block\nappear per second, at 5/s one player\'s 9,651 places take half an hour, at 20,000/s the whole overworld\nlog plays in 18 s. The sentence below does that arithmetic. URL: ?timespeed=' },
      { key: 'timeCls', label: 'replay which action', kind: 'select', options: timeClassOptions(),
        get: () => S.timeCls, set: (v) => { S.timeCls = +v || 0; timeRebuild(); },
        hint: 'Which rows get a marker, and what colour it is. Blocks only is the one that reads as building:\n90,045 place rows against 202,826 break rows. The playhead counts THIS filter, so switching mid-play\nkeeps the fraction of the filtered history, not the date. Triangles as drawn here: the place set 1.1 M\n(74 fps), the break set 3.0 M as plates (37 fps), any change 3.3 M as plates (25 fps). Pick the filter for\nthe story you want, not for completeness.' },
      { key: 'timeTerrain', label: 'undo the log in the blocks too', kind: 'check',
        fmt: () => (S.timeTerrain ? `${histTotals().chunks.toLocaleString()} chunks, ${histTotals().edits.toLocaleString()} blocks` : 'off'),
        get: () => !!S.timeTerrain, set: (v) => { S.timeTerrain = v ? 1 : 0; S.timeTouched = 1; histSync(true); },
        hint: 'Not a decal: the voxels. Walking the playhead back re-cuts the detail chunks in view with every\nlogged change after it reversed - a block broken after the playhead stands again, a block placed after it\nis gone - which is the difference between watching dots appear and watching the house get built. The answer is asked per voxel: what the last logged change at or\nbefore the playhead left standing there - or, if none did, what its OLDEST row covered, which is what a block\nthat had not arrived yet was sitting on. Only rows in the filter above count, so the default "block place"\nfilter un-builds but leaves what was broken alone: switch "replay which action" to "any change" for both.\nThe work is bounded by the LOG per chunk rather than by the size of the world: this\ndimension has 20,322 touched chunks and its loudest holds 4,254 rows. Only the sharp layer is corrected:\nthe baked far tiles and the heightmap skin keep showing today, so zoom out and you see today. Two limits\ncome from the log itself, not from this viewer - block_state is filled for 2,828 of its 424,599 rows, so a\nrestored block is chosen by NAME and gets the plainest state the atlas holds (a stair comes back facing a\ndefault way, not the way it was placed); and light is not re-simulated, so a block coming back inside a\ntunnel is lit by the light that cell has today. It follows the row filter above, so "one player\'s places"\nthen means "the world as that player left it". URL: ?timeterrain=1, and the costs behind it stay URL-only:\n?timeterrainstep= (rows the playhead may jump per re-sync), ?timeterrainlimit= (voxels one chunk may rewrite),\n?timeterrainmax= (chunks re-cut per re-sync).' },
      { kind: 'note', key: 'note_time', text: () => timeNote(),
        hint: 'The one sentence that answers "am I watching a bug, or an empty decade?". Unattributed rows -\n269,358 of this dimension\'s 351,531, most of them water, fire, growth and mobs - belong to anybody:\nfiltering to one player is a much smaller claim, and it costs 35 ms to re-cut instead of 100.' },      { kind: 'note', text: () => ledgerNote() },
      { kind: 'note', key: 'note_hist', text: () => histNote() },
      { kind: 'note', text: 'M the time machine - K play or pause - drag playhead to scrub - Esc clears the card and the markers' },
      { kind: 'note', text: 'click a block for its history - L the overlay - T middle of view - F tour - Esc clears the card and the markers' },
      { kind: 'section', key: 'sec_far', label: 'the far world', open: false,
        hint: 'The ground outside the close ring: how it is drawn, how coarse it is allowed to get, and\n'
          + 'what that costs in triangles.' },
      { key: 'shellon', label: 'live far terrain', kind: 'check', live: false,
        hint: 'Off shows only the close detail ring - useful for seeing what the far pass is doing. URL: ?noshell',
        get: () => S.shellOn, set: (v) => { S.shellOn = v; applySettings('shellOn'); } },
      { key: 'overview', label: 'world layer', kind: 'check',
        hint: 'One request that paints the whole dimension as a coarse heightmap - what you see when zoomed\nfar out, without streaming 37 000 chunk shells. Needs `node server/bake-shells.mjs`.\nURL: ?nooverview',
        get: () => S.overview,
        set: (v) => { S.overview = v; recomputeZoom(); ovGroup.visible = S.shellOn && v; if (!v) clearOverview(); else loadOverview(currentDim()); } },
      { key: 'farshape', label: 'far terrain stands at', min: 0, max: 1, step: 1,
        fmt: (v) => ['treetops', 'the ground'][v],
        hint: 'What the coarse far terrain stands at. Trees, flowers and lake water are not a floor: a\ncell of grass under a 12 m spruce used to hang a 12 m dirt cliff under the treetops, and a cell of\nsand under 20 m of lake water drew a blue sheet. Default stands the cell on the solid ground and\nkeeps the lake skin. URL: ?groundfar',
        get: () => S.groundFar, set: (v) => { S.groundFar = Math.max(0, Math.min(1, v | 0)); applySettings('lod'); } },
      { key: 'caps', label: 'canopies as skin, not towers', kind: 'check', live: false,
        hint: 'The far layer carries a second number per column besides its height: how thick the solid\n'
          + 'skin at the surface is. With this on, a cell paints its ground and draws that skin where the\n'
          + 'skin actually stands: a canopy gets a roof at the leaves and four walls across the thickness\n'
          + 'of the leaves. Off is the old far view, one height per cell extruded down to the ground under\n'
          + 'it, which is what turned a tree into a column and a house into a slab. Baked tiles carry their\n'
          + 'own answer, so this only changes them after a re-bake. Skin thinner than ?capdrop blocks is\n'
          + 'not worth a roof and four walls: 4 by default. A cap is a box as wide as the cell, so past\n?capcell blocks per column it is refused: a cap on a 16-block column is a plateau with a lid, which is\nhow a distant tree became a monolith again. URL: ?caps, ?nocaps, ?capdrop, ?capcell',
        get: () => !!S.caps,
        set: (v) => { S.caps = v ? 1 : 0; applySettings('caps'); } },
      { key: 'capcell', label: 'canopy cap up to cell', min: 0, max: 4, step: 1, live: false,
        fmt: (v) => (v === 0 ? 'any cell' : `${[1, 2, 4, 8, 16][v]} blk`),
        hint: 'How coarse a far column may be and still get its surface drawn as its own skin. A cap is a\nbox as wide as the cell, so 4 means caps only on 1, 2 and 4-block columns; at 16 a cap is a plateau\nwith a lid. 0 refuses caps at every cell size. Baked tiles carry their own answer. URL: ?capcell',
        get: () => [1, 2, 4, 8, 16].indexOf(S.capCell),
        set: (v) => { S.capCell = [1, 2, 4, 8, 16][v] || 255; applySettings('caps'); } },
      { key: 'lodclip', label: 'hide baked tiles up close', kind: 'check', live: true,
        hint: 'A baked tile is one mesh over 512x512 blocks, so it cannot be unloaded near the camera -\nit is clipped there instead, or its 16 block columns stand over the close terrain as flat slabs\nwith straight cliff walls. Off draws them everywhere. URL: ?nolodclip',
        get: () => S.lodClip, set: (v) => { S.lodClip = v ? 1 : 0; updateLodClip(); } },
      { key: 'flatback', label: 'paint far ground from below', kind: 'check', live: true,
        hint: 'The far layers are a height field: a top quad and skirt walls, with no bottom cap. From\nbelow - in a cave, under an overhang, orbiting under the plateau - the back of that plate was\nculled, so you looked straight through the ground at the sky. On paints the same quads from behind:\ncosts fill, not geometry. Off is the old see-through behaviour. URL: ?noflatback',
        get: () => S.flatBack, set: (v) => { S.flatBack = v ? 1 : 0; setCoarseSide(); } },
      { key: 'lodcap', label: 'live far grid stops at', min: 0, max: 16, step: 1,
        fmt: (v) => (v ? `${v} blocks` : 'never (mesh it all)'),
        hint: 'How coarse the browser-meshed far terrain is allowed to get before the baked tiles take\nover. Its only job is to not leave a gap where the tiles are already painting the same ground.\nURL: ?lodcap',
        get: () => S.lodCap,
        set: (v) => { S.lodCap = Math.max(0, Math.min(16, v | 0)); applySettings('lodtiles'); } },
      { key: 'maxradius', label: 'detail skin radius', min: 8, max: 160, step: 8, live: false,
        fmt: (v) => `${v * CH} m`,
        hint: 'Radius of the per-chunk heightmap skin. Beyond it the whole-world overview takes over, so\nthis only changes how much of the near-ish world is at full column resolution. URL: ?maxradius',
        get: () => S.skinCap, set: (v) => { S.skinCap = clampInt(v, 8, 160); applySettings('skin'); } },
      { key: 'vertbudget', label: 'far terrain verts', min: 500000, max: 40000000, step: 500000, live: false,
        fmt: (v) => `${(v / 1e6).toFixed(1)} M`,
        hint: 'How much heightmap terrain the page may hold, in vertices - memory, not taste. Over\nthis, the far grid merges more (and its cliff walls shrink) until it fits. URL: ?vertbudget',
        get: () => S.vertBudget,
        set: (v) => { S.vertBudget = Math.max(200000, v | 0); applySettings('lod'); } },
      { key: 'meshcache', label: 'keep meshes when zoomed out', min: 0, max: 2048, step: 64, live: false,
        fmt: (v) => (v ? `${v | 0} MB` : 'off, re-mesh instead'),
        hint: 'Zooming out throws a chunk\'s triangles away, and zooming back in used to rebuild them\nat ~51 ms a chunk - the hitch when you come back. This keeps the vertex bytes of the\nchunks you left behind (the payload ring already keeps their voxels), so returning is a\nGPU upload. RAM, not disk: 256 MB is about 350 chunks. 0 disables it. URL: ?meshcache=',
        get: () => S.meshCacheMb,
        set: (v) => { S.meshCacheMb = Math.max(0, v); trimMeshBytes(); } },
      { key: 'fog', label: 'fog', min: 0, max: 3, step: 0.05,
        fmt: (v) => (v ? `${Math.round(fogFor(rig.dist, skinR, { scale: v }).far)} m` : 'off'),
        hint: 'How fast distance fades into the sky colour; 0 is no fog. URL: ?fog',
        get: () => S.fog, set: (v) => { S.fog = Math.max(0, v); applySettings('fog'); } },
      { kind: 'section', key: 'sec_light', label: 'light, and what is left out', open: false,
        hint: 'How the world is shaded, and the rules that skip geometry you cannot see to afford the\n'
          + 'whole save. Each row says what it drops.' },
      { key: 'aoon', label: 'corner shadows', kind: 'check', live: false,
        hint: 'On/off for the whole ambient-occlusion pass. URL: ?noao',
        get: () => S.ao, set: (v) => { S.ao = v; applySettings('ao'); } },
      { key: 'lighton', label: 'light from the save', kind: 'check', live: false,
        hint: 'Sky and block light decoded from the chunk data. Off is the old flat shading, kept for\ncomparison. URL: ?nolight',
        get: () => !!S.light, set: (v) => { S.light = !!v; applySettings('light'); } },
      { key: 'daylight', label: 'daylight', min: 0, max: 1, step: 0.05, live: false,
        fmt: (v) => v < 0.02 ? 'torches only' : `${Math.round(v * 100)}%`,
        hint: 'How much of the sky channel counts. Lower it to read torch/cave light on the surface\nwithout the daylight flattening it. Block light is always full. URL: ?skyscale=',
        get: () => S.skyScale,
        set: (v) => { S.skyScale = Math.min(1, Math.max(0, v)); applySettings('light'); } },
      { key: 'aofar', label: 'far brightness match', min: 0.6, max: 1.1, step: 0.01, live: false,
        fmt: (v) => v.toFixed(3),
        hint: 'How much darker the far terrain is painted, to match the close-up pass: that\npass darkens corners with ambient occlusion and the far layer has no corners to darken.\n0.949 is that pass\'s measured mean over 2.7 M sampled vertices (tools/dbg-aohist.mjs). Raise it\nif far ground reads paler than near ground, lower it if it reads darker. URL: ?aofar=',
        get: () => S.aoFar, set: (v) => { S.aoFar = v; applySettings('aofar'); } },
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
      { key: 'surface', label: 'mesh the surface only', kind: 'check', live: false,
        hint: 'Off (default). On, a detail face is drawn only if opaque rock does not sit above the air it\nlooks into: the world is meshed as a skin, not as a block of rock. 24 sampled chunks: 16,184 verts\nand 25.9 ms per chunk as it runs, 13,659 verts and 19.9 ms as a skin (-16 % / -23 %). It is off\nbecause that saving is smaller than the dark and buried rules already give, and it eats the shallow\ncaves - mine entrances and galleries under a thin lid stop being drawn. Leaves and water are not\ncover, so a forest floor and a lake bed do survive. URL: ?surface=1',
        get: () => S.surface,
        set: (v) => { S.surface = v ? 1 : 0; applySettings('light'); } },
      { key: 'underfar', label: 'hide the surface layer underground', kind: 'check', live: true,
        hint: 'Down in a cavern the far layers are not a far view, they are the *surface*: their coarse \nplates and skirt walls hang around you as floating scraps, and cost verts and frames for nothing. \nWhen the block you stand in gets no skylight those layers stand down, until you are back under open \nskylight. A ravine keeps its walls - its floor sees the sky. URL: ?nounderfar',
        get: () => S.underFar,
        set: (v) => { S.underFar = v ? 1 : 0; } },
      { key: 'underdepth', label: 'far view returns after (blocks)', min: 0, max: 24, step: 1,
        fmt: (v) => (v | 0),
        hint: 'How far below the surface skin the eye has to be before the far layers stand down. Small \nkeeps the ground painted around a shallow hole; large means the plates vanish the moment you \ndip under a canopy. URL: ?underdepth',
        get: () => S.underDepth,
        set: (v) => { S.underDepth = Math.max(0, v | 0); } },
      { key: 'mipmax', label: 'texture blur limit', min: 0, max: 10, step: 1, live: false,
        hint: 'How deep the texture mip chain goes. Deep levels average neighbouring sprites together\nand read as grey mush, which is why this is capped. URL: ?mipmax',
        get: () => S.mipmax, set: (v) => { S.mipmax = v; if (atlasTex) mipCap = capAtlasMipLevel(atlasTex, v); } },
      { key: 'alphatest', label: 'leaf cutout', min: 0, max: 1, step: 0.01,
        hint: 'How much of a leaf/grass sprite has to be solid to be drawn. URL: ?alphatest',
        get: () => S.alphaTest, set: (v) => { S.alphaTest = v; applySettings('alphaTest'); } },
      { kind: 'section', key: 'sec_perf', label: 'speed and controls', open: false,
        hint: 'How much work and how many pixels a frame may spend, and which threads do it.' },
      { key: 'res', label: 'draw resolution', live: true,
        stops: [0.4, 0.6, 0.8, 1, 1.25, 1.5, 2],
        hint: 'How many pixels are drawn, as a fraction of the screen. Below 1 the image is rendered smaller\nand stretched, which is the cheapest way to gain frame rate; above 1 it is drawn bigger than\nthe screen and shrunk back, which costs a third of the frame rate at 4x pixels and takes the\nstaircase off quad edges. It also grows the sharp ring, because that ring is measured in pixels.\nAuto mode only lowers it when the GPU itself is the limit and the view is loaded. Edge staircases\nare also smoothed by MSAA, on every screen, unless ?noaa. URL: ?res=1.5 ?noaa',
        get: () => S.res,
        fmt: (v) => (v === 1 ? 'native' : v < 1 ? `${v}x softer` : `${v}x bigger`),
        set: (v) => { S.res = Math.max(0.4, Math.min(2, v)); resetResGovernor(); applyRes(); } },
      { key: 'resAuto', label: 'auto resolution', min: 0, max: 1, step: 1, live: true,
        labels: ['manual', 'auto'],
        hint: 'Shrink the drawn resolution only when the graphics card is the limit, the view is fully\nloaded, and the frame is still slower than the target. Needs a browser that reports GPU time. URL: ?noautores',
        get: () => S.resAuto, set: (v) => { S.resAuto = v | 0; applyRes(); } },
      { key: 'targetFps', label: 'target frame rate', min: 20, max: 120, step: 5, live: true,
        hint: 'What auto resolution aims at. URL: ?targetfps',
        get: () => S.targetFps, set: (v) => { S.targetFps = Math.max(20, Math.min(120, v | 0)); } },
      { key: 'budget', label: 'meshing ms per frame', min: 0, max: 40, step: 1,
        hint: 'Time per frame spent building close-up chunk meshes. Higher loads faster but hitches. URL: ?budget',
        get: () => S.budget, set: (v) => { S.budget = v; } },
      { key: 'sbudget', label: 'far meshing ms per frame', min: 0, max: 60, step: 1,
        hint: 'Time per frame spent re-cutting far-terrain batches - including deciding whether a batch\nneeds re-cutting at all. A whole pan frame measured 46 ms in this bucket with 24 of those\ndecisions queued and no work done. URL: ?sbudget',
        get: () => S.shellBudget, set: (v) => { S.shellBudget = v; } },
      { key: 'demotems', label: 'parking ms per frame', min: 0, max: 40, step: 1,
        hint: 'Time per frame allowed for parking detail meshes that the sharp circle left behind. Parking\none chunk copies its vertex bytes and releases up to three GPU buffers; 64 chunks of that measured\n45 ms on a single frame. URL: ?demotems',
        get: () => S.demoteBudget, set: (v) => { S.demoteBudget = Math.max(0, v); } },
      { key: 'workers', label: 'meshing threads', min: 0, max: 8, step: 1, live: false,
        hint: 'Background threads that build chunk meshes. Changing this restarts them (a moment of stutter).\n0 meshes on the render thread instead. URL: ?workers',
        get: () => workerCount(),
        set: (v) => { S.workers = Math.max(0, Math.min(8, v | 0)); resetWorkers(); } },
      { key: 'patchthreads', label: 'far cut threads', min: 0, max: 6, step: 1, live: true,
        hint: 'How many of the meshing threads may take a far patch cut at once. A cut is 20-25 ms and a\nframe is 16, so it runs there instead of here. Across a 5 s drag the worst frame measured 60 ms\nwith 0 of these, 29 ms with 2 and 18 ms with 6; the settled view is the same either way (598\npatches, 6 309 216 verts). Cuts are only ever posted up to this many at a time, so the pool keeps\nthe rest for chunk detail: reserving 7 of 8 for a queue that can hold 6 left detail chunks unmeshed\nfor 13 s after a pan. A machine that started 4 workers gets 2 cut threads. URL: ?patchworkers',
        get: () => patchCap(),
        set: (v) => { S.patchWorkers = Math.max(0, Math.min(6, v | 0)); } },
      { key: 'invert', label: 'invert orbit drag', kind: 'check',
        hint: 'Off (default) is mouse-look: drag right and the view turns right. On grabs the world and\nspins it with the cursor, like right-drag pan. URL: ?invert',
        get: () => S.invert, set: (v) => { S.invert = v; } },
      { key: 'panelW', label: 'panel width', min: 360, max: 760, step: 2,
        fmt: (v) => `${v} px`,
        hint: 'How wide this panel is, in CSS pixels. Drag its left edge for the same thing. The value\ncolumn is what needs the room: the time machine prints a date and a row count there, and a\nvalue too long for the column comes back as an ellipsis. URL: ?panelw=440',
        get: () => S.panelW, set: (v) => { S.panelW = Math.max(360, Math.min(760, Math.round(+v || 396))); } },
  ];
  panel = mountPanel({ title: 'settings  (P)', items,
    width: { min: 360, max: 760, get: () => S.panelW, set: (v) => panel.set('panelW', v) },
    actions: [
      { label: 'whole world', run: () => preset('whole world'),
        hint: 'the whole save in the frame, at the coarsest far setting that still holds shape:\nbaked far tiles on, live far grid capped, the close ring kept' },
      { label: 'walk around', run: () => preset('walk around'),
        hint: 'close in and everything real: a wide close ring around the middle of the view,\nunlit ground drawn, the coarse world turned down' },
      { label: 'caves', run: () => preset('caves'),
        hint: 'draw the unlit underground, and stop hiding ground that is merely buried\nor in the dark' },
      { label: 'fast', run: () => preset('fast'),
        hint: 'fewer pixels, fewer threads, less drawn: for a machine that is struggling' },
      { label: 'hotspots', run: () => ledgerTour(true),
        hint: 'rank the chunks the ledger touched, most actions first, and fly to the loudest; press\nagain for the next. The loudest overworld chunk holds 4,254 rows. GET /ledger/top answers the\nsame ranking for a page that holds nothing.' },
      { label: 'markers only', run: () => ledgerTour(false),
        hint: 'the same ranking as cages over the ground, without the heat layer: 12 markers over the\nchunks where the log is loudest.' },
      { label: 'undo', run: undoPreset, hint: 'back to what the panel said before the last preset' },
      { label: 'fit world', run: () => fitWorld(), hint: 'zoom out to the whole loaded extent (f)' },
      { label: 'spawn', run: () => { rig.target.set(SPAWN[0], SPAWN[1], SPAWN[2]); rig.dist = 40; },
        hint: 'back to the world spawn (r)' },
    ],
  });

  // What the panel is pointed at, by name, so a preset can be checked against it instead of against
  // a copy of the settings that would drift. Presets only name these keys, and every one of them has
  // a control: that is what makes 'caves' mean caves instead of leaving the dark rule half on.
  const byKey = new Map(items.filter((it) => it.key).map((it) => [it.key, it]));
  // Presets name controls, not settings. If a row leaves the panel and a preset still points at it,
  // the button quietly does half its job - which is how "caves" once left the dark rule half on.
  // So the mismatch is reported at boot, where it costs a console line, not at click time, where
  // it costs a user an hour of wondering why one knob would not move.
  for (const [name, p] of Object.entries(PRESETS)) {
    const bad = Object.keys(p.s).filter((k) => !byKey.has(k));
    if (bad.length) console.error(`preset "${name}": no control for ${bad.join(', ')}`);
  }
  let presetBack = null, presetCam = null;
  function preset(name) {
    const p = PRESETS[name];
    if (!p) return;
    presetBack = {};
    for (const k of Object.keys(p.s)) if (byKey.has(k)) presetBack[k] = byKey.get(k).get();
    // A preset moves the camera as well, and undo that means the camera too: "undo" on a
    // "whole world" click should put you back where you were looking, not leave you at the sky.
    presetCam = { dist: rig.dist, pitch: rig.pitch, x: rig.target.x, y: rig.target.y, z: rig.target.z };
    for (const [k, v] of Object.entries(p.s)) if (byKey.has(k)) byKey.get(k).set(v);
    if (p.dist !== undefined) {
      rig.dist = p.dist || S.maxZoom;
      rig.pitch = 0.72;
      updateView();
      requestAround();
    }
    panel.refresh();
  }
  function undoPreset() {
    if (!presetBack) return;
    for (const [k, v] of Object.entries(presetBack)) if (byKey.has(k)) byKey.get(k).set(v);
    presetBack = null;
    if (presetCam) {
      rig.dist = presetCam.dist; rig.pitch = presetCam.pitch;
      rig.target.set(presetCam.x, presetCam.y, presetCam.z);
      presetCam = null;
      updateView();
      requestAround();
    }
    panel.refresh();
  }

  // Remember what this viewer was tuned to. Every control writes through the wrapper below, so the
  // stored values are read back off the controls themselves - not from a snapshot of S that would
  // disagree with the display units the panel uses (shadow depth is 1 - aoMin, cap cells are an
  // index). A URL that names anything at all wins outright: a probe link, a copied link or a
  // ?debug=1 measurement must land on the settings it asks for, not on whatever was last stored.
  const STORE_KEY = 'darkrpg.viewer.settings.v1';
  const storedUrl = [...params.keys()].some((k) => k !== 'dim');
  const storedKeys = items.filter((it) => it.key && it.get && it.set && !it.key.startsWith('sec_'));
  function remember() {
    if (storedUrl) return;
    try {
      const o = {};
      for (const it of storedKeys) o[it.key] = it.get();
      localStorage.setItem(STORE_KEY, JSON.stringify(o));
    } catch { /* private mode, no room: a remembered view is not worth an error over */ }
  }
  function restoreStored() {
    if (storedUrl) return 0;
    let o = null;
    try { o = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { o = null; }
    if (!o || typeof o !== 'object') return 0;
    let n = 0;
    for (const it of storedKeys) {
      const v = o[it.key];
      // Which world was open is not stored either: switching it tears down every store the boot has
      // just filled. A type that no longer matches means the control changed meaning since the save.
      if (v === undefined || it.key === 'dim' || typeof it.get() !== typeof v) continue;
      it.set(v);
      n++;
    }
    return n;
  }
  for (const it of items) if (it.set) { const inner = it.set; it.set = (v) => { inner(v); remember(); }; }
  if (restoreStored()) panel.refresh();
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
    // Coverage before the first chunk request: over the overworld's bounding box, three quarters of
    // the tiles a pan asks for were never written, and each one used to cost a round trip.
    if (S.groundCov) await groundLoad(currentDim());
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
    // M12: ask whether this world keeps a ledger before the panel is built, because the "whose
    // actions" menu is made from the player list and a control that fills itself in later is a control
    // that silently offers one choice. A missing ledger is a note, not an error: the viewer works.
    await ledgerMetaLoad();
    buildPanel();
    // M12b: the timeline is deliberately not a boot request - 4.7 MB for the overworld, and most
    // visits never scrub. But a URL that asks for the layer gets it, filters included, before the
    // first frame is worth comparing against.
    if (S.time) timeLoad();
    // Walking is turned on after the panel exists (its rows report the mode) and after the spawn
    // point and the ?goto target are known, so ?view=walk&goto=x,y,z lands the eye on that place at
    // head height rather than aiming at it from 40 blocks away.
    if (params.has('pitch')) rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, num('pitch', rig.pitch)));
    if (S.walk) setWalk(true);
    requestAnimationFrame(frame);
    // The pill is quiet unless something is wrong or something is arriving. What the save contains
    // is a fact for ?debug=1, not a caption over the world.
    hud.msg.textContent = '';
    hud.dim.addEventListener('change', () => switchDim(hud.dim.value));
  } catch (e) {
    bootError = e;
    hud.msg.textContent = `startup failed: ${e.message}`;
    hud.msg.classList.add('err');
    console.error(e);
  }
})();
