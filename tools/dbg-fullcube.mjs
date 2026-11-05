import { ModelResolver, bakeApply } from '../server/model-resolve.mjs';
import { AssetIndex, defaultJars } from '../server/asset-index.mjs';
import { cubeArmCodes, fullCubeArm, boxFaceQuad } from '../shared/cube-path.mjs';
const idx = new AssetIndex(defaultJars('DarkRPG', undefined));
const r = new ModelResolver(idx);
const ids = (ids) => ids;
function show(name, props) {
  const applies = r.applies(name, props);
  const arms = [];
  for (const a of applies) {
    const baked = bakeApply(r, a.model, a, (id) => (idx.has(id, 'textures') ? 0 : 0));
    if (baked?.quads?.length) arms.push(baked.quads);
  }
  console.log(name, JSON.stringify(props), 'arms', arms.length,
    'cubeFast', arms.map((a) => !!cubeArmCodes(a)).join(','),
    'fullCube', arms.map((a) => fullCubeArm(a)).join(','),
    'quads', arms.map((a) => a.length).join(','));
}
for (const [n, p] of [
  ['minecraft:grass_block', { snowy: 'false' }],
  ['minecraft:dirt', {}],
  ['minecraft:stone', {}],
  ['minecraft:glass', {}],
  ['minecraft:sand', {}],
  ['minecraft:grass', {}],
  ['regions_unexplored:medium_grass', {}],
  ['minecraft:oak_leaves', { distance: '6', persistent: 'false', waterlogged: 'false' }],
  ['minecraft:oak_fence', { waterlogged: 'false' }],
  ['minecraft:water', { level: '0' }],
  ['minecraft:snow', { layers: '8' }],
  ['minecraft:bookshelf', {}],
  ['minecraft:grass_block', { snowy: 'true' }],
]) show(n, p);
idx.close();
