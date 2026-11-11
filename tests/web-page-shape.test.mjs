// Invariants of the page layer that no headless harness can reach, written as source-shape assertions.
// This is not a style test: each one is a bug that cost a pass, and the only artifact it can be checked
// against is the file itself, because what it guards is a WebGL scene graph or a DOM click handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('web/js/main.js', 'utf8').replace(/\r\n/g, '\n');
const codeLines = src.split('\n').filter((l) => !/^\s*\/\//.test(l));
const bodyOf = (name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} is gone`);
  return src.slice(at, src.indexOf('\nfunction ', at + 10));
};
const statements = (body) => body.split('\n').map((l) => l.trim());

test('dropChunkMesh is always called with two coordinates, never a key string', () => {
  const calls = codeLines.filter((l) => /dropChunkMesh\(/.test(l));
  assert.ok(calls.length >= 4, `found ${calls.length} call sites, expected at least 4`);
  for (const l of calls) {
    // A template literal or quoted string as the first argument is the bug, in exactly this shape.
    assert.ok(!/dropChunkMesh\(\s*[`'"]/.test(l), `a call passed a string, not coordinates: ${l.trim()}`);
    assert.match(l, /dropChunkMesh\(\s*cx\s*,\s*cz\b/, `a call did not pass (cx, cz): ${l.trim()}`);
  }
});

test('installing a chunk mesh always removes the mesh it replaces', () => {
  const line = statements(bodyOf('attachChunkMesh')).find((l) => l.startsWith('dropChunkMesh('));
  assert.ok(line, 'attachChunkMesh never drops the mesh it replaces');
  assert.equal(line, 'dropChunkMesh(cx, cz, !!(HIST.on && S.keepMesh));',
    'the swap must be unconditional and only the PARKING may depend on the time machine: ' + line);
});

// The other half of the same class: what a click promises. Ticking "time machine" used to arm the tiles and
// leave the voxels showing today, so the feature looked broken from the checkbox and worked from ?time=1.
test('ticking the time machine also arms the block correction, and never over an explicit choice', () => {
  const arm = statements(bodyOf('setTime')).find((l) => l.startsWith('if (!S.timeTouched'));
  assert.ok(arm, 'the checkbox no longer decides whether the voxels follow');
  assert.equal(arm, 'if (!S.timeTouched && !S.timeTerrain) S.timeTerrain = 1;',
    'a choice the viewer made by URL or checkbox must not be re-armed: ' + arm);
});

// The arm promise has two entry points, and the first version of the fix only covered one of them: a page
// that boots with ?time=1 never calls setTime, so it sat at second 0 and drew an empty map.
test('a fresh time arm is marked on BOTH entry points, and the rebuild decides where it starts', () => {
  assert.match(bodyOf('setTime'), /TLAYER\.freshArm = 1;/, 'the checkbox path lost its fresh-arm mark');
  assert.match(bodyOf('timeLoad'), /TLAYER\.freshArm = 1;/, 'the ?time=1 boot path lost its fresh-arm mark');
  const rb = bodyOf('timeRebuild');
  assert.match(rb, /if \(TLAYER\.freshArm\)/, 'nothing consumes the fresh arm');
  assert.match(rb, /if \(S\.playTouched\) timeSeekRow\(TLAYER\.quads - 1\);/,
    'an explicitly paused arm must start at the END of the filter');
  assert.match(rb, /else \{ S\.timePlay = 1; timeSeekRow\(0\); \}/,
    'an arm nobody paused must start playing at the first logged change, not at second 0');
});

