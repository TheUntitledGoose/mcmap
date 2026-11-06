import { listDims } from '../server/world-dims.mjs';
const key = (s) => s.split('/').join('_').split(String.fromCharCode(92)).join('_');
for (const d of listDims('DarkRPG/world')) {
  console.log(JSON.stringify({ id: d.id, dir: d.dir, key: key(d.dir) }));
}
