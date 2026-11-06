import fs from 'node:fs';
import { atlasStamp } from '../server/shell-pack.mjs';
const st = fs.statSync('build/assets/atlas.json');
const n = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8')).states.length;
console.log('atlas mtime', new Date(st.mtimeMs).toISOString(), 'states', n, 'stamp', atlasStamp(st, n));
const b = fs.readFileSync('build/shells/overview-DarkRPG_world_dimensions_spellbladenext_glassocean_region.bin');
console.log('file', b.length, 'magic', JSON.stringify(b.subarray(0, 8).toString('ascii')), 'stamp', b.readUInt32LE(12), 'w/h', b.readUInt16LE(24), b.readUInt16LE(26), 'cell', b.readUInt16LE(10));
const { WorldService } = await import('../server/world-service.mjs');
import { classifyStates } from '../shared/cube-path.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map(s => s.k)), 'build/cache',
  { isCubeState: (id) => cls.cube[id - 1] === 1, packDir: 'build/shells', stamp: atlasStamp(st, n) });
const ov = svc.overviewBytes('spellbladenext:glassocean');
console.log('overviewBytes ->', ov && ov.length);
