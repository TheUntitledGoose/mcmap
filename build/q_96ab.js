// 9.6 A/B on one page load: counters for the two things the mesh key is supposed to buy.
// Run once per URL setting; the legs are a 400-block pan out and back at a 1.2 km pull-back, which is
// the framing that used to cost 60-83 detail builds per leg with `reused 0`.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => {
    const s = w.state;
    return { b: s.meshBuilds, same: s.meshUnchanged, re: s.meshReused, un: s.meshUnsettled,
      parked: s.meshCachedChunks, ghost: s.meshBytesGhost,
      parkMB: s.meshCacheMB, chunks: s.chunks, MB: +(s.bytesHeld / 1048576).toFixed(1),
      fps: +s.fps.toFixed(1), detailR: s.detailRadius, payloadR: s.payloadRadius };
  };
  const pan = async (dx, dz) => {
    const [x0, y0, z0] = w.state.target;
    for (let i = 1; i <= 8; i++) { w.go(x0 + dx * i / 8, y0, z0 + dz * i / 8); await sleep(180); w.tick(8); }
    await sleep(1200); w.tick(15);
  };
  const leg = async (label, dx, dz) => {
    const a = snap();
    await pan(dx, dz);
    const b = snap();
    await pan(-dx, -dz);
    const c = snap();
    return { label, detailR: c.detailR, payloadR: c.payloadR,
      out: `builds ${b.b - a.b} same ${b.same - a.same} reused ${b.re - a.re} unset ${b.un - a.un}`,
      back: `builds ${c.b - b.b} same ${c.same - b.same} reused ${c.re - b.re} unset ${c.un - b.un}`,
      hold: `chunks ${c.chunks} voxMB ${c.MB} parked ${c.parked} ghost ${c.ghost} parkMB ${c.parkMB} fps ${c.fps}` };
  };
  await sleep(1500); w.tick(15);
  const settings = { meshKey: w.settings.meshKey, bytesKeep: w.settings.bytesKeep };
  const out = [{ label: `settings ${JSON.stringify(settings)}`, out: '', back: '', hold: '',
    detailR: 0, payloadR: 0 }];
  out.push(await leg('+400x / back', 400, 0));
  out.push(await leg('+400z / back', 0, 400));
  return out;
})();
