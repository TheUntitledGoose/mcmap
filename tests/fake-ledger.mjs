// A stand-in for the exported log, shared by the tests that bake packs.
//
// The log is only ever read through accessor functions, so a test log can be built the same way - but
// it has to intern object ids into a Map the way `readLedger` does, because the pack writer resolves a
// row's block *name* through `L.objects`. A fake that handed back strings directly would make the bake
// look simpler than it is, and the timeline's name column is exactly the contract that would hide.
//
// Row shape: [worldId, x, y, z, actionId, playerId, timeMs, objectName?, oldObjectName?, sourceName?]
//
// The source (the CAUSE: 'player', 'creeper', 'fluid', ...) is interned into its own Map for the same
// reason object ids are: the timeline resolves a row's cause through `L.sources`, and a fake that handed
// back strings would let a pack writer that never looks the id up pass the test.
export const fakeLog = (rows) => {
  const R = rows.map(([worldId, x, y, z, actionId, playerId, timeMs, obj = '', old = '', src = '']) =>
    ({ worldId, x, y, z, actionId, playerId, timeMs, obj, old, src }));
  const objects = new Map();
  const byName = new Map();
  const oid = (s) => {
    if (!s) return 0;
    let k = byName.get(s);
    if (k === undefined) { k = objects.size + 1; objects.set(k, { id: s }); byName.set(s, k); }
    return k;
  };
  const sources = new Map();
  const srcByName = new Map();
  const sid = (s) => {
    if (!s) return 0;
    let k = srcByName.get(s);
    if (k === undefined) { k = sources.size + 1; sources.set(k, { id: s }); srcByName.set(s, k); }
    return k;
  };
  for (const r of R) { r.objId = oid(r.obj); r.oldId = oid(r.old); r.srcId = sid(r.src); }
  return {
    count: R.length,
    objects,
    sources,
    worldId: (i) => R[i].worldId,
    x: (i) => R[i].x,
    y: (i) => R[i].y,
    z: (i) => R[i].z,
    actionId: (i) => R[i].actionId,
    playerId: (i) => R[i].playerId,
    timeMs: (i) => R[i].timeMs,
    objectId: (i) => R[i].objId,
    oldObjectId: (i) => R[i].oldId,
    sourceId: (i) => R[i].srcId,
  };
};
