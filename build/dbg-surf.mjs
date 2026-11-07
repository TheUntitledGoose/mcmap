import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { makeCellAt } from '../web/js/collision.js';
import { newPlayer, simulate, hits, floorTop } from '../shared/player.mjs';
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
const held = new Map();
for (let cx = 5; cx <= 9; cx++) for (let cz = 3; cz <= 7; cz++) {
  const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
  if (!buf) continue;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (!held.has(cx)) held.set(cx, new Map());
  held.get(cx).set(cz, openChunk(ab, 0));
}
const cellAt = makeCellAt((cx, cz) => held.get(cx)?.get(cz) || null, () => assets);
const p = newPlayer(124.5, 120, 92.5);
let n = 0; while (!p.onGround && n < 900) { simulate(p, {}, 1 / 60, cellAt, { minY: -64 }); n++; }
console.log(`drop from 120: feet ${p.y} after ${n} frames, hits ${hits(cellAt, p.x, p.y, p.z)}, floorTop ${floorTop(cellAt, p.x, p.y, p.z)}`);
let air = 0, min = p.y, rock = 0;
for (let i = 0; i < 360; i++) { simulate(p, { fx: 1, fz: 0 }, 1 / 60, cellAt, { minY: -64 }); if (!p.onGround) air++; min = Math.min(min, p.y); if (hits(cellAt, p.x, p.y, p.z)) rock++; }
console.log(`walk +x 6s: x ${p.x.toFixed(2)} feet ${p.y.toFixed(2)} min ${min.toFixed(2)} air ${air}/360 rock ${rock} onGround ${p.onGround}`);
const q = newPlayer(p.x, p.y, p.z);
air = 0; min = q.y;
for (let i = 0; i < 120; i++) { simulate(q, { down: 1, fx: 1, fz: 0 }, 1 / 60, cellAt, { minY: -64 }); if (!q.onGround) air++; min = Math.min(min, q.y); }
console.log(`shift+walk 2s: x ${q.x.toFixed(2)} feet ${q.y.toFixed(2)} min ${min.toFixed(2)} air ${air}/120 onGround ${q.onGround}`);
const r = newPlayer(p.x, p.y, p.z);
let maxRise = 0;
for (let i = 0; i < 60; i++) { simulate(r, { jump: i < 20 }, 1 / 60, cellAt, { minY: -64 }); maxRise = Math.max(maxRise, r.y - p.y); }
console.log(`jump: rise ${maxRise.toFixed(2)} feet ${r.y.toFixed(2)} onGround ${r.onGround}`);