// Two bugs of this pass, both invisible to every counter: a ray hit index treated as an item index, and a
// 40 ms marker raycast sitting inside a 90 ms hover loop.
test('a time-layer hit maps a TRIANGLE index to an item, and the hover path never raycasts', () => {
  const hit = bodyOf('timeHitAt');
  assert.match(hit, /markerOfIndex\(TLAYER\.markerEnd, Math\.floor\(q \/ 2\) \* 6\)/,
    'faceIndex is a triangle number; markerEnd counts indices');
  for (const fn of ['hoverPass', 'hoverVoxel']) {
    const b = bodyOf(fn);
    assert.ok(!/intersectObject/.test(b), `${fn} raycasts a mesh: a hover pays a click's 40 ms`);
  }
  // What the hover may ask cheaply, and the skip path must say why it skipped - a stale 'off' from the last
  // time the highlight was disabled reads as a setting the viewer never made.
  assert.match(bodyOf('hoverVoxel'), /timeDrawnAt\(/, 'the outline lost its cheap drawn-change question');
  assert.match(bodyOf('hoverPass'), /HOVER\.skips\+\+; HOVER\.why = 'nothing moved'/,
    'a skipped hover pass leaves the previous reason behind, which is a lie about the setting');
});

// A click used to answer only if an overlay had already been switched on, which made "nothing happened" the
// symptom of a perfectly ordinary click on a block.
test('a click loads the ledger itself instead of requiring an overlay first', () => {
  const ask = bodyOf('askAt');
  assert.match(ask, /await ledgerMetaLoad\(\)/, 'askAt no longer fetches /ledger/meta on demand');
  assert.match(ask, /pixelHits\(x, y\)/,
    'a click on a drawn marker no longer answers with its own row (all three rays come from one pass)');
  // There are two click listeners on the same canvas: walk mode wants the pointer, orbit mode asks the
  // question. Start from the call and walk back to the listener that owns it.
  const atCall = src.indexOf('askAt(e.clientX, e.clientY)');
  assert.ok(atCall > 0, 'no orbit-mode click asks anything any more');
  const click = src.slice(src.lastIndexOf("canvas.addEventListener('click'", atCall), atCall + 60);
  assert.match(click, /if \(walk\.on\) return;/, 'the orbit click handler lost its walk-mode guard');
  assert.match(click, /askAt\(e\.clientX, e\.clientY\)/, 'the click handler went back to its own gate');
  assert.ok(!/if \(!LEDGER\.meta\?\.available\)/.test(click),
    'the click handler re-added the "turn an overlay on first" gate: ' + click.slice(0, 160));
});

// The "no blocks, only 2D tiles" report had two causes behind it, and neither is visible to a counter:
// a ceiling that quietly stepped the look down, and a rebuild that threw away the marks of terrain the
// page had already undone. Both live in main.js, so they are guarded here.
test('a look the ceiling refuses says which look it substituted, and the default fits the biggest filter', () => {
  // 331,040 any-change rows cost 336 MB as blocks; at the old 128 default that filter could only ever be
  // plates, which is the 2D-sheet picture the viewer reported.
  assert.match(src, /num\('timegeommb', 384\)/,
    'the overlay-memory default dropped below the one filter this dimension provably needs (336 MB as blocks)');
  assert.match(src, /key: 'timeGeomMb', label: 'overlay memory', min: 4, max: 1024/,
    'the panel row cannot be pulled up to the measured 336 MB');
  const rb = bodyOf('timeRebuild');
  // Two refusals: stepped down, and asked-for-but-over. A sentence that says "drawing it anyway because
  // you asked for it" while showing plates instead of blocks is a lie about the setting.
  assert.match(rb, /if \(b\.stats\.bytes > budget\)/, 'an over-ceiling build is no longer reported at all');
  assert.match(rb, /look !== S\.timeLook/, 'the step-down case and the asked-for case share one sentence');
  assert.match(rb, /set "overlay memory" to \$\{lookMb\.blocks\} MB to see the blocks themselves/,
    'the step-down sentence lost the number that would fix it');
  assert.match(rb, /drawing it anyway because you asked for it'/,
    'the asked-for case lost its sentence');
  // and the number behind the sentence must survive the rebuild, or the hint is folklore
  assert.match(rb, /TLAYER\.lookBytes = lookMb;/, 'a look attempt no longer records what it cost');
});

test('the marks of undone terrain belong to the filter row set, not to a marker rebuild', () => {
  const rb = bodyOf('timeRebuild');
  assert.match(rb, /const fsig = `\$\{TLAYER\.tl\.dimKey\}\|\$\{TLAYER\.gen\}\|\$\{S\.ledgerWho\}\|\$\{S\.timeCls\}\|\$\{S\.timeLimit\}\|\$\{got\.n\}`;/,
    'the row-set signature is gone, so any rebuild is about to clear the marks again');
  assert.match(rb, /if \(HIST\.filterSig !== fsig\) \{ HIST\.marks\.clear\(\); HIST\.filterSig = fsig; \}/,
    'the marks are cleared unconditionally again: overlay memory is not a filter change');
  assert.match(src, /^  filterSig: '',/m, 'HIST has no signature field to compare against');
});

test('the marker checkbox says it hides the whole overlay, not only flat tiles', () => {
  // One mesh carries every look, so "tiles off" at the block look erases the block shapes too. The old
  // value sentence promised "the blocks speak" at exactly the moment nothing is drawn.
  assert.match(bodyOf('timeApply'), /TLAYER\.mesh\.visible = !!S\.timeTiles && n > 0;/,
    'the overlay visibility moved without this test moving');
  const row = src.slice(src.indexOf("{ key: 'timeTiles'"), src.indexOf("{ key: 'decalop'"));
  assert.match(row, /'off - nothing is drawn'/, 'the row promises something the mesh does not do');
  assert.match(row, /TLAYER\.look \|\| 'tiles'/, 'the value sentence no longer names what is drawn');
});

// A remembered panel is a second, invisible copy of the settings that wins over what the page ships
// with on a bare URL. When the overlay ceiling's DEFAULT changed (128 -> 384, after the replay was
// priced as blocks) every viewer holding an older snapshot kept the old ceiling - and so kept the flat
// plates the repricing was meant to end. Measured both ways in build/q_m12b7_seed.js +
// build/q_m12b7_check.js against one seeded snapshot {timeGeomMb: 128, timeLook: 'blocks'}:
//   old page (key v1):  ceiling at boot 128, look 'plates', marker geometry 75.5 MB
//   this page (key v2): ceiling at boot 384, look 'blocks', marker geometry 134.4 MB
test('a remembered view cannot pin a cost ceiling, and is one button from gone', () => {
  assert.match(src, /const STORE_KEY = 'darkrpg\.viewer\.settings\.v2';/,
    'the snapshot key was not versioned up, so an older snapshot still decides the picture');
  assert.doesNotMatch(src, /'darkrpg\.viewer\.settings\.v1'/,
    'the retired key is being read again: bump it instead');
  assert.match(src, /&& !it\.nostore\);/,
    'storedKeys collects every control again, cost ceilings included');
  assert.match(src, /\{ key: 'timeGeomMb', label: 'overlay memory',[^\n]*nostore: 1,/,
    'the overlay ceiling is a remembered value again, so a stale one can pin the replay to plates');
  assert.match(src, /const forgetStore = \(\) => \{[\s\S]{0,200}localStorage\.removeItem\(STORE_KEY\)/,
    'there is no way to drop a remembered view');
  assert.match(src, /\{ label: 'forget view', run: \(\) => \{ forgetStore\(\); location\.reload\(\); \},/,
    'the panel does not offer the button, or it forgets without going back to the shipped values');
  assert.match(src, /Object\.assign\(window\.__world, \{ settingsStore, forgetStore \}\);/,
    'a probe cannot ask which rows the view remembers');
});

// A patch that spliced sentences into single-quoted hints once left "M. URL: ?time=1" and
// "M still brings the layer back": the subject had been eaten, and that text is what a viewer reads to
// understand a control. Shape is the only place this can be caught.
test('a panel hint keeps its subject', () => {
  assert.doesNotMatch(src, /\.\s?M\. URL: /, 'a hint lost a word before its URL name');
  assert.doesNotMatch(src, /\nM still brings /, 'a hint lost its subject before "still brings"');
  assert.doesNotMatch(src, /\nM\./, 'a hint has a bare M where a sentence should be');
});

// The pixel question. The mesh under a cursor is the world as it is today, so with the time machine on the
// wire box used to sit on a wall that is placed three weeks after the playhead and a click asked about it as
// if it stood. Measured in build/q_t5pick.js: scrubbed to the earliest moment of this save's log, the hover
// answer named blocks whose oldest logged claim is later than the playhead, and `T` asked the server about
// them. What is guarded here is that BOTH the outline and the click go through the one playhead-aware pick,
// and that a voxel the log never mentions still gets picked (silence is not evidence of absence).
test('the hover and the click both go through the playhead-aware pick', () => {
  const hv = statements(bodyOf('hoverVoxel'));
  assert.ok(hv.includes('const p = pickWorld(x, y);'),
    'the hover picks the raw scene again, so it answers for today instead of the playhead');
  assert.ok(!hv.includes('const p = pickState(x, y);'), 'hoverVoxel re-tuned itself to pickState');
  const ask = bodyOf('askAt');
  assert.match(ask, /const \{ body, marker: t, world: p \} = pixelHits\(x, y\);/,
    'the click raycasts its own three rays, so what a probe measures is not what a click does');
  assert.match(ask, /if \(p\.stand && p\.stand\.stands === 0\) \{/,
    'the click no longer refuses a voxel the log says is empty at this moment');
  assert.match(ask, /p\.stand\.starts \? `\$\{claimName\(p\.stand\.starts\.cls\)} at \$\{tlStamp\(p\.stand\.starts\.sec\)\}\.`/,
    'the refusal stopped naming the moment the block arrives: that is the part a person can act on');
  assert.match(ask, /showLedgerRefusal\(p\.block, why\);/,
    'a refusal is only in the one-line status, where a person who just clicked will not look');
  assert.match(src, /function showLedgerRefusal\(block, sentence\) \{/,
    'the refusal card builder is gone, so the answer has nowhere to go');
  assert.doesNotMatch(ask, /is not standing: the log puts[^`]*tlDate/, 
    'a refusal quotes a date without the year, and this log spans 27 months: 05-31 and 06-03 are two years apart');
});

test('a refused hover hides the box, counts itself, and explains itself', () => {
  const hp = bodyOf('hoverPass');
  assert.match(hp, /if \(h\.stand && h\.stand\.stands === 0\) \{[\s\S]{0,160}g\.visible = false;[\s\S]{0,80}HOVER\.refused\+\+/,
    'the outline still draws around a block the log says is not there');
  assert.match(hp, /HOVER\.why = h\.standWhy \|\| 'not there at the playhead';/,
    'a refusal arrives with no reason, which is the report "the highlight vanished for nothing"');
  assert.match(src, /stand: null, standWhy: '', refused: 0, body: null \};/,
    'the refusal count is gone from HOVER, so the instrument cannot see it');
  assert.match(src, /playheadPick: !!S\.timePick,/, 'the hover readout does not report the switch state');
});

test('the playhead pick asks the log, never the mesh, and answers nothing rather than guessing', () => {
  const f = bodyOf('timeStandAt');
  assert.match(f, /if \(!S\.time \|\| !S\.timePick \|\| !TLAYER\.tl \|\| !TLAYER\.quadRow\) return null;/,
    'the switch does not gate the pick, so ?timepick=0 stops being an A/B switch');
  assert.match(f, /if \(cell === undefined\) return null;/,
    'a chunk the log never touched is about to be answered as empty: it must be answered as unknown');
  assert.match(f, /return standsAt\(TLAYER\.tl, timeVoxelIndex\(\)/,
    'the verdict no longer comes from the timeline rows');
  assert.match(bodyOf('pickWorld'), /stand: timeStandAt\(p\.block\[0\], p\.block\[1\], p\.block\[2\], p\.state \?\? p\.shellState\)/,
    'pickWorld no longer attaches a verdict, or attaches one that does not know which BLOCK the cursor is on');
  assert.match(bodyOf('askAt'), /p\.stand\.arrival\s*\?\s*`at \$\{tlStamp\(Math\.round\(S\.timeAt\)\)}/,
    'the click stopped naming the block the log says arrives later, which is the block the cursor was on');
  assert.match(src, /\{ key: 'timePick', label: 'the outline only stands where the playhead says', kind: 'check',/,
    'the switch has no panel row, which leaves the behaviour undiscoverable and unauditable');
});

// A body you can see but cannot click is a bug you only find by clicking. The first exception ("a marker
// in the body's own column loses") left 41 of 48 candidate framings around 5 standing bodies answering a
// marker instead of the person, because a marker is grown OUTWARD from its block and a replayed build site
// is full of them. The rule is therefore about KINDS, not distances: an annotation does not hide a person,
// rock does.
test('a person answers a click before a marker and before far paint, but real ground in front does not', () => {
  const g = bodyOf('ghostTakesPixel');
  assert.match(g, /if \(S\.bodyThrough\) return true;/, 'the whole-world finder no longer answers outright');
  assert.match(g, /const dm = S\.bodyPick \? Infinity : \(marker\?\.dist \?\? Infinity\);/,
    'a marker is back in the distance race, which is the unclickable-person bug again');
  assert.match(g, /return GHOST\.hitDist <= dm && GHOST\.hitDist <= dw;/,
    'a body no longer has to be in front of the world surface, so it answers through walls');
  // Measured at a meadow party: every "occluder" the first ray found was a baked LOD plate 0.65 blocks
  // from the eye, and the framebuffer showed the body painted at that very pixel. Coarse far layers are a
  // guess about the surface, clipped near the camera, so only real chunk voxels may hide a person.
  assert.match(g, /const oc = S\.bodyWall \? world\?\.detail/,
    'a coarse far-layer plate can hide a person again, which the frame proved false');
  assert.match(src, /bodyWall: num\('bodywall', 1\) \? 1 : 0,/, 'the A/B back to the old any-layer rule is gone');
  assert.match(bodyOf('isDetailMesh'),
    /if \(o === lodGroup \|\| o === ovGroup \|\| o === shellGroup\) return false;/,
    'nothing can tell real voxels from far paint, so the pick cannot answer which is which');
  assert.match(src, /hits\.find\(\(x\) => isDetailMesh\(x\.object\)\)/,
    'the pick stopped looking past the first hit, so a coarse plate in front hides the answer');
  // The floor a body stands on is nearer than their middle and does not hide them. The honest form is a
  // position test - a block in their OWN column at or below the block the SEAT found them standing on.
  // Asking only whether the face pointed up buried every body at a hillside party behind rock 6 blocks in
  // front. Asking `body.y` instead of the seat exempted a mine's tunnel WALL: stone at [65,99,-48] is one
  // block sideways at the body's own height, and the frame showed it hiding them (build/q_m15why.js: body
  // 9.89, that wall 10.42, 0 of 1,972 box pixels changed with walls obeyed).
  assert.match(g, /Math\.abs\(v\[0\] - body\.x\) <= 1 && Math\.abs\(v\[2\] - body\.z\) <= 1/, 'the floor test stopped asking whose column this is');
  assert.match(g, /const feet = body\.floor \?\? body\.y - 1;/,
    'the test guesses where the feet are instead of asking the seat that stands them there');
  assert.match(g, /v\[1\] <= feet/, 'a block at their own height now counts as the floor, so a wall hides them and the pick lies');
  assert.doesNotMatch(g, /v\[1\] >= body\.y - 2/, 'the two-block band is back: it lets a tunnel wall or a fence be called a floor');
  assert.doesNotMatch(g, /world\.nrm\[1\] > 0\.9/, 'the direction test is back: any up-facing slope buries a whole party');
  assert.match(g, /GHOST\.hitFloor = true;/,
    'nothing records that the floor exempted the body, so the number cannot be checked');
  assert.match(g, /if \(!S\.bodyPick\) \{/, '?bodypick=0 no longer restores plain nearest-wins');
  assert.match(src, /bodyPick: num\('bodypick', 1\) \? 1 : 0,/, 'the A/B switch is gone');
  assert.match(bodyOf('pixelHits'), /marker: timeHitAt\(x, y\), world: pickWorld\(x, y\)/,
    'the one pass that answers a pixel no longer asks the world, so a wall in front of a body loses');
  assert.match(bodyOf('askAt'), /const \{ body, marker: t, world: p \} = pixelHits\(x, y\);/,
    'the click raycasts separately again, so the probe and the click answer different questions');
  assert.match(src, /ownerAt: \(x = innerWidth \/ 2, y = innerHeight \/ 2\) => pixelOwner\(x, y\),/,
    'no probe can ask who would answer this pixel, so the rule can only be argued about');
  const po = bodyOf('pixelOwner');
  assert.match(po, /detailDist: GHOST\.hitDetail,/, 'the answer cannot say how far the real ground in front was');
  assert.match(po, /worldCls: h\.world \? h\.world\.cls : null,/, 'the answer cannot say what kind of face answered');
  assert.match(po, /worldDrawn: h\.world \? h\.world\.drawn : null,/, 'the answer cannot say which layer painted it');
  assert.match(bodyOf('peopleNote'), /a person answers a click before a change marker does/,
    'the sentence next to the bodies stopped saying who answers a click');
});

// A marker is an annotation on a voxel, and it grows OUTWARD around that voxel, so it is nearer than
// whatever stands in the voxel. Measured at a real mine framing (build/q_m15why.js: one body, one camera,
// three grabs - bodies on, bodies off, bodies drawn with the depth test switched off):
//   obeying walls  changed   0 of 1,972 pixels in the body's own projected box
//   depthTest off  changed 751
// so the body was drawn and rejected by a depth value the world's own ray never reported (nearest terrain
// 10.42, body 9.89). What wrote that depth was the marker over their voxel at 5.02. Writing `depthWrite =
// !S.markDepth` kept the burying as the default and made the switch mean its opposite; the pixel A/B is the
// only reason this was visible at all. And the ordering fix that looked better - draw the people FIRST and
// let markers write depth - was measured and rejected: six mine framings searched, five had the page's own
// pick answer "body" while the aimed pixel showed marker paint (`centreChanged:false`, changedBox 476-997 of
// a 73x129 box), because the marker nearer than the body owns the pixel either way (build/
// m15_where_mine_newdef.txt vs m15_where_mine.txt, which finds a body-painted framing on the first try).
test('one voxel draws one block, and the time-machine sentence says where the other claims went', () => {
  const n = bodyOf('timeNote');
  assert.match(n, /TLAYER\.deduped/,
    'a filter that claims one voxel four times draws one cube, and said nothing about the other three');
  assert.match(n, /one block draws per voxel/, 'the page stopped admitting that claims are dropped');
  assert.match(n, /\?timestack=1 nests every claim outside the last/, 'the way to see them is not named');
  const t = bodyOf('timeBlockMatOf');
  assert.match(t, /polygonOffset/, 'a flush marker now needs the polygon offset to sit off the world\'s depth');
});

test('a change marker tests the world\'s depth but never writes its own, and the people draw after it', () => {
  const m = bodyOf('timeBlockMatOf');
  assert.match(m, /timeBlockMat\.depthWrite = !!S\.markDepth;/,
    'the depth-write flag stopped saying what it writes');
  assert.doesNotMatch(m, /depthWrite = !S\.markDepth/,
    'the depth-write switch means its own opposite again');
  assert.match(m, /timeBlockMat\.depthTest = true;/,
    'a marker stopped obeying the world, so a hill in front of it stops hiding it');
  assert.match(src, /markDepth: num\('markdepth', 0\) \? 1 : 0,/,
    'the default went back to writing depth, which buries the person standing in the block a marker annotates');
  assert.doesNotMatch(src, /markDepth: num\('markdepth', 1\)/,
    'a default that was measured to bury bodies is back');
  // A person owns the pixel over the annotation on their own block because they draw LAST, and the marker
  // layer that could seal them in does not write depth by default.
  assert.match(bodyOf('ghostCut'), /mesh\.renderOrder = 903;/,
    'the people no longer draw after the change markers, so a marker paints over a person again');
  assert.match(bodyOf('timeRebuild'), /renderOrder = 902;/,
    'the marker layer still draws before the people');
});

// The playhead's unit is a ROW: of this dimension's 351,531 rows many share one second, so a key that moved
// by seconds would skip changes rather than show them.
test('< and > step one logged change at a time, and say what they landed on', () => {
  assert.match(src, /if \(e\.key === '<' \|\| e\.code === 'Comma'\) \{ timeStepRows\(-1\); return; \}/,
    'the back key');
  assert.match(src, /if \(e\.key === '>' \|\| e\.code === 'Period'\) \{ timeStepRows\(1\); return; \}/,
    'the forward key');
  const f = bodyOf('timeStepRows');
  assert.match(f, /if \(!S\.time\) setTime\(true\);/, 'pressing it before the machine is armed arms it');
  assert.match(f, /S\.timePlay = 0;/, 'a step you press is a step you want to look at');
  assert.match(f, /Math\.max\(0, Math\.min\(last, from \+ \(n \| 0\)\)\)/, 'clamped inside the filter');
  assert.match(f, /TLAYER\.quadRow\[i\]/, 'it answers with the ROW, not the second');
  assert.match(f, /actionName\(tl\.action\[row\]\)/, 'and names the action it landed on');
});

// Following is a claim about the evidence: the camera may only go where a hand action put the person, and it
// holds when the silence ends the visit rather than gliding to wherever the playhead goes next.
test('following a person follows the evidence, jumps between visits, and stops with it', () => {
  const f = bodyOf('ghostFollowCam');
  assert.match(f, /GHOST\.bodies\.find\(\(q\) => !q\.absent && q\.player === GHOST\.follow\)/,
    'the camera is driven by the standing body, not by the playhead date');
  assert.match(f, /b\.floor != null \? b\.floor \+ 1 : b\.y/, 'it looks at a person, not at their knees');
  assert.match(f, /d > S\.followSnap/, 'a new visit is a jump, not a 30-second pan over country nobody walked');
  assert.match(f, /1 - Math\.exp\(-6 \* dt\)/, 'the easing is the same speed at any frame rate');
  assert.match(f, /GHOST\.followWhy =/, 'and when there is no body it says why instead of freezing silently');
  // The scratch vector this reaches for is made lazily, and a follow camera that grabbed an unmade one threw
  // in the frame loop 406 times before the first screenshot was taken.
  assert.match(f, /GHOST\.v3 \?\?= new THREE\.Vector3\(\)/, 'the follow camera uses a scratch vector nobody made');
  assert.doesNotMatch(f, /GHOST\.v3\.set\(/, 'a bare scratch vector is reached for before it exists');
  assert.match(src, /ghostFollowCam\(dt\);/, 'it runs in the frame loop, next to the body tick');
  assert.match(bodyOf('followFromUrl'), /toLowerCase\(\)/, '?follow=Name is case-insensitive');
  assert.match(bodyOf('setFollow'), /ghostPickPlayer\(p\)/, 'following someone narrows the overlay and replay to them');
  assert.match(src, /e\.code === 'Escape' && GHOST\.follow >= 0/, 'Esc gives the camera back');
  assert.match(src, /const cand = pickFollowCandidate\(\);/, 'the B key asks who is nearest');
  assert.match(src, /nobody stands at this second, so there is nobody to follow/,
    'B where nobody stands used to do nothing at all');
});

// A person answers a click before a marker does, so the outline has to answer the same way or the page
// highlights a marker cube and then opens a card about somebody standing behind it. Hover pays 0.1 ms for
// the body ray, next to the 17.5 ms world pick it already pays, so agreement is affordable.
test('the outline answers the same body the click answers, and hands its box back afterwards', () => {
  const hv = bodyOf('hoverVoxel');
  assert.match(hv, /const gb = S\.bodies \? ghostHitAt\(x, y\) : null;/,
    'the outline never asks who stands here, so it cannot agree with the click');
  assert.match(hv, /if \(gb && ghostTakesPixel\(gb, null, p\)\) \{/,
    'the outline re-invented its own pixel rule instead of using the click\'s');
  assert.match(hv, /from: 'body'/, 'a body pixel is reported as whatever the world pick found');
  const hp = bodyOf('hoverPass');
  assert.match(hp, /g\.scale\.set\(BODY_W \+ 0\.12, BODY_H, BODY_W \+ 0\.12\);/,
    'the outline is a 1x1x1 box around a block, not around a 0.6 x 1.8 person');
  assert.match(hp, /g\.scale\.set\(1, 1, 1\);/,
    'a body outline leaves an enlarged box behind for the next voxel it highlights');
  assert.match(hp, /HOVER\.why = `\$\{lab\.name\} stands here/,
    'the outline answers with a voxel instead of a name');
  assert.match(src, /refused: 0, body: null \};/, 'the hover state cannot say which person it outlined');
  assert.match(bodyOf('hoverAtPixel'), /body: HOVER\.body, why: HOVER\.why/,
    'a probe cannot ask who the outline settled on, so this rule cannot be measured');
});

test('a body name tag opens the evidence, and only the card filters the replay', () => {
  const tags = src.slice(src.indexOf('function ghostTags('), src.indexOf('/** Put the labels where the bodies are.'));
  assert.ok(/addEventListener\('click', \(\) => showGhostCard\(b\)\)/.test(tags),
    'the tag is the one part of a body that is always reachable, so it opens the card');
  assert.ok(!/ghostPickPlayer/.test(tags), 'filtering the replay is not hidden behind a name tag');
  const card = src.slice(src.indexOf('function showGhostCard('), src.indexOf('function ghostPickPlayer(player)'));
  assert.ok(/addEventListener\('click', \(\) => ghostPickPlayer\(b\.player\)\)/.test(card),
    'the card carries the who filter, where it can be undone');
});

test('a name tag slides along the frame instead of rendering half a name off the edge', () => {
  const p = bodyOf('ghostPlace');
  assert.match(p, /const wdt = el\.offsetWidth/, 'the clamp guesses a label width nobody measured');
  assert.match(p, /const cx = Math\.min\(innerWidth - wdt \/ 2 - 4, Math\.max\(wdt \/ 2 \+ 4, px\)\);/,
    'a label anchored past the edge renders as half a name, which reads as a broken page');
  assert.match(p, /const cy = Math\.min\(innerHeight - 6, Math\.max\(hgt \+ 6, py\)\);/,
    'the vertical anchor still leaves the frame');
  assert.match(p, /translate\(\$\{Math\.round\(cx\)\}px, \$\{Math\.round\(cy\)\}px\)/,
    'the transform ignores the clamped anchor');
  assert.match(p, /GHOST\.tagClamped = 0;\s*\/\//, 'the pass does not count how many labels had to slide');
});

test('a name label is never left standing unpainted at the corner of the screen', () => {
  const t = bodyOf('ghostTags');
  const c = bodyOf('ghostCut');
  assert.match(t, /el\.style\.display = 'none';/, 'a label starts hidden, because its box sits at the top-left corner');
  assert.match(c, /ghostTags\(standing\);[\s\S]{0,300}ghostPlace\(\);/, 'a rebuilt label is placed in the same breath it was built');
});

test('a buried body says how deep it is, on the tag and in the note', () => {
  const sync = bodyOf('ghostSync');
  assert.ok(/b\.down = bodyDepth\(b\)/.test(sync), 'the depth under the open sky is a fact of the moment');
  assert.ok(/q\.d != null|b\.down != null/.test(sync), 'a column with no heightmap is unknown, never "underground"');
  const tags = src.slice(src.indexOf('function ghostTags('), src.indexOf('/** Put the labels where the bodies are.'));
  assert.ok(/b\.down != null && b\.down > 3/.test(tags), 'the tag carries the depth next to the seat hedge');
  const note = bodyOf('peopleNote');
  assert.ok(/caves/.test(note) && /\?caves=1/.test(note),
    'the note names the one control that draws the rock a mined body stands in');
});
