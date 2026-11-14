// What a probe is ALLOWED to call. Written after a probe invented `w.busy()` and burned a run.
const keys = Object.keys(window.__world).sort();
const want = ['grab', 'ownerAt', 'ghosts', 'markDepth', 'markSide', 'markerHits', 'pickStack', 'pickWorld',
  'setTimePlay', 'seekSec', 'seekRow', 'timeHitAt', 'timeStandAt', 'project', 'hoverAt', 'ghostHit',
  'ghostApply', 'ghostNote', 'time', 'bodyOn'];
console.log('APIKEYS ' + JSON.stringify({
  have: keys, missing: want.filter((k) => !keys.includes(k)),
  time: window.__world.time ? Object.keys(window.__world.time()).sort() : null,
}));
