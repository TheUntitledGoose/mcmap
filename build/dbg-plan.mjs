// Node-side expectation table for the browser probes: same coordinate, same phases, fresh body each.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { makeCellAt } from '../web/js/collision.js';
import { newPlayer, place, simulate, hits, floorTop } from '../shared/player.mjs';
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
async function hold(cx0, cx1, cz0, cz1) {
  const held = new Map();
  for (let a = cx0; a <= cx1; a++) for (let b = cz0; b <= cz1; b++) {
    const buf = await svc.chunkBytes('minecraft:overworld', a, b);
    if (!buf) continue;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (!held.has(a)) held.set(a, new Map());
    held.get(a).set(b, openChunk(ab, 0));
  }
  return makeCellAt((a, b) => held.get(a)?.get(b) || null, () => assets);
}
function phase(cellAt, x, z, y0, input, secs, label, free = false) {
  const p = newPlayer(x, y0, z);
  if (!free) place(cellAt, p, x, y0, z, { maxDrop: 200 });
  let air = 0, rock = 0, frozen = 0, min = p.y, max = p.y;
  const sx = p.x, sz = p.z, sy = p.y;
  for (let i = 0; i < secs * 60; i++) {
    const ev = simulate(p, input, 1 / 60, cellAt, { minY: -64 });
    if (!p.onGround) air++;
    if (ev.frozen) frozen++;
    min = Math.min(min, p.y); max = Math.max(max, p.y);
    if (hits(cellAt, p.x, p.y, p.z)) rock++;
  }
  console.log(`${label}: covered ${Math.hypot(p.x - sx, p.z - sz).toFixed(1)} blocks in ${(secs * 1000) | 0} ms;` +
    ` feet ${p.y.toFixed(2)} (min ${min.toFixed(2)} max ${max.toFixed(2)} dy ${(p.y - sy).toFixed(2)})` +
    ` air ${air}/${(secs * 60) | 0} in-rock ${rock} frozen ${frozen}`);
}
const surf = await hold(10, 15, 8, 12);
// The lane build/find-lane.mjs says is clear: 34 columns along z=176.5 from x=176.5, feet 64.
//   node build/find-lane.mjs --cx 12 --cz 10 --len 30
const lane = await hold(10, 15, 9, 13);
console.log('-- lane (176.5, 176.5) east, feet 64, yaw 90 deg --');
phase(lane, 176.5, 176.5, 66, { fx: 1, fz: 0, sprint: 1 }, 2, 'sprint +x   2 s');
phase(lane, 176.5, 176.5, 66, { fx: 1, fz: 0 }, 4, 'walk   +x   4 s');
phase(lane, 176.5, 176.5, 66, { fx: 1, fz: 0, sneak: 1 }, 2, 'sneak  +x   2 s');
phase(lane, 176.5, 176.5, 64, { jump: 1 }, 1.2, 'jump on lane 1.2 s');
phase(lane, 176.5, 176.5, 66, { fx: 1, fz: 0, sprint: 1 }, 10, 'sprint +x  10 s into the end');
phase(lane, 176.5, 176.5, 140, {}, 5, 'free fall from 140 5 s', true);
phase(lane, 176.5, 176.5, 66, { fx: 1, fz: 0, down: 1 }, 2, 'shift(+down) 2 s');

console.log('-- surface (192.5, 160.5), +x is yaw 90 deg --');
phase(surf, 192.5, 160.5, 200, { jump: 1 }, 1.2, 'jump        1.2 s');
phase(surf, 192.5, 160.5, 200, { fx: 1, fz: 0, sprint: 1 }, 2, 'sprint +x   2 s');
phase(surf, 192.5, 160.5, 200, { fx: 1, fz: 0, sneak: 1 }, 2, 'sneak  +x   2 s');
phase(surf, 192.5, 160.5, 200, { fx: 1, fz: 0, down: 1 }, 2, 'shift(+down) 2 s');
phase(surf, 192.5, 160.5, 200, { fx: 1, fz: 0 }, 4, 'walk   +x   4 s');
const cave = await hold(124, 130, 166, 172);
console.log('-- cavern (2042.5, 2718.5) --');
phase(cave, 2042.5, 2718.5, 20, {}, 2, 'drop from 20  2 s', true);
phase(cave, 2042.5, 2718.5, 200, {}, 8, 'free fall from 200 8 s', true);
phase(cave, 2042.5, 2718.5, 13, { fly: 1, jump: 1 }, 1.5, 'fly up 1.5 s', true);
phase(cave, 2042.5, 2718.5, 200, { fly: 1, down: 1 }, 6, 'fly down from 200 6 s', true);
phase(cave, 2042.5, 2718.5, 80, {}, 3, 'free fall from 80 3 s', true);
phase(cave, 2042.5, 2718.5, 150, {}, 5, 'free fall from 150 5 s', true);
phase(surf, 192.5, 160.5, 140, {}, 4, 'free fall from 140 4 s', true);
phase(cave, 2042.5, 2718.5, 80, {}, 3, 'drop from 80  3 s');
phase(cave, 2042.5, 2718.5, 20, { fx: 1, fz: 0, sprint: 1 }, 3, 'sprint +x   3 s');
phase(cave, 2042.5, 2718.5, 13, { down: 1 }, 2, 'shift on floor 2 s');
phase(cave, 2042.5, 2718.5, 13, { jump: 1 }, 1.2, 'jump on floor 1.2 s');
