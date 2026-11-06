// How much does the payload ring cost a pan? Two legs, counters only; run once per ?payloadlead value.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => {
    const s = w.state;
    return { builds: s.meshBuilds, same: s.meshUnchanged, reused: s.meshReused,
      defer: s.meshDeferred, unsettled: s.meshUnsettled,
      dropped: s.meshCacheDropped, parked: s.meshCachedChunks, chunks: s.chunks,
      bytes: +(s.bytesHeld / 1048576).toFixed(1), meshed: s.meshed,
      detailR: s.detailRadius, payloadR: s.payloadRadius, inflight: s.inflight };
  };
  const pan = async (dx, dz, steps) => {
    const [x0, y0, z0] = w.state.target;
    for (let i = 1; i <= steps; i++) { w.go(x0 + dx * i / steps, y0, z0 + dz * i / steps); await sleep(180); w.tick(8); }
    await sleep(1200); w.tick(15);
  };
  const leg = async (label, dx, dz) => {
    const a = snap();
    await pan(dx, dz, 8);
    const b = snap();
    await pan(-dx, -dz, 8);
    const c = snap();
    return { label, detailR: c.detailR, payloadR: c.payloadR,
      out: `builds ${b.builds - a.builds} fetch ${b.chunks - a.chunks} unset ${b.unsettled - a.unsettled} defer ${b.defer - a.defer} reused ${b.reused - a.reused}`,
      back: `builds ${c.builds - b.builds} fetch ${c.chunks - b.chunks} unset ${c.unsettled - b.unsettled} defer ${c.defer - b.defer} reused ${c.reused - b.reused}`,
      held: `chunks ${c.chunks} MB ${c.bytes} parked ${c.parked}` };
  };
  await sleep(1500); w.tick(15);
  const out = [];
  out.push(await leg('+400x / back', 400, 0));
  out.push(await leg('+400z / back', 0, 400));
  return out;
})();
