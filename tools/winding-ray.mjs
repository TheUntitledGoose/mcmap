// Does three keep or cull a CANON_RING-ordered quad, seen from outside? three's raycaster honours
// material.side, so this needs no GL: FrontSide hits only if the triangle is front-facing.
import * as THREE from 'three';
import { CANON_RING } from '../shared/cube-path.mjs';
const FACES = ['down', 'up', 'north', 'south', 'west', 'east'];
const OUT = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
for (let f = 0; f < 6; f++) {
  const ring = CANON_RING[f].map((s) => s.split(',').map(Number));
  const g = new THREE.BufferGeometry();
  const a = ring.map(([x, y, z]) => [x / 16, y / 16, z / 16]);
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a[0], ...a[1], ...a[2], ...a[0], ...a[2], ...a[3]], 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  m.updateMatrixWorld(true);
  const o = a.map((p) => p.map((v) => v + 0.5)).reduce((s, v) => s.map((x, i) => x + v[i]), [0, 0, 0]).map((v) => v / 4);
  const from = o.map((v, i) => v + OUT[f][i] * 2);
  const rc = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...OUT[f].map((v) => -v)), 0, 10);
  const hitF = rc.intersectObject(m, false).length;
  m.material.side = THREE.BackSide;
  const hitB = rc.intersectObject(m, false).length;
  console.log(FACES[f], 'outward', OUT[f].join(','), 'frontSideHit', hitF, 'backSideHit', hitB);
}
