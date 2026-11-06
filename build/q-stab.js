(() => {
  // Orbit / tilt stability, the two reports: "the largest LOD flashes when I orbit" and "the far lods
  // clip when I tilt". Across an orbit every counter must be identical (nothing re-meshed), and after
  // tilting toward eye level a ray down the upper half of the frame must still land on world rather
  // than on the far plane.
  const snap = () => {
    const q = __world.state, o = __world.ovDiag();
    return {
      ch: q.chunks, shP: q.shellPatches, shV: q.shellVerts, shH: q.shellHeld,
      ovC: q.ovCells, ovV: q.ovVerts, ovS: q.ovSkipped, ovB: q.ovBands,
      tiers: q.shellCells.join("/"), sigs: o.bandSig.join(' '), near: q.near, far: q.far, err: q.frameError,
    };
  };
  const up = () => [150, 260, 400].map((y) => {
    const h = __world.pickStack(640, y, 1)[0];
    return h ? `${h.drawn}@${Math.round(Math.hypot(h.point[0], h.point[2]))}m` : 'SKY';
  });
  const line = (tag) => `${tag} ${JSON.stringify({ up: up(), ...snap() })}`;
  const out = [line('before')];
  __world.orbit(__world.axes().yaw + 0.7, null, null);
  __world.tick(40);
  out.push(line('orbit'));
  __world.orbit(null, 0.12, null);           // near eye level: where the far plane used to bite
  __world.tick(40);
  out.push(line('tilt'));
  return 'LOD7 ' + out.join(' | ');
})()
